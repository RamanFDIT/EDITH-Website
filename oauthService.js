/**
 * oauthService.js — Web-based OAuth2.0 Service for E.D.I.T.H.
 *
 * Handles OAuth flows via standard web redirects (no Electron).
 * Tokens are stored in Firebase Firestore per-user.
 *
 * Supported providers:
 *   - Google (Calendar + Gemini API via Google Cloud OAuth)
 *   - GitHub
 *   - Slack
 *   - Figma
 *   - Atlassian/Jira (OAuth 2.0 3LO)
 */

import crypto from 'crypto';
import fetch from 'node-fetch';
import { getUserTokens, setUserTokens, deleteUserTokens } from './store.js';

// In-memory store for OAuth state parameters (maps state -> { provider, userId, returnUrl })
const pendingOAuthFlows = new Map();

// =============================================================================
// PROVIDER CONFIGURATIONS
// =============================================================================

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

function getOAuthProviders() {
  return {
    google: {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: process.env.OAUTH_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
      scopes: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/generative-language.retriever',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
      ],
      redirectUri: `${BASE_URL}/api/oauth/google/callback`,
      extraParams: { access_type: 'offline', prompt: 'consent' },
    },

    github: {
      authUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      clientId: process.env.OAUTH_GITHUB_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_GITHUB_CLIENT_SECRET || '',
      scopes: ['repo', 'read:user', 'read:org'],
      redirectUri: `${BASE_URL}/api/oauth/github/callback`,
      extraParams: {},
    },

    slack: {
      authUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      clientId: process.env.OAUTH_SLACK_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_SLACK_CLIENT_SECRET || '',
      scopes: ['chat:write', 'channels:read', 'channels:join', 'chat:write.customize'],
      redirectUri: process.env.OAUTH_SLACK_REDIRECT_URI || `${BASE_URL}/api/oauth/slack/callback`,
      extraParams: {},
      isBotScope: true,
    },

    figma: {
      authUrl: 'https://www.figma.com/oauth',
      tokenUrl: 'https://api.figma.com/v1/oauth/token',
      clientId: process.env.OAUTH_FIGMA_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_FIGMA_CLIENT_SECRET || '',
      scopes: ['file_content:read', 'file_comments:read', 'file_comments:write'],
      redirectUri: `${BASE_URL}/api/oauth/figma/callback`,
      extraParams: { response_type: 'code' },
    },

    jira: {
      authUrl: 'https://auth.atlassian.com/authorize',
      tokenUrl: 'https://auth.atlassian.com/oauth/token',
      clientId: process.env.OAUTH_JIRA_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_JIRA_CLIENT_SECRET || '',
      scopes: [
        'read:jira-work', 'write:jira-work', 'read:jira-user',
        'manage:jira-project', 'manage:jira-configuration',
        'offline_access'
      ],
      redirectUri: `${BASE_URL}/api/oauth/jira/callback`,
      extraParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    },
  };
}

// =============================================================================
// BUILD AUTH URL
// =============================================================================

/**
 * Build the authorization URL and store the state for verification.
 * @param {string} provider
 * @param {string} userId - Firebase user ID
 * @param {string} returnUrl - Frontend URL to redirect back to after OAuth
 * @returns {{ authUrl: string, state: string }}
 */
export function buildAuthUrl(provider, userId, returnUrl) {
  const config = getOAuthProviders()[provider];

  if (!config) throw new Error(`Unknown provider: ${provider}`);
  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      `OAuth not configured for "${provider}". ` +
      `Set OAUTH_${provider.toUpperCase()}_CLIENT_ID and OAUTH_${provider.toUpperCase()}_CLIENT_SECRET.`
    );
  }

  const state = crypto.randomBytes(16).toString('hex');

  // Store state for verification in the callback
  pendingOAuthFlows.set(state, { provider, userId, returnUrl });
  // Auto-cleanup after 10 minutes
  setTimeout(() => pendingOAuthFlows.delete(state), 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    state: state,
    ...config.extraParams,
  });

  if (provider === 'slack') {
    params.set('scope', config.scopes.join(','));
  } else if (provider === 'figma') {
    if (config.scopes.length > 0) {
      const scopeStr = config.scopes.join(',');
      return { authUrl: `${config.authUrl}?${params.toString()}&scope=${scopeStr}`, state };
    }
  } else {
    params.set('scope', config.scopes.join(' '));
  }

  return { authUrl: `${config.authUrl}?${params.toString()}`, state };
}

/**
 * Verify and consume a pending OAuth state.
 * @returns {{ provider: string, userId: string, returnUrl: string } | null}
 */
export function consumeOAuthState(state) {
  const data = pendingOAuthFlows.get(state);
  if (data) pendingOAuthFlows.delete(state);
  return data || null;
}

// =============================================================================
// TOKEN EXCHANGE
// =============================================================================

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(provider, code) {
  const config = getOAuthProviders()[provider];

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Token exchange failed for ${provider}: ${errText}`);
  }

  const data = await response.json();

  // Slack nests the token differently
  if (provider === 'slack' && data.ok) {
    return {
      access_token: data.access_token,
      token_type: 'Bearer',
      scope: data.scope,
      team: data.team,
      bot_user_id: data.bot_user_id,
    };
  }

  return data;
}

// =============================================================================
// TOKEN STORAGE (Firestore-backed)
// =============================================================================

/**
 * Store tokens for a user+provider in Firestore
 */
export async function storeTokens(userId, provider, tokenData) {
  const existing = await getUserTokens(userId, provider);

  const toStore = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || existing?.refresh_token || null,
    token_type: tokenData.token_type || 'Bearer',
    scope: tokenData.scope || '',
    expires_at: tokenData.expires_in
      ? Date.now() + tokenData.expires_in * 1000
      : null,
  };

  if (tokenData.cloud_id) toStore.cloud_id = tokenData.cloud_id;
  if (tokenData.cloud_url) toStore.cloud_url = tokenData.cloud_url;
  if (tokenData.team) toStore.team = tokenData.team;
  if (tokenData.bot_user_id) toStore.bot_user_id = tokenData.bot_user_id;

  await setUserTokens(userId, provider, toStore);
  return toStore;
}

// =============================================================================
// TOKEN REFRESH
// =============================================================================

/**
 * Refresh an expired access token using the stored refresh token.
 */
export async function refreshAccessToken(userId, provider) {
  const config = getOAuthProviders()[provider];
  const tokens = await getUserTokens(userId, provider);

  if (!tokens?.refresh_token) {
    throw new Error(`No refresh token stored for "${provider}". User must re-authenticate.`);
  }

  console.log(`[OAuth] Refreshing token for user=${userId}, provider="${provider}"...`);

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: body.toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Token refresh failed for ${provider}: ${err}`);
  }

  const data = await response.json();
  const stored = await storeTokens(userId, provider, data);
  console.log(`[OAuth] Token refreshed for user=${userId}, provider="${provider}"`);
  return stored.access_token;
}

/**
 * Get a valid access token — refresh automatically if expired.
 */
export async function getValidToken(userId, provider) {
  const tokens = await getUserTokens(userId, provider);
  if (!tokens) return null;

  const isExpired = tokens.expires_at ? Date.now() > (tokens.expires_at - 5 * 60 * 1000) : false;

  if (isExpired && tokens.refresh_token) {
    try {
      return await refreshAccessToken(userId, provider);
    } catch (err) {
      console.error(`[OAuth] Auto-refresh failed for "${provider}":`, err.message);
      return null;
    }
  }

  return tokens.access_token;
}

// =============================================================================
// JIRA: DISCOVER CLOUD ID
// =============================================================================

export async function discoverJiraCloudId(accessToken) {
  const response = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
  });

  if (!response.ok) throw new Error('Failed to fetch Jira accessible resources');

  const sites = await response.json();
  if (sites.length === 0) throw new Error('No Jira sites found for this account');

  return { cloud_id: sites[0].id, cloud_url: sites[0].url, site_name: sites[0].name };
}

// =============================================================================
// ENV POPULATION (bridge OAuth tokens → process.env for tool compatibility)
// =============================================================================

export function populateEnvFromOAuth(provider, tokens) {
  if (!tokens?.access_token) return;

  switch (provider) {
    case 'google': {
      process.env.GOOGLE_REFRESH_TOKEN = tokens.refresh_token || '';
      process.env.GOOGLE_OAUTH_ACCESS_TOKEN = tokens.access_token || '';
      const googleCfg = getOAuthProviders().google;
      if (googleCfg.clientId) process.env.GOOGLE_CLIENT_ID = googleCfg.clientId;
      if (googleCfg.clientSecret) process.env.GOOGLE_CLIENT_SECRET = googleCfg.clientSecret;
      process.env.GOOGLE_VERTEX_AI_OAUTH = 'true';
      break;
    }
    case 'github':
      process.env.GITHUB_TOKEN = tokens.access_token;
      process.env.GITHUB_PAT = tokens.access_token;
      process.env.GITHUB_PERSONAL_ACCESS_TOKEN = tokens.access_token;
      break;
    case 'slack':
      process.env.SLACK_BOT_TOKEN = tokens.access_token;
      break;
    case 'figma':
      process.env.FIGMA_TOKEN = tokens.access_token;
      process.env.FIGMA_API_KEY = tokens.access_token;
      break;
    case 'jira':
      process.env.JIRA_API_TOKEN = tokens.access_token;
      process.env.JIRA_OAUTH_TOKEN = tokens.access_token;
      if (tokens.cloud_url) {
        process.env.JIRA_DOMAIN = tokens.cloud_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
      }
      if (tokens.cloud_id) {
        process.env.JIRA_CLOUD_ID = tokens.cloud_id;
      }
      break;
  }
}
