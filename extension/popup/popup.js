import { getToken, setToken, clearToken, validateToken } from '../utils/auth.js';

// ── View management ───────────────────────────────────────────────────────────

function show(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(viewId).classList.remove('hidden');
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
  const token = await getToken();
  if (!token) { show('view-auth'); return; }

  // Validate token is still alive
  const stats = await validateToken(token);
  if (!stats) {
    await clearToken();
    show('view-auth');
    return;
  }

  show('view-main');
  await renderMainView(stats);
}

// ── Auth view ─────────────────────────────────────────────────────────────────

document.getElementById('connect-btn').addEventListener('click', async () => {
  const input = document.getElementById('token-input');
  const errorEl = document.getElementById('auth-error');
  const btn = document.getElementById('connect-btn');

  const token = input.value.trim();
  if (!token) { showError(errorEl, 'Paste your token first.'); return; }

  btn.disabled = true;
  btn.textContent = 'Connecting…';
  errorEl.classList.add('hidden');

  const stats = await validateToken(token);
  if (!stats) {
    showError(errorEl, 'Token invalid or expired. Check nexo.in/settings.');
    btn.disabled = false;
    btn.textContent = 'Connect';
    return;
  }

  await setToken(token);
  show('view-main');
  await renderMainView(stats);
});

// Enter key on token input
document.getElementById('token-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('connect-btn').click();
});

// ── Main view ─────────────────────────────────────────────────────────────────

async function renderMainView(stats) {
  // Populate stats from backend
  document.getElementById('stat-contacts').textContent =
    stats.extension_contacts ?? '—';
  document.getElementById('stat-enriched').textContent =
    stats.enriched ?? '—';

  // Last sync from local state
  const syncState = await getSyncStateFromBackground();
  renderSyncState(syncState);

  // Check if LinkedIn is logged in
  const liCookie = await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_at' });
  document.getElementById('linkedin-warning').classList.toggle('hidden', !!liCookie?.value);

  // Notifications toggle
  const { notificationsEnabled } = await chrome.storage.local.get('notificationsEnabled');
  document.getElementById('notif-toggle').checked = notificationsEnabled !== false;

  // Last sync time
  if (syncState?.lastSync) {
    document.getElementById('stat-last-sync').textContent = formatRelativeTime(syncState.lastSync);
  }
}

function renderSyncState(state) {
  const statusEl  = document.getElementById('sync-status-text');
  const iconEl    = document.getElementById('sync-icon');
  const syncBtn   = document.getElementById('sync-btn');
  const progressW = document.getElementById('progress-wrap');
  const progressT = document.getElementById('progress-text');
  const progressB = document.getElementById('progress-bar');

  statusEl.className = 'sync-status';

  switch (state?.status) {
    case 'syncing':
      statusEl.textContent = 'Syncing…';
      statusEl.classList.add('syncing');
      iconEl.textContent = '🔄';
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing…';
      break;
    case 'done':
      statusEl.textContent = `Done · ${formatRelativeTime(state.lastSync)}`;
      statusEl.classList.add('done');
      iconEl.textContent = '✅';
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync Now';
      progressW.classList.add('hidden');
      progressT.classList.add('hidden');
      break;
    case 'error':
      statusEl.textContent = `Error: ${state.error || 'Unknown'}`;
      statusEl.classList.add('error');
      iconEl.textContent = '❌';
      syncBtn.disabled = false;
      syncBtn.textContent = 'Retry Sync';
      break;
    case 'needs_linkedin':
      statusEl.textContent = 'Sign in to LinkedIn first';
      iconEl.textContent = '⚠️';
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync Now';
      break;
    default:
      statusEl.textContent = 'Syncs automatically every 3 days';
      iconEl.textContent = '🔁';
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync Now';
  }
}

// Sync Now button
document.getElementById('sync-btn').addEventListener('click', async () => {
  const syncBtn = document.getElementById('sync-btn');
  syncBtn.disabled = true;
  syncBtn.textContent = 'Starting…';

  chrome.runtime.sendMessage({ type: 'SYNC_NOW' }, (res) => {
    if (!res?.success) {
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync Now';
    }
  });
});

// Disconnect
document.getElementById('disconnect-btn').addEventListener('click', async () => {
  await clearToken();
  show('view-auth');
});

// Notifications toggle
document.getElementById('notif-toggle').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ notificationsEnabled: e.target.checked });
});

// ── Live progress from background ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SYNC_PROGRESS') {
    const pct = Math.round((message.fetched / message.total) * 100);
    document.getElementById('progress-wrap').classList.remove('hidden');
    document.getElementById('progress-text').classList.remove('hidden');
    document.getElementById('progress-bar').style.width = `${pct}%`;
    document.getElementById('progress-text').textContent =
      `Fetching ${message.fetched} of ${message.total} connections…`;
    document.getElementById('sync-status-text').textContent = `Syncing… ${pct}%`;
  }

  if (message.type === 'SYNC_STATE_UPDATE') {
    renderSyncState(message.state);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getSyncStateFromBackground() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' }, resolve);
  });
}

function formatRelativeTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  const hrs  = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);

  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hrs < 24)   return `${hrs}h ago`;
  return `${days}d ago`;
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Start ─────────────────────────────────────────────────────────────────────

init();
