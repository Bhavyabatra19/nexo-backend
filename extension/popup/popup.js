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
  const input   = document.getElementById('token-input');
  const errorEl = document.getElementById('auth-error');
  const btn     = document.getElementById('connect-btn');

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

document.getElementById('token-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('connect-btn').click();
});

// ── Main view ─────────────────────────────────────────────────────────────────

async function renderMainView(stats) {
  document.getElementById('stat-contacts').textContent = stats.extension_contacts ?? '—';
  document.getElementById('stat-enriched').textContent = stats.enriched ?? '—';

  const scanState = await getScanStateFromBackground();
  renderScanState(scanState);

  const liCookie = await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_at' });
  document.getElementById('linkedin-warning').classList.toggle('hidden', !!liCookie?.value);

  const { notificationsEnabled } = await chrome.storage.local.get('notificationsEnabled');
  document.getElementById('notif-toggle').checked = notificationsEnabled !== false;

  if (scanState?.lastBatch) {
    document.getElementById('stat-last-sync').textContent = formatRelativeTime(scanState.lastBatch);
  }
}

function renderScanState(state) {
  const statusEl   = document.getElementById('scan-status-text');
  const iconEl     = document.getElementById('scan-icon');
  const capturedEl = document.getElementById('scan-captured');
  const syncedEl   = document.getElementById('scan-synced');

  capturedEl.textContent = state?.captured ?? 0;
  syncedEl.textContent   = state?.synced   ?? 0;

  if (state?.status === 'scanning' && state.captured > 0) {
    statusEl.textContent = `Scanning — scroll to capture more`;
    statusEl.className   = 'sync-status syncing';
    iconEl.textContent   = '🔄';
  } else if (state?.captured > 0) {
    statusEl.textContent = `Last scan: ${formatRelativeTime(state.lastBatch)}`;
    statusEl.className   = 'sync-status done';
    iconEl.textContent   = '✅';
  } else {
    statusEl.textContent = 'Go to your connections page and scroll';
    statusEl.className   = 'sync-status';
    iconEl.textContent   = '📋';
  }
}

// ── Live updates from background ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SCAN_STATE_UPDATE') {
    renderScanState(message.state);
    if (message.state?.lastBatch) {
      document.getElementById('stat-last-sync').textContent =
        formatRelativeTime(message.state.lastBatch);
    }
  }
});

// ── Controls ──────────────────────────────────────────────────────────────────

document.getElementById('disconnect-btn').addEventListener('click', async () => {
  await clearToken();
  show('view-auth');
});

document.getElementById('notif-toggle').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ notificationsEnabled: e.target.checked });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getScanStateFromBackground() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_SCAN_STATE' }, resolve);
  });
}

function formatRelativeTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  const hrs  = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);

  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24)  return `${hrs}h ago`;
  return `${days}d ago`;
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Start ─────────────────────────────────────────────────────────────────────

init();
