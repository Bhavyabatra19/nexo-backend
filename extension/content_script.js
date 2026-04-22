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

    if (isProfilePage()) {
      waitForElement('h1', () => {
        captureCurrentProfile();
        if (!document.getElementById('nexo-save-btn')) injectNexoButton();
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
