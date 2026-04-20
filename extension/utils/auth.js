/**
 * Auth helpers — shared between background.js and popup.js
 *
 * Token flow:
 *   User visits nexo.in/settings → "Get Extension Token" → copies JWT
 *   Pastes into extension popup once → stored in chrome.storage.local
 */

const PROD_API = 'https://api.nexo.in';
const DEV_API  = 'http://localhost:3000';

export async function getApiBase() {
  const { devMode } = await chrome.storage.local.get('devMode');
  return devMode ? DEV_API : PROD_API;
}

export async function getToken() {
  const { nexoToken } = await chrome.storage.local.get('nexoToken');
  return nexoToken || null;
}

export async function setToken(token) {
  await chrome.storage.local.set({ nexoToken: token });
}

export async function clearToken() {
  await chrome.storage.local.remove(['nexoToken', 'syncState']);
}

export async function isAuthenticated() {
  const token = await getToken();
  return !!token;
}

/**
 * Validate the token against the backend.
 * Returns user info on success, null on failure.
 */
export async function validateToken(token) {
  const apiBase = await getApiBase();
  try {
    const res = await fetch(`${apiBase}/api/extension/status`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.success ? data.stats : null;
  } catch {
    return null;
  }
}
