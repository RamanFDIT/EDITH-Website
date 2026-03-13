import 'dotenv/config';

import express from 'express';
import { agentExecutor, streamWithSemanticRouting } from './agent.js';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { transcribeAudio, generateSpeech } from './audioTool.js';
import { firebaseAuth } from './store.js';
import { loadUserTokensIntoEnv } from './envConfig.js';
import {
  buildAuthUrl, consumeOAuthState, exchangeCodeForTokens,
  storeTokens, discoverJiraCloudId, populateEnvFromOAuth,
} from './oauthService.js';
import { getAllConnectionStatus, deleteUserTokens, deleteAllUserTokens } from './store.js';

const app = express();
const port = process.env.PORT || 3001;

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// --- CONFIG: Multer (File Uploads) ---
const uploadDir = 'temp';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `voice-${Date.now()}.webm`)
});
const upload = multer({ storage: storage });

// --- Middlewares ---
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: [FRONTEND_URL, 'http://localhost:5173', 'http://localhost:3001'], credentials: true }));
app.use('/temp', express.static('temp'));

// --- Firebase Auth Middleware ---
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await firebaseAuth.verifyIdToken(idToken);
    req.userId = decodedToken.uid;
    next();
  } catch (err) {
    console.error('[Auth] Token verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// =============================================================================
// OAuth Routes
// =============================================================================

// Start OAuth flow — returns the authorization URL
app.get('/api/oauth/:provider/start', authMiddleware, (req, res) => {
  try {
    const { provider } = req.params;
    const returnUrl = req.query.returnUrl || `${FRONTEND_URL}/settings`;

    const { authUrl } = buildAuthUrl(provider, req.userId, returnUrl);
    res.json({ authUrl });
  } catch (err) {
    console.error(`[OAuth] Start failed:`, err.message);
    res.status(400).json({ error: err.message });
  }
});

// OAuth callback — exchanges code for tokens, redirects to frontend
app.get('/api/oauth/:provider/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`${FRONTEND_URL}/settings?oauth_error=${encodeURIComponent(error)}`);
    }

    const flowData = consumeOAuthState(state);
    if (!flowData) {
      return res.redirect(`${FRONTEND_URL}/settings?oauth_error=invalid_state`);
    }

    const { provider, userId, returnUrl } = flowData;
    const tokenData = await exchangeCodeForTokens(provider, code);

    if (provider === 'jira') {
      const jiraInfo = await discoverJiraCloudId(tokenData.access_token);
      tokenData.cloud_id = jiraInfo.cloud_id;
      tokenData.cloud_url = jiraInfo.cloud_url;
    }

    await storeTokens(userId, provider, tokenData);
    console.log(`[OAuth] Successfully connected ${provider} for user=${userId}`);

    res.redirect(`${returnUrl || FRONTEND_URL + '/settings'}?oauth_success=${provider}`);
  } catch (err) {
    console.error(`[OAuth] Callback failed:`, err.message);
    res.redirect(`${FRONTEND_URL}/settings?oauth_error=${encodeURIComponent(err.message)}`);
  }
});

// Get connection status for all providers
app.get('/api/oauth/status', authMiddleware, async (req, res) => {
  try {
    const status = await getAllConnectionStatus(req.userId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect a specific provider
app.post('/api/oauth/:provider/disconnect', authMiddleware, async (req, res) => {
  try {
    const { provider } = req.params;
    await deleteUserTokens(req.userId, provider);
    res.json({ success: true, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logout — clear all OAuth tokens
app.post('/api/oauth/logout', authMiddleware, async (req, res) => {
  try {
    await deleteAllUserTokens(req.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Chat API (SSE Streaming)
// =============================================================================

app.post('/api/ask', authMiddleware, async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    console.log(`[Server] User=${req.userId} asked: ${question}`);

    // Load this user's OAuth tokens into process.env for tool compatibility
    await loadUserTokensIntoEnv(req.userId);

    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = streamWithSemanticRouting(question, req.userId);

    let sentenceBuffer = "";

    for await (const event of stream) {
        const eventType = event.event;

        if (eventType === "on_chat_model_stream") {
            const content = event.data?.chunk?.content;
            if (content) {
                res.write(`data: ${JSON.stringify({ type: "token", content })}\n\n`);

                sentenceBuffer += content;
                if (/[.?!]\s$/.test(sentenceBuffer) && sentenceBuffer.length > 5) {
                    generateAudioChunk(sentenceBuffer.trim());
                    sentenceBuffer = "";
                }
            }
        } else if (eventType === "on_tool_start") {
             res.write(`data: ${JSON.stringify({ type: "tool_start", name: event.name, input: event.data?.input })}\n\n`);
        } else if (eventType === "on_tool_end") {
             res.write(`data: ${JSON.stringify({ type: "tool_end", name: event.name, output: event.data?.output })}\n\n`);
        }
    }

    if (sentenceBuffer.trim().length > 0) {
        generateAudioChunk(sentenceBuffer.trim());
    }

    async function generateAudioChunk(text) {
        try {
             const audioResult = await generateSpeech({ text });
             if (typeof audioResult === 'string') {
                  try {
                    const parsed = JSON.parse(audioResult);
                    if (parsed.fallback === 'web-speech-api') {
                      res.write(`data: ${JSON.stringify({ type: "tts_fallback", text: parsed.text })}\n\n`);
                      return;
                    }
                  } catch (e) {
                    // Not JSON — treat as file path
                  }
                  if (audioResult && !audioResult.startsWith("Error")) {
                      const audioUrl = '/temp/' + path.basename(audioResult);
                      res.write(`data: ${JSON.stringify({ type: "audio", url: audioUrl })}\n\n`);
                  }
             }
        } catch (e) { console.error("TTS Chunk Error:", e); }
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();

  } catch (error) {
    console.error("[Server] Error processing request:", error);
    res.write(`data: ${JSON.stringify({ type: "error", content: error.message })}\n\n`);
    res.end();
  }
});

// =============================================================================
// Voice API
// =============================================================================

app.post('/api/voice', authMiddleware, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) throw new Error("No audio file uploaded.");

    const audioPath = req.file.path;

    // Load this user's tokens
    await loadUserTokensIntoEnv(req.userId);

    let userText;
    try {
        userText = await transcribeAudio({ filePath: audioPath });
    } finally {
        fs.unlink(audioPath, (err) => {
            if (err) console.error(`[Server] Failed to delete voice file: ${err.message}`);
        });
    }

    if (typeof userText === 'string' && userText.startsWith("Error")) throw new Error(userText);

    console.log(`[Voice] User=${req.userId} said: "${userText}"`);

    const result = await agentExecutor.invoke(
      { input: userText },
      { configurable: { sessionId: `voice-${req.userId}` } }
    );

    const assistantText = result.output;

    const outputAudioResult = await generateSpeech({ text: assistantText });

    let audioUrl = null;
    let ttsFallback = false;

    if (typeof outputAudioResult === 'string') {
        try {
            const parsed = JSON.parse(outputAudioResult);
            if (parsed.fallback === 'web-speech-api') {
                ttsFallback = true;
            }
        } catch (e) {
            if (outputAudioResult && !outputAudioResult.startsWith("Error")) {
                audioUrl = '/temp/' + path.basename(outputAudioResult);
            }
        }
    }

    res.json({
        userText,
        answer: assistantText,
        audioUrl,
        ttsFallback,
    });

  } catch (error) {
    console.error("[Voice] Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- Start Server ---
const server = app.listen(port, () => {
  console.log(`Server is listening at http://localhost:${port}`);
});

// Keep-alive to prevent premature process exit
setInterval(() => {}, 30000);

// Global Error Handlers
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
});

process.on('exit', (code) => {
    console.log(`[Server] Process exited with code: ${code}`);
});

process.on('SIGINT', async () => {
    console.log('[Server] Shutting down...');
    process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
