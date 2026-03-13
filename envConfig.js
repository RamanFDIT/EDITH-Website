import { getUserTokens } from './store.js';

// Note: dotenv is loaded in server.js via `import 'dotenv/config'` (must be first import)

/**
 * Load a specific user's OAuth tokens from Firestore into process.env.
 * Called per-request so each user gets their own token context.
 */
export async function loadUserTokensIntoEnv(userId) {
  if (!userId) return;

  const oauthGoogle = await getUserTokens(userId, 'google');
  if (oauthGoogle?.access_token) {
    if (oauthGoogle.refresh_token) {
      process.env.GOOGLE_REFRESH_TOKEN = oauthGoogle.refresh_token;
    }
    process.env.GOOGLE_OAUTH_ACCESS_TOKEN = oauthGoogle.access_token;
    const oauthClientId = process.env.OAUTH_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
    const oauthClientSecret = process.env.OAUTH_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
    if (oauthClientId) process.env.GOOGLE_CLIENT_ID = oauthClientId;
    if (oauthClientSecret) process.env.GOOGLE_CLIENT_SECRET = oauthClientSecret;
  }

  const oauthGithub = await getUserTokens(userId, 'github');
  if (oauthGithub?.access_token) {
    process.env.GITHUB_TOKEN = oauthGithub.access_token;
    process.env.GITHUB_PAT = oauthGithub.access_token;
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = oauthGithub.access_token;
  }

  const oauthSlack = await getUserTokens(userId, 'slack');
  if (oauthSlack?.access_token) {
    process.env.SLACK_BOT_TOKEN = oauthSlack.access_token;
  }

  const oauthFigma = await getUserTokens(userId, 'figma');
  if (oauthFigma?.access_token) {
    process.env.FIGMA_TOKEN = oauthFigma.access_token;
    process.env.FIGMA_API_KEY = oauthFigma.access_token;
  }

  const oauthJira = await getUserTokens(userId, 'jira');
  if (oauthJira?.access_token) {
    process.env.JIRA_API_TOKEN = oauthJira.access_token;
    process.env.JIRA_OAUTH_TOKEN = oauthJira.access_token;
    if (oauthJira.cloud_url) {
      process.env.JIRA_DOMAIN = oauthJira.cloud_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }
    if (oauthJira.cloud_id) {
      process.env.JIRA_CLOUD_ID = oauthJira.cloud_id;
    }
  }
}

console.log('[Config] Loaded server environment from .env');
