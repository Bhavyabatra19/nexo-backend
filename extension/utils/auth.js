/**
 * Auth helpers — shared between background.js and popup.js
 *
 * folkX-style flow: the extension reuses the user's existing Nexo web-app session.
 * After the user signs in at the frontend, the backend sets httpOnly cookies on
 * its own domain. The extension then attaches those cookies to fetches via
 * `credentials: 'include'`. No tokens are ever pasted or stored by the extension.
 */

const PROD_API = 'https://187.127.129.125.nip.io';
const DEV_API  = 'http://localhost:3000';

export const FRONTEND_URL = 'https://nexo-frontend-indol.vercel.app';

export async function getApiBase() {
  const { devMode } = await chrome.storage.local.get('devMode');
  return devMode ? DEV_API : PROD_API;
}

export async function authedFetch(path, options = {}) {
  const apiBase = await getApiBase();
  const url = path.startsWith('http') ? path : `${apiBase}${path}`;
  return fetch(url, { ...options, credentials: 'include' });
}

/**
 * Check whether the browser currently holds a Nexo access-token cookie for the
 * backend domain. We don't try to verify it here — the server is the authority.
 */
export async function hasSessionCookie() {
  const apiBase = await getApiBase();
  try {
    const cookie = await chrome.cookies.get({ url: apiBase, name: 'accessToken' });
    return !!cookie?.value;
  } catch {
    return false;
  }
}

/**
 * Fetch /api/extension/status — also doubles as a liveness check for the session.
 * Returns { stats } on success, null on failure.
 */
export async function fetchStatus() {
  try {
    const res = await authedFetch('/api/extension/status');
    if (!res.ok) return null;
    const data = await res.json();
    return data.success ? data.stats : null;
  } catch {
    return null;
  }
}

export async function isAuthenticated() {
  return hasSessionCookie();
}

/**
 * Watch for the access-token cookie being set or removed on the backend domain.
 * Fires `callback(present: boolean)` on every relevant change.
 */
export async function onSessionCookieChange(callback) {
  const apiBase = await getApiBase();
  const host = new URL(apiBase).host;
  chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
    if (cookie.name !== 'accessToken') return;
    if (!cookie.domain.endsWith(host)) return;
    callback(!removed);
  });
}
