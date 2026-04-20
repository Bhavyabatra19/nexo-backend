/**
 * Nexo Chrome Extension — Background Service Worker
 *
 * Responsibilities:
 * 1. 3-day alarm → auto-sync LinkedIn connections via Voyager API
 * 2. Receive profile captures from content_script → forward to Nexo API
 * 3. Badge management (syncing / done / error states)
 */

import { getApiBase, getToken, isAuthenticated } from './utils/auth.js';

const SYNC_ALARM     = 'nexo-linkedin-sync';
const SYNC_INTERVAL  = 60 * 24 * 3; // 3 days in minutes

// ── Lifecycle ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await scheduleSyncAlarm();
  console.log('[Nexo] Extension installed. Sync alarm set for every 3 days.');
});

chrome.runtime.onStartup.addListener(async () => {
  // Re-register alarm in case it was cleared (browsers clear alarms on update)
  await scheduleSyncAlarm();
});

async function scheduleSyncAlarm() {
  const existing = await chrome.alarms.get(SYNC_ALARM);
  if (!existing) {
    chrome.alarms.create(SYNC_ALARM, {
      delayInMinutes: 1,           // first sync 1 min after install
      periodInMinutes: SYNC_INTERVAL,
    });
  }
}

// ── Alarm Handler ──────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SYNC_ALARM) return;
  console.log('[Nexo] 3-day sync alarm fired');
  await runLinkedInSync({ source: 'alarm' });
});

// ── Message Handler (from content_script) ─────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PROFILE_CAPTURED') {
    handleProfileCapture(message.data, sender.tab?.id)
      .then(result => sendResponse({ success: true, result }))
      .catch(err  => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async response
  }

  if (message.type === 'SYNC_NOW') {
    runLinkedInSync({ source: 'manual' })
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_SYNC_STATE') {
    getSyncState().then(sendResponse);
    return true;
  }
});

// ── Core Sync ─────────────────────────────────────────────────────────────────

async function runLinkedInSync({ source }) {
  if (!(await isAuthenticated())) {
    console.log('[Nexo] Sync skipped: not authenticated');
    await setBadge('', '#666666');
    return;
  }

  const cookies = await getLinkedInCookies();
  if (!cookies.liAt) {
    console.log('[Nexo] Sync skipped: no LinkedIn session found — user must be logged in to LinkedIn');
    await notifyUser(
      'Nexo: LinkedIn sign-in needed',
      'Please open LinkedIn in your browser so Nexo can sync your network.'
    );
    await setSyncState({ status: 'needs_linkedin', lastAttempt: Date.now() });
    return;
  }

  await setSyncState({ status: 'syncing', startedAt: Date.now() });
  await setBadge('...', '#6366f1');

  try {
    const result = await postSyncRequest(cookies);
    await setSyncState({ status: 'done', lastSync: Date.now(), ...result });
    await setBadge('✓', '#22c55e');

    // Fade badge back to clear after 5s
    setTimeout(() => setBadge('', '#6366f1'), 5000);

    if (source === 'manual' || result.created > 0) {
      await notifyUser(
        'Nexo sync complete',
        `${result.imported} contacts synced${result.created ? `, ${result.created} new` : ''}.`
      );
    }
    console.log(`[Nexo] Sync done: ${JSON.stringify(result)}`);

  } catch (err) {
    console.error('[Nexo] Sync error:', err.message);
    await setSyncState({ status: 'error', error: err.message, lastAttempt: Date.now() });
    await setBadge('!', '#ef4444');
    setTimeout(() => setBadge('', '#6366f1'), 10000);
  }
}

async function postSyncRequest(cookies) {
  const apiBase = await getApiBase();
  const token   = await getToken();

  // Send cookies to Nexo backend which runs the Voyager pagination
  // We intentionally do NOT store cookies on backend — used in transit only
  const response = await fetch(`${apiBase}/api/linkedin/fetch-connections`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      li_at:     cookies.liAt,
      jsessionid: cookies.jsessionId,
    }),
  });

  if (!response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error(`Server error: ${response.status}`);
  }

  // Parse SSE stream — collect progress and final done/error event
  return parseSSEStream(response.body);
}

async function parseSSEStream(bodyStream) {
  const reader  = bodyStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6));

        if (event.type === 'progress') {
          // Relay progress to popup if it's open
          chrome.runtime.sendMessage({ type: 'SYNC_PROGRESS', ...event }).catch(() => {});
          await setBadge(`${Math.round((event.fetched / event.total) * 100)}`, '#6366f1');
        }

        if (event.type === 'done')  finalResult = event;
        if (event.type === 'error') throw new Error(event.message);
      } catch (e) {
        if (e.message && !e.message.startsWith('Unexpected token')) throw e;
      }
    }
  }

  return finalResult || { imported: 0 };
}

// ── Profile Capture (from content_script) ────────────────────────────────────

async function handleProfileCapture(profileData, tabId) {
  if (!(await isAuthenticated())) return null;

  const apiBase = await getApiBase();
  const token   = await getToken();

  const response = await fetch(`${apiBase}/api/extension/profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(profileData),
  });

  if (!response.ok) throw new Error(`Profile capture failed: ${response.status}`);
  return response.json();
}

// ── LinkedIn Cookie Helpers ───────────────────────────────────────────────────

async function getLinkedInCookies() {
  const [liAt, jsession] = await Promise.all([
    chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_at' }),
    chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'JSESSIONID' }),
  ]);
  return {
    liAt:       liAt?.value || null,
    jsessionId: jsession?.value || null,
  };
}

// ── State & Badge Helpers ─────────────────────────────────────────────────────

async function setSyncState(state) {
  const current = await getSyncState();
  await chrome.storage.local.set({ syncState: { ...current, ...state } });
  // Relay to popup if open
  chrome.runtime.sendMessage({ type: 'SYNC_STATE_UPDATE', state: { ...current, ...state } }).catch(() => {});
}

async function getSyncState() {
  const { syncState } = await chrome.storage.local.get('syncState');
  return syncState || { status: 'idle' };
}

async function setBadge(text, color) {
  await chrome.action.setBadgeText({ text: String(text) });
  await chrome.action.setBadgeBackgroundColor({ color });
}

async function notifyUser(title, message) {
  const { notificationsEnabled } = await chrome.storage.local.get('notificationsEnabled');
  if (notificationsEnabled === false) return;

  chrome.notifications.create({
    type:    'basic',
    iconUrl: 'icons/icon48.png',
    title,
    message,
  });
}
