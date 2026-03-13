import { auth } from '../firebase.js';

const API_BASE = import.meta.env.VITE_API_URL || '';

async function getAuthHeaders() {
  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated');
  const token = await user.getIdToken();
  return { 'Authorization': `Bearer ${token}` };
}

export async function oauthConnect(provider) {
  const headers = await getAuthHeaders();
  const res = await fetch(`${API_BASE}/api/oauth/${provider}/start`, { headers });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[API] oauthConnect failed (${res.status}):`, text);
    throw new Error(`OAuth start failed: ${res.status}`);
  }
  const data = await res.json();
  if (data.authUrl) {
    window.location.href = data.authUrl;
  } else {
    throw new Error(data.error || 'Failed to start OAuth flow');
  }
}

export async function oauthDisconnect(provider) {
  const headers = await getAuthHeaders();
  const res = await fetch(`${API_BASE}/api/oauth/${provider}/disconnect`, {
    method: 'POST',
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[API] oauthDisconnect failed (${res.status}):`, text);
    throw new Error(`Disconnect failed: ${res.status}`);
  }
  return res.json();
}

export async function oauthStatus() {
  const headers = await getAuthHeaders();
  const res = await fetch(`${API_BASE}/api/oauth/status`, { headers });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[API] oauthStatus failed (${res.status}):`, text);
    return { google: { connected: false }, github: { connected: false }, slack: { connected: false }, figma: { connected: false }, jira: { connected: false } };
  }
  return res.json();
}

export async function oauthLogout() {
  const headers = await getAuthHeaders();
  const res = await fetch(`${API_BASE}/api/oauth/logout`, {
    method: 'POST',
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[API] oauthLogout failed (${res.status}):`, text);
    throw new Error(`Logout failed: ${res.status}`);
  }
  return res.json();
}

export async function askQuestion(question) {
  const headers = await getAuthHeaders();
  return fetch(`${API_BASE}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ question }),
  });
}

export { getAuthHeaders, API_BASE };
