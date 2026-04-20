/**
 * Nexo Content Script — runs on all linkedin.com pages
 *
 * Two modes:
 * 1. Profile page (linkedin.com/in/*): passive DOM capture + inject Nexo button
 * 2. Any page: listen for manual scan triggers from background
 */

(function () {
  // Only run once per page
  if (window.__nexoInjected) return;
  window.__nexoInjected = true;

  const isProfilePage     = window.location.pathname.startsWith('/in/');
  const isConnectionsPage = window.location.pathname.includes('/mynetwork/invite-connect/connections');

  if (isProfilePage) {
    // Wait for LinkedIn's React to finish rendering
    waitForElement('h1', () => {
      captureCurrentProfile();
      injectNexoButton();
    });
  }

  // ── Profile Capture ────────────────────────────────────────────────────────

  function captureCurrentProfile() {
    const profile = extractProfileFromDOM();
    if (!profile.name) return;

    chrome.runtime.sendMessage({ type: 'PROFILE_CAPTURED', data: profile }, (response) => {
      if (chrome.runtime.lastError) return; // background not ready — fine
    });
  }

  function extractProfileFromDOM() {
    const cleanUrl = window.location.href.split('?')[0].replace(/\/$/, '');

    return {
      linkedin_url:      cleanUrl,
      name:              text('h1') || text('.text-heading-xlarge'),
      headline:          text('.text-body-medium.break-words') || text('div[data-field="headline"]'),
      company:           extractCurrentCompany(),
      location:          text('.text-body-small.inline.t-black--light.break-words'),
      profile_pic:       attr('img.pv-top-card-profile-picture__image', 'src') ||
                         attr('img.profile-photo-edit__preview', 'src'),
      connection_degree: extractConnectionDegree(),
      captured_at:       new Date().toISOString(),
    };
  }

  function extractCurrentCompany() {
    // Try experience section first (most reliable)
    const expEntry = document.querySelector(
      '#experience ~ div li:first-child .t-14.t-normal, ' +
      'section[id*="experience"] li:first-child .t-14.t-normal'
    );
    if (expEntry) return expEntry.innerText?.trim();

    // Fall back to "Works at X" in about section
    const aboutCompany = document.querySelector('span[aria-label*="Current company"]');
    if (aboutCompany) return aboutCompany.innerText?.trim();

    // Last resort: parse from headline "Role at Company"
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
    const text = degreeEl.innerText?.trim();
    if (text === '1st') return 1;
    if (text === '2nd') return 2;
    if (text === '3rd') return 3;
    return null;
  }

  // ── Nexo Button Injection ──────────────────────────────────────────────────

  function injectNexoButton() {
    // Don't inject twice
    if (document.getElementById('nexo-save-btn')) return;

    // Find the action buttons row on the profile page
    const actionBar = document.querySelector('.pvs-profile-actions, .pv-top-card-v2-ctas');
    if (!actionBar) {
      // Retry after a short delay — React may not have rendered yet
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

      chrome.runtime.sendMessage({ type: 'PROFILE_CAPTURED', data: extractProfileFromDOM() }, (res) => {
        if (res?.success) {
          btn.innerHTML = '✓ Saved';
          btn.style.background = '#22c55e';
          setTimeout(() => {
            btn.innerHTML = 'Save to Nexo';
            btn.disabled = false;
            btn.style.background = '';
          }, 2000);
        } else {
          btn.innerHTML = '✗ Error';
          btn.style.background = '#ef4444';
          setTimeout(() => {
            btn.innerHTML = 'Save to Nexo';
            btn.disabled = false;
            btn.style.background = '';
          }, 2000);
        }
      });
    });

    // Insert button at start of action bar
    actionBar.prepend(btn);
    injectButtonStyles();
  }

  function injectButtonStyles() {
    if (document.getElementById('nexo-styles')) return;
    const style = document.createElement('style');
    style.id = 'nexo-styles';
    style.textContent = `
      .nexo-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 16px;
        background: #6366f1;
        color: #fff;
        border: none;
        border-radius: 20px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
        margin-right: 8px;
        height: 32px;
        white-space: nowrap;
      }
      .nexo-btn:hover { background: #4f46e5; }
      .nexo-btn:disabled { opacity: 0.7; cursor: not-allowed; }
      .nexo-spinner {
        width: 12px; height: 12px;
        border: 2px solid rgba(255,255,255,0.4);
        border-top-color: #fff;
        border-radius: 50%;
        display: inline-block;
        animation: nexo-spin 0.6s linear infinite;
      }
      @keyframes nexo-spin { to { transform: rotate(360deg); } }
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

  // ── LinkedIn SPA navigation — re-run on URL changes ───────────────────────
  // LinkedIn is a SPA — URL changes without full page reload

  let lastUrl = window.location.href;
  new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      window.__nexoInjected = false;
      // Re-run the script logic on new page
      if (window.location.pathname.startsWith('/in/')) {
        window.__nexoInjected = true;
        waitForElement('h1', () => {
          captureCurrentProfile();
          injectNexoButton();
        });
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

})();
