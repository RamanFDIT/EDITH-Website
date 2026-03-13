/**
 * store.js — Firebase Firestore-backed token storage for E.D.I.T.H.
 * Replaces electron-store with Firestore for multi-user web support.
 */

import admin from 'firebase-admin';
import dotenv from 'dotenv';

// Ensure .env is loaded before reading FIREBASE_SERVICE_ACCOUNT
dotenv.config();

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : undefined;

  admin.initializeApp(
    serviceAccount
      ? { credential: admin.credential.cert(serviceAccount) }
      : { credential: admin.credential.applicationDefault() }
  );
}

const db = admin.firestore();
export const firebaseAuth = admin.auth();

/**
 * Get stored OAuth tokens for a specific user and provider
 */
export async function getUserTokens(userId, provider) {
  const doc = await db.collection('users').doc(userId)
    .collection('oauth_tokens').doc(provider).get();
  if (!doc.exists) return null;
  return doc.data();
}

/**
 * Store OAuth tokens for a specific user and provider
 */
export async function setUserTokens(userId, provider, tokenData) {
  await db.collection('users').doc(userId)
    .collection('oauth_tokens').doc(provider).set(tokenData, { merge: true });
  console.log(`[Store] Saved tokens for user=${userId}, provider=${provider}`);
  return tokenData;
}

/**
 * Delete OAuth tokens for a specific user and provider
 */
export async function deleteUserTokens(userId, provider) {
  await db.collection('users').doc(userId)
    .collection('oauth_tokens').doc(provider).delete();
  console.log(`[Store] Deleted tokens for user=${userId}, provider=${provider}`);
}

/**
 * Get connection status for all providers for a user
 */
export async function getAllConnectionStatus(userId) {
  const providers = ['google', 'github', 'slack', 'figma', 'jira'];
  const status = {};

  for (const provider of providers) {
    const tokens = await getUserTokens(userId, provider);
    status[provider] = {
      connected: !!tokens?.access_token,
      expired: tokens?.expires_at ? Date.now() > (tokens.expires_at - 5 * 60 * 1000) : true,
      hasRefreshToken: !!tokens?.refresh_token,
    };
  }

  return status;
}

/**
 * Delete all OAuth tokens for a user (logout from all providers)
 */
export async function deleteAllUserTokens(userId) {
  const providers = ['google', 'github', 'slack', 'figma', 'jira'];
  for (const provider of providers) {
    await deleteUserTokens(userId, provider).catch(() => {});
  }
  console.log(`[Store] Cleared all tokens for user=${userId}`);
}

export default { getUserTokens, setUserTokens, deleteUserTokens, getAllConnectionStatus, deleteAllUserTokens };
