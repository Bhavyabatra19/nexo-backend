/**
 * Nexo Content Script — runs on all linkedin.com pages
 *
 * Three modes:
 * 1. Profile page (linkedin.com/in/*): passive DOM capture + inject Nexo button
 * 2. Connections page (/mynetwork/.../connections): MutationObserver scroll capture → batch sync
 * 3. Any page: SPA navigation watcher
 *
 * Design: DOM-reading only (same approach as Dex, Clay, Folk).
 * No cookie injection, no Voyager API calls.
 */

(function () {
  if (window.__nexoInjected) return;
  window.__nexoInjected = true;

  const isProfilePage     = () => window.location.pathname.startsWith('/in/');
  const isConnectionsPage = () => window.location.pathname.includes('/mynetwork/invite-connect/connections');

  if (isProfilePage()) {
    waitForElement('h1', () => {
      captureCurrentProfile();
      injectNexoButton();
      mountWidget();
    });
  }

  if (isConnectionsPage()) {
    waitForElement(
      CONNECTION_CARD_SELECTORS.join(', '),
      startConnectionsCapture,
      15000
    );
  }

  // ── Selectors ─────────────────────────────────────────────────────────────
  // Multiple variants to survive LinkedIn's frequent CSS renames.

  const CONNECTION_CARD_SELECTORS = [
    'li.mn-connection-card',
    'li[class*="mn-connection-card"]',
    'li[class*="reusable-search__result-container"]',
    'li[class*="entity-result"]',
    'li[class*="scaffold-finite-scroll"]',
  ];

  const CONNECTION_LIST_SELECTORS = [
    '.mn-connections__list',
    '[class*="scaffold-finite-scroll__content"]',
    '[class*="search-results-container"]',
  ];

  function isConnectionCard(el) {
    return el.matches?.(CONNECTION_CARD_SELECTORS.join(', '));
  }

  function queryCards(root) {
    return [...root.querySelectorAll(CONNECTION_CARD_SELECTORS.join(', '))];
  }

  // ── Connections Page Capture ───────────────────────────────────────────────

  function startConnectionsCapture() {
    if (window.__nexoScanActive) return;
    window.__nexoScanActive = true;

    const seen    = new Set();
    let   pending = [];
    let   flushTimer  = null;
    let   flushInFlight = false;

    injectScanBadge();
    updateScanBadge(0);

    function processCard(card) {
      const profile = extractConnectionCard(card);
      if (!profile || seen.has(profile.linkedin_url)) return;
      seen.add(profile.linkedin_url);
      pending.push(profile);
      updateScanBadge(seen.size);

      clearTimeout(flushTimer);
      if (pending.length >= 50) {
        flush();
      } else {
        flushTimer = setTimeout(flush, 2000);
      }
    }

    function flush() {
      if (!pending.length || flushInFlight) return;
      const batch = pending.splice(0, 50);
      flushInFlight = true;

      sendWithRetry(
        { type: 'CONNECTIONS_BATCH', data: batch, total: seen.size },
        3,
        () => { flushInFlight = false; }
      );
    }

    // ── Start observer FIRST to avoid the timing gap where cards appear
    //    between queryCards() and observer.observe().
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (isConnectionCard(node)) {
            processCard(node);
          } else {
            queryCards(node).forEach(processCard);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Capture cards already in the DOM after observer is live
    queryCards(document).forEach(processCard);

    // Flush remaining cards on page unload
    window.addEventListener('beforeunload', () => {
      clearTimeout(flushTimer);
      flush();
    }, { once: true });
  }

  // ── Card Extraction ────────────────────────────────────────────────────────
  // Tries multiple selector strategies for each field to handle LinkedIn
  // layout changes. Returns null if no usable linkedin_url or name found.

  function extractConnectionCard(card) {
    // Primary /in/ link — skip overlay, messaging, mutual-connection links
    const link = [...card.querySelectorAll('a[href]')].find(a => {
      const href = a.getAttribute('href') || '';
      return /^\/in\/[^/?#]/.test(href) &&
             !href.includes('/overlay/') &&
             !href.includes('/messaging/') &&
             !href.includes('/search/');
    });
    if (!link) return null;

    const rawPath    = link.getAttribute('href').split('?')[0].replace(/\/$/, '');
    const linkedin_url = `https://www.linkedin.com${rawPath}`;

    // Name — ordered from most specific to most generic
    const name =
      // Modern layout: mn-connection-card__name
      qText(card, '.mn-connection-card__name') ||
      qText(card, '[class*="connection-card__name"]') ||
      // Search/entity-result layout
      qText(card, '.entity-result__title-text > span[aria-hidden="true"]') ||
      qText(card, '[class*="entity-result__title-text"] span[aria-hidden="true"]') ||
      qText(card, '[class*="entity-result__title-line"] span[aria-hidden="true"]') ||
      // Generic: first visible span inside h3
      qText(card, 'h3 span[aria-hidden="true"]') ||
      qText(card, 'h3 > span:not(.visually-hidden)') ||
      // aria-label fallback: "View John Doe's profile" or just "John Doe"
      parseAriaLabel(link.getAttribute('aria-label')) ||
      null;

    if (!name) return null;

    const headline =
      qText(card, '.mn-connection-card__occupation') ||
      qText(card, '[class*="connection-card__occupation"]') ||
      qText(card, '.entity-result__primary-subtitle') ||
      qText(card, '[class*="entity-result__primary-subtitle"]') ||
      qText(card, '.t-14.t-black--light.t-normal') ||
      null;

    // Profile pic — prefer ghost-free CDN URLs
    const profile_pic =
      qAttr(card, 'img[src*="licdn.com"]:not([src*="ghost"])', 'src') ||
      qAttr(card, 'img[src*="media.licdn.com"]', 'src') ||
      qAttr(card, 'img[src*="linkedin.com"]', 'src') ||
      null;

    return {
      linkedin_url,
      name,
      headline,
      company:           null,   // extracted server-side from headline
      profile_pic,
      connection_degree: 1,
      captured_at:       new Date().toISOString(),
    };
  }

  function parseAriaLabel(label) {
    if (!label) return null;
    // "View John Doe's profile" → "John Doe"
    // "John Doe's profile" → "John Doe"
    // "John Doe" → "John Doe"
    return label
      .replace(/^View\s+/i, '')
      .replace(/['']s\s+profile$/i, '')
      .replace(/\s+profile$/i, '')
      .trim() || null;
  }

  // ── In-page scan badge ─────────────────────────────────────────────────────

  function injectScanBadge() {
    if (document.getElementById('nexo-scan-badge')) return;
    injectStyles();

    const badge = document.createElement('div');
    badge.id = 'nexo-scan-badge';
    badge.innerHTML = `
      <span class="nexo-spinner"></span>
      <span id="nexo-scan-count">Nexo: scanning connections…</span>
      <button id="nexo-scan-close" title="Dismiss">✕</button>
    `;
    document.body.appendChild(badge);

    document.getElementById('nexo-scan-close').addEventListener('click', () => {
      badge.remove();
    });
  }

  function updateScanBadge(count) {
    const el = document.getElementById('nexo-scan-count');
    if (el) el.textContent = `Nexo: ${count} connections captured — keep scrolling`;
  }

  // ── Profile Page Capture ───────────────────────────────────────────────────

  function captureCurrentProfile() {
    const profile = extractProfileFromDOM();
    if (!profile.name) return;
    sendWithRetry({ type: 'PROFILE_CAPTURED', data: profile }, 3);

    // Deferred rich capture: experience/education sections load async via XHR.
    // Wait for any of them to appear in the DOM, then re-capture and update.
    waitForRichSections(() => {
      const bio        = extractAbout();
      const experience = extractExperience();
      const education  = extractEducation();
      const skills     = extractSkills();
      if (bio || experience.length || education.length || skills.length) {
        sendWithRetry({
          type: 'PROFILE_CAPTURED',
          data: { ...profile, bio, experience, education, skills },
        }, 2);
      }
    });
  }

  function waitForRichSections(callback, maxWait = 9000) {
    const RICH_SELECTOR =
      '#experience, [data-view-name*="experience-section"], ' +
      '#education,  [data-view-name*="education-section"]';

    if (document.querySelector(RICH_SELECTOR)) {
      setTimeout(callback, 400);
      return;
    }

    const observer = new MutationObserver(() => {
      if (document.querySelector(RICH_SELECTOR)) {
        observer.disconnect();
        setTimeout(callback, 400);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); callback(); }, maxWait);
  }

  function extractProfileFromDOM() {
    const cleanUrl = window.location.href.split('?')[0].replace(/\/$/, '');
    return {
      linkedin_url:      cleanUrl,
      name:              text('h1') || text('.text-heading-xlarge'),
      headline:          text('.text-body-medium.break-words') || text('div[data-field="headline"]'),
      company:           extractCurrentCompany(),
      location:          text('.text-body-small.inline.t-black--light.break-words'),
      profile_pic:       attr('img.pv-top-card-profile-picture__image--photo', 'src') ||
                         attr('img.profile-photo-edit__preview', 'src') ||
                         attr('.pv-top-card__photo img', 'src'),
      connection_degree: extractConnectionDegree(),
      captured_at:       new Date().toISOString(),
    };
  }

  // ── Rich Profile Data Extraction ─────────────────────────────────────────
  // These run after experience/education sections have loaded in the DOM.
  // Multiple selector strategies survive LinkedIn's frequent CSS renames.

  function extractAbout() {
    // Strategy 1: anchor id="about" — walk siblings for span text
    const anchor = document.querySelector('div#about, section#about');
    if (anchor) {
      let sibling = anchor.nextElementSibling;
      for (let i = 0; i < 6 && sibling; i++) {
        const spans = [...sibling.querySelectorAll('span[aria-hidden="true"]')]
          .filter(s => !s.closest('button') && (s.innerText || '').trim().length > 40);
        if (spans.length) return spans[0].innerText.trim();
        sibling = sibling.nextElementSibling;
      }
    }

    // Strategy 2: h2 labelled "About" inside any section
    for (const h2 of document.querySelectorAll('h2')) {
      if ((h2.innerText || '').trim().toLowerCase() === 'about') {
        const section = h2.closest('section') || h2.closest('div[class*="card"]');
        const span = section?.querySelector('.inline-show-more-text span[aria-hidden="true"]') ||
                     section?.querySelector('span[aria-hidden="true"]');
        const t = (span?.innerText || '').trim();
        if (t.length > 40) return t;
      }
    }

    // Strategy 3: data-view-name attr (newer builds)
    const aboutDiv = document.querySelector('[data-view-name*="about"]');
    if (aboutDiv) {
      const span = aboutDiv.querySelector('span[aria-hidden="true"]');
      const t = (span?.innerText || '').trim();
      if (t.length > 40) return t;
    }

    return null;
  }

  function extractExperience() {
    const items = querySectionItems('experience');
    return items.map(li => {
      // Detect grouped (multiple roles at one company) vs single-role entry
      const subItems = li.querySelectorAll('.pvs-list__item--one-column .pvs-entity');
      if (subItems.length > 1) {
        // Grouped: first bold = company, sub-items = individual roles
        const company = qTextFirst(li, '.t-bold span[aria-hidden="true"]');
        return [...subItems].map(sub => ({
          title:   qTextFirst(sub, '.t-bold span[aria-hidden="true"]'),
          company,
          dates:   qTextFirst(sub, '.pvs-entity__caption-wrapper span[aria-hidden="true"]') ||
                   qTextFirst(sub, '.t-14.t-normal.t-black--light span[aria-hidden="true"]'),
          current: isCurrentRole(sub),
        })).filter(r => r.title);
      }

      // Single-role entry
      const bolds = [...li.querySelectorAll('.t-bold span[aria-hidden="true"], .mr1.t-bold span[aria-hidden="true"]')]
        .map(s => (s.innerText || '').trim()).filter(Boolean);

      return [{
        title:   bolds[0] || null,
        company: bolds[1] ||
                 qTextFirst(li, '.t-14.t-normal:not(.t-black--light) span[aria-hidden="true"]'),
        dates:   qTextFirst(li, '.pvs-entity__caption-wrapper span[aria-hidden="true"]') ||
                 qTextFirst(li, '.t-14.t-normal.t-black--light span[aria-hidden="true"]'),
        current: isCurrentRole(li),
      }];
    }).flat().filter(r => r.title);
  }

  function extractEducation() {
    const items = querySectionItems('education');
    return items.map(li => {
      const bolds = [...li.querySelectorAll('.t-bold span[aria-hidden="true"]')]
        .map(s => (s.innerText || '').trim()).filter(Boolean);
      return {
        school: bolds[0] || null,
        degree: qTextFirst(li, '.t-14.t-normal:not(.t-black--light) span[aria-hidden="true"]'),
        dates:  qTextFirst(li, '.pvs-entity__caption-wrapper span[aria-hidden="true"]') ||
                qTextFirst(li, '.t-14.t-normal.t-black--light span[aria-hidden="true"]'),
      };
    }).filter(e => e.school);
  }

  function extractSkills() {
    const items = querySectionItems('skills');
    return items
      .map(li => qTextFirst(li, '.t-bold span[aria-hidden="true"]'))
      .filter(Boolean)
      .slice(0, 30); // cap at 30 skills
  }

  // Find the content list for a named profile section (experience/education/skills).
  // Returns array of <li> elements.
  function querySectionItems(sectionName) {
    // Strategy 1: anchor id (most reliable)
    const anchor = document.querySelector(`div#${sectionName}, section#${sectionName}`);
    if (anchor) {
      // Walk next siblings to find the ul
      let el = anchor.nextElementSibling;
      for (let i = 0; i < 8 && el; i++) {
        const lis = el.querySelectorAll('li.artdeco-list__item, li[class*="pvs-list__item"]');
        if (lis.length) return [...lis];
        el = el.nextElementSibling;
      }
    }

    // Strategy 2: data-view-name attribute
    const byViewName = document.querySelector(`[data-view-name*="${sectionName}"]`);
    if (byViewName) {
      const lis = byViewName.querySelectorAll('li.artdeco-list__item, li[class*="pvs-list__item"]');
      if (lis.length) return [...lis];
    }

    // Strategy 3: find section by h2 text match
    for (const h2 of document.querySelectorAll('h2')) {
      if ((h2.innerText || '').trim().toLowerCase().includes(sectionName)) {
        const section = h2.closest('section') || h2.parentElement?.parentElement;
        if (section) {
          const lis = section.querySelectorAll('li.artdeco-list__item, li[class*="pvs-list__item"]');
          if (lis.length) return [...lis];
        }
      }
    }

    return [];
  }

  function isCurrentRole(el) {
    const dateText = (
      qTextFirst(el, '.pvs-entity__caption-wrapper span[aria-hidden="true"]') ||
      qTextFirst(el, '.t-14.t-normal.t-black--light span[aria-hidden="true"]') || ''
    ).toLowerCase();
    return dateText.includes('present') || dateText.includes('current');
  }

  function qTextFirst(root, selector) {
    return (root.querySelector(selector)?.innerText || '').trim() || null;
  }

  function extractCurrentCompany() {
    const expEntry = document.querySelector(
      '#experience ~ div li:first-child .t-14.t-normal, ' +
      'section[id*="experience"] li:first-child .t-14.t-normal'
    );
    if (expEntry) return expEntry.innerText?.trim() || null;

    const aboutCompany = document.querySelector('span[aria-label*="Current company"]');
    if (aboutCompany) return aboutCompany.innerText?.trim() || null;

    const headline = text('.text-body-medium.break-words');
    if (headline) {
      const match = headline.match(/\bat\s+(.+)$/i);
      if (match) return match[1].trim();
    }
    return null;
  }

  function extractConnectionDegree() {
    const degreeEl = document.querySelector('span.dist-value');
    if (!degreeEl) return null;
    const t = degreeEl.innerText?.trim();
    if (t === '1st') return 1;
    if (t === '2nd') return 2;
    if (t === '3rd') return 3;
    return null;
  }

  // ── Nexo Button (profile pages) ────────────────────────────────────────────

  function injectNexoButton() {
    if (document.getElementById('nexo-save-btn')) return;

    const actionBar = document.querySelector(
      '.pvs-profile-actions, .pv-top-card-v2-ctas, ' +
      '[class*="profile-actions"], [class*="pv-top-card__cta"]'
    );
    if (!actionBar) {
      setTimeout(injectNexoButton, 1500);
      return;
    }

    const btn = document.createElement('button');
    btn.id = 'nexo-save-btn';
    btn.className = 'nexo-btn';
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
        <path d="M2 17l10 5 10-5"/>
        <path d="M2 12l10 5 10-5"/>
      </svg>
      Save to Nexo
    `;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.disabled = true;
      btn.innerHTML = '<span class="nexo-spinner"></span> Saving…';

      sendWithRetry({ type: 'PROFILE_CAPTURED', data: extractProfileFromDOM() }, 2, (res) => {
        if (res?.success) {
          btn.innerHTML = '✓ Saved';
          btn.style.background = '#22c55e';
        } else {
          btn.innerHTML = '✗ Error';
          btn.style.background = '#ef4444';
        }
        setTimeout(() => {
          btn.innerHTML = 'Save to Nexo';
          btn.disabled = false;
          btn.style.background = '';
        }, 2000);
      });
    });

    actionBar.prepend(btn);
    injectStyles();
  }

  // ── sendMessage with retry ─────────────────────────────────────────────────
  // Chrome's background service worker can be suspended; retry up to maxAttempts.

  function sendWithRetry(message, maxAttempts, onDone) {
    let attempts = 0;

    function attempt() {
      attempts++;
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) {
          if (attempts < maxAttempts) {
            setTimeout(attempt, 500 * attempts);
          } else {
            console.warn('[Nexo] sendMessage failed after retries:', chrome.runtime.lastError.message);
            onDone?.(null);
          }
          return;
        }
        onDone?.(res);
      });
    }

    attempt();
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('nexo-styles')) return;
    const style = document.createElement('style');
    style.id = 'nexo-styles';
    style.textContent = `
      .nexo-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 16px; background: #6366f1; color: #fff;
        border: none; border-radius: 20px; font-size: 14px;
        font-weight: 600; cursor: pointer; transition: background 0.2s;
        margin-right: 8px; height: 32px; white-space: nowrap;
      }
      .nexo-btn:hover { background: #4f46e5; }
      .nexo-btn:disabled { opacity: 0.7; cursor: not-allowed; }
      .nexo-spinner {
        width: 12px; height: 12px;
        border: 2px solid rgba(255,255,255,0.4);
        border-top-color: #fff; border-radius: 50%;
        display: inline-block;
        animation: nexo-spin 0.6s linear infinite;
      }
      @keyframes nexo-spin { to { transform: rotate(360deg); } }

      #nexo-scan-badge {
        position: fixed; bottom: 24px; right: 24px; z-index: 99999;
        display: flex; align-items: center; gap: 8px;
        padding: 10px 14px; background: #1e1b4b; color: #fff;
        border-radius: 12px; font-size: 13px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      }
      #nexo-scan-close {
        background: none; border: none; color: rgba(255,255,255,0.5);
        cursor: pointer; font-size: 12px; padding: 0 0 0 4px; line-height: 1;
      }
      #nexo-scan-close:hover { color: #fff; }
    `;
    document.head.appendChild(style);
  }

  // ── DOM Helpers ────────────────────────────────────────────────────────────

  function text(selector) {
    return document.querySelector(selector)?.innerText?.trim() || null;
  }

  function attr(selector, attribute) {
    return document.querySelector(selector)?.getAttribute(attribute) || null;
  }

  function qText(root, selector) {
    return root.querySelector(selector)?.innerText?.trim() || null;
  }

  function qAttr(root, selector, attribute) {
    return root.querySelector(selector)?.getAttribute(attribute) || null;
  }

  function waitForElement(selector, callback, maxWait = 5000) {
    if (document.querySelector(selector)) { callback(); return; }
    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) {
        observer.disconnect();
        callback();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), maxWait);
  }

  // ── Dex-style in-page widget ───────────────────────────────────────────────

  const WIDGET_HOST_ID = 'nexo-widget-host';
  const FRONTEND_URL = 'https://nexo-frontend-indol.vercel.app';

  function currentProfileUrl() {
    return window.location.href.split('?')[0].replace(/\/$/, '');
  }

  async function apiFetch(path, opts = {}) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(
        { type: 'API_FETCH', path, method: opts.method, body: opts.body },
        (res) => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(res || { ok: false, error: 'no response' });
        }
      );
    });
  }

  function unmountWidget() {
    document.getElementById(WIDGET_HOST_ID)?.remove();
  }

  function mountWidget() {
    if (document.getElementById(WIDGET_HOST_ID)) return;

    const host = document.createElement('div');
    host.id = WIDGET_HOST_ID;
    host.style.cssText = 'position:fixed;top:88px;right:16px;z-index:99998;all:initial;';
    document.body.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${widgetStyles()}</style>
      <div class="w-wrap" id="w-wrap">
        <button class="w-pill" id="w-pill" title="Nexo">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        </button>
        <div class="w-panel" id="w-panel">
          <div class="w-header">
            <div class="w-brand">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
              <span>Nexo</span>
            </div>
            <button class="w-x" id="w-close" title="Collapse">—</button>
          </div>
          <div class="w-body" id="w-body">
            <div class="w-spinner"></div>
          </div>
        </div>
      </div>
    `;

    const pill   = root.getElementById('w-pill');
    const panel  = root.getElementById('w-panel');
    const close  = root.getElementById('w-close');
    const body   = root.getElementById('w-body');

    pill.addEventListener('click', () => {
      panel.classList.add('w-open');
      pill.classList.add('w-hide');
    });
    close.addEventListener('click', () => {
      panel.classList.remove('w-open');
      pill.classList.remove('w-hide');
    });

    // Start expanded so the user sees it. Toggle to pill on close.
    panel.classList.add('w-open');
    pill.classList.add('w-hide');

    loadWidget(body);
  }

  async function loadWidget(body) {
    const url = currentProfileUrl();
    const res = await apiFetch(`/api/extension/contact?url=${encodeURIComponent(url)}`);

    if (res.status === 401 || res.error) {
      body.innerHTML = `
        <div class="w-empty">
          <p class="w-muted">Sign in to see your CRM data for this profile.</p>
          <a class="w-btn w-btn-primary" href="${FRONTEND_URL}" target="_blank">Sign in to Nexo →</a>
        </div>`;
      return;
    }

    const data = res.data || {};
    if (!data.found) {
      body.innerHTML = `
        <div class="w-empty">
          <p class="w-muted">Not in your Nexo yet.</p>
          <button class="w-btn w-btn-primary" id="w-save">Save to Nexo</button>
        </div>`;
      body.querySelector('#w-save').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = 'Saving…';
        // Reuse existing save flow: send a PROFILE_CAPTURED to background.
        chrome.runtime.sendMessage(
          { type: 'PROFILE_CAPTURED', data: extractProfileFromDOM() },
          () => setTimeout(() => loadWidget(body), 800)
        );
      });
      return;
    }

    renderContact(body, data.contact, data.notes || []);
  }

  function renderContact(body, contact, notes) {
    const tagChips = (contact.tags || []).map(t =>
      `<span class="w-chip">${escapeHtml(t)}</span>`).join('');

    const notesHtml = notes.length
      ? notes.map(n => `
          <div class="w-note">
            <div class="w-note-date">${formatDate(n.createdAt)}</div>
            <div class="w-note-body">${escapeHtml(n.content)}</div>
          </div>`).join('')
      : `<p class="w-muted w-small">No notes yet.</p>`;

    body.innerHTML = `
      <div class="w-row">
        <div class="w-status">✓ In your network</div>
        ${contact.connection_tier ? `<span class="w-chip w-chip-small">${contact.connection_tier === 1 ? '1st' : contact.connection_tier === 2 ? '2nd' : '3rd'}</span>` : ''}
      </div>
      ${contact.job_title || contact.company ? `
        <div class="w-meta">
          ${contact.job_title ? `<div>${escapeHtml(contact.job_title)}</div>` : ''}
          ${contact.company ? `<div class="w-muted">${escapeHtml(contact.company)}</div>` : ''}
        </div>` : ''}
      ${tagChips ? `<div class="w-chips">${tagChips}</div>` : ''}

      <div class="w-section-label">Notes</div>
      <div class="w-notes" id="w-notes">${notesHtml}</div>

      <form id="w-note-form" class="w-note-form">
        <textarea id="w-note-input" placeholder="Add a note…" rows="2"></textarea>
        <button type="submit" class="w-btn w-btn-primary w-btn-small">Save note</button>
      </form>

      <a class="w-link" href="${FRONTEND_URL}/dashboard/contacts/${contact.id}" target="_blank">Open in Nexo →</a>
    `;

    const form  = body.querySelector('#w-note-form');
    const input = body.querySelector('#w-note-input');
    const list  = body.querySelector('#w-notes');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const content = input.value.trim();
      if (!content) return;
      const submitBtn = form.querySelector('button');
      submitBtn.disabled = true; submitBtn.textContent = 'Saving…';

      const res = await apiFetch('/api/extension/note', {
        method: 'POST',
        body: { contact_id: contact.id, content },
      });
      submitBtn.disabled = false; submitBtn.textContent = 'Save note';

      if (res.ok && res.data?.note) {
        input.value = '';
        const n = res.data.note;
        const html = `
          <div class="w-note">
            <div class="w-note-date">${formatDate(n.createdAt)}</div>
            <div class="w-note-body">${escapeHtml(n.content)}</div>
          </div>`;
        // Replace "No notes yet" if present
        if (list.querySelector('.w-muted')) list.innerHTML = '';
        list.insertAdjacentHTML('afterbegin', html);
      }
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const diffDays = (Date.now() - d.getTime()) / 86400000;
    if (diffDays < 1)  return 'today';
    if (diffDays < 2)  return 'yesterday';
    if (diffDays < 7)  return `${Math.floor(diffDays)}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function widgetStyles() {
    return `
      :host, * { all: initial; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; box-sizing: border-box; }
      .w-wrap { display: block; }
      .w-pill {
        display: flex; align-items: center; justify-content: center;
        width: 44px; height: 44px; border-radius: 50%;
        background: #6366f1; color: #fff; cursor: pointer;
        box-shadow: 0 4px 16px rgba(99,102,241,0.35); border: none;
      }
      .w-pill:hover { background: #4f46e5; }
      .w-hide { display: none; }

      .w-panel {
        display: none;
        width: 340px; max-height: 80vh; overflow-y: auto;
        background: #fff; border: 1px solid #e5e7eb;
        border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.15);
      }
      .w-open { display: block; }

      .w-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px; border-bottom: 1px solid #f1f5f9;
      }
      .w-brand { display: flex; align-items: center; gap: 6px; font-weight: 700; color: #111; font-size: 13px; }
      .w-x { background: none; border: none; color: #64748b; cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 6px; }
      .w-x:hover { color: #111; }

      .w-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
      .w-spinner {
        width: 18px; height: 18px; margin: 10px auto;
        border: 2px solid #e5e7eb; border-top-color: #6366f1;
        border-radius: 50%; animation: wspin 0.7s linear infinite;
      }
      @keyframes wspin { to { transform: rotate(360deg); } }

      .w-row { display: flex; align-items: center; gap: 8px; }
      .w-status { color: #22c55e; font-weight: 600; font-size: 13px; }
      .w-meta { font-size: 13px; color: #111; line-height: 1.4; display: flex; flex-direction: column; gap: 2px; }
      .w-muted { color: #64748b; font-size: 13px; }
      .w-small { font-size: 12px; }

      .w-chips { display: flex; flex-wrap: wrap; gap: 4px; }
      .w-chip {
        display: inline-block; padding: 2px 8px; border-radius: 999px;
        background: #eef2ff; color: #4338ca; font-size: 11px; font-weight: 600;
      }
      .w-chip-small { font-size: 10px; padding: 1px 6px; }

      .w-section-label { font-size: 10px; font-weight: 700; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px; margin-top: 2px; }

      .w-notes { display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow-y: auto; }
      .w-note { background: #f8fafc; border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
      .w-note-date { font-size: 10px; color: #94a3b8; font-weight: 600; text-transform: uppercase; }
      .w-note-body { font-size: 13px; color: #111; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }

      .w-note-form { display: flex; flex-direction: column; gap: 6px; }
      .w-note-form textarea {
        width: 100%; resize: vertical; min-height: 44px;
        padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 8px;
        font-size: 13px; color: #111; background: #fff;
        font-family: inherit;
      }
      .w-note-form textarea:focus { outline: none; border-color: #6366f1; }

      .w-btn {
        display: inline-flex; align-items: center; justify-content: center;
        padding: 8px 12px; border: none; border-radius: 8px;
        font-size: 13px; font-weight: 600; cursor: pointer;
      }
      .w-btn-primary { background: #6366f1; color: #fff; }
      .w-btn-primary:hover { background: #4f46e5; }
      .w-btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
      .w-btn-small { padding: 6px 10px; font-size: 12px; align-self: flex-start; }

      .w-empty { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
      .w-link { font-size: 12px; color: #6366f1; text-decoration: none; font-weight: 600; }
      .w-link:hover { text-decoration: underline; }
    `;
  }

  // ── SPA navigation watcher ─────────────────────────────────────────────────
  // LinkedIn never does full page reloads; watch for URL changes via pushState.

  let lastUrl = window.location.href;
  new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl === lastUrl) return;
    lastUrl = currentUrl;

    // Full reset for new page
    window.__nexoScanActive = false;
    const existing = document.getElementById('nexo-scan-badge');
    if (existing) existing.remove();
    unmountWidget();

    if (isProfilePage()) {
      waitForElement('h1', () => {
        captureCurrentProfile();
        if (!document.getElementById('nexo-save-btn')) injectNexoButton();
        mountWidget();
      });
    }

    if (isConnectionsPage()) {
      waitForElement(
        CONNECTION_CARD_SELECTORS.join(', '),
        startConnectionsCapture,
        15000
      );
    }
  }).observe(document.body, { childList: true, subtree: true });

})();
