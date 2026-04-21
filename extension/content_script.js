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
      bio:               extractBio(),
      experience:        extractExperience(),
      education:         extractEducation(),
      skills:            extractSkills(),
      captured_at:       new Date().toISOString(),
    };
  }

  // ── Bio / About ────────────────────────────────────────────────────────────

  function extractBio() {
    // "About" section — LinkedIn renders a collapsible span
    const aboutSection = document.querySelector(
      '#about ~ div .pv-shared-text-with-see-more span[aria-hidden="true"], ' +
      'section.pv-about-section div.pv-about__summary-text, ' +
      '.pv-about-section .lt-line-clamp__raw-line'
    );
    return aboutSection?.innerText?.trim() || null;
  }

  // ── Experience / Work History ──────────────────────────────────────────────

  function extractExperience() {
    // LinkedIn renders experience entries in a list under #experience
    const section = findSection('experience');
    if (!section) return [];

    const entries = [];

    // Each li under the experience section list
    const listItems = section.querySelectorAll('li.artdeco-list__item');
    for (const li of listItems) {
      // Detect grouped roles at same company (nested list inside a group card)
      const groupedRoles = li.querySelectorAll('.pvs-entity__sub-components li');
      if (groupedRoles.length > 0) {
        // Company name is the top-level heading of the group
        const groupCompany = cleanText(li.querySelector('.mr1.t-bold span[aria-hidden="true"]'));
        for (const role of groupedRoles) {
          const entry = parseExperienceItem(role, groupCompany);
          if (entry) entries.push(entry);
        }
      } else {
        const entry = parseExperienceItem(li);
        if (entry) entries.push(entry);
      }
    }

    return entries;
  }

  function parseExperienceItem(li, overrideCompany = null) {
    // Title is the first bold span
    const titleEl = li.querySelector('.mr1.t-bold span[aria-hidden="true"], .t-14.t-bold span[aria-hidden="true"]');
    const title = cleanText(titleEl);
    if (!title) return null;

    // Company name — second line or passed in from group
    const companyEl = li.querySelector('.t-14.t-normal span[aria-hidden="true"]');
    const rawCompany = cleanText(companyEl);
    // Raw company often includes employment type: "Anthropic · Full-time"
    const company = overrideCompany || rawCompany?.split('·')[0]?.trim() || null;

    // Date range + duration — ".pvs-entity__caption-wrapper" or second .t-14.t-normal
    const captionEls = li.querySelectorAll('.pvs-entity__caption-wrapper, .t-14.t-normal.t-black--light span[aria-hidden="true"]');
    let dateRange = null, duration = null, location = null;

    for (const el of captionEls) {
      const t = cleanText(el);
      if (!t) continue;
      // Date ranges contain month/year patterns or "Present"
      if (/\d{4}|Present/i.test(t) && !dateRange) {
        // "Jan 2022 – Present · 2 yrs"  or  "2022 – 2024"
        const parts = t.split(' · ');
        dateRange = parts[0]?.trim() || null;
        duration  = parts[1]?.trim() || null;
      } else if (!location) {
        location = t;
      }
    }

    const { start, end, current } = parseDateRange(dateRange);

    // Description — expanded text block
    const descEl = li.querySelector('.pv-shared-text-with-see-more span[aria-hidden="true"], .pvs-list__item--with-top-padding span[aria-hidden="true"]');
    const description = cleanText(descEl);

    return { title, company, start, end, current, duration, location, description };
  }

  // ── Education ──────────────────────────────────────────────────────────────

  function extractEducation() {
    const section = findSection('education');
    if (!section) return [];

    const entries = [];
    const listItems = section.querySelectorAll('li.artdeco-list__item');

    for (const li of listItems) {
      const school  = cleanText(li.querySelector('.mr1.t-bold span[aria-hidden="true"]'));
      if (!school) continue;

      const degreeEl  = li.querySelector('.t-14.t-normal span[aria-hidden="true"]');
      const rawDegree = cleanText(degreeEl);

      // "Bachelor of Science, Computer Science" or "B.S. · Computer Science"
      let degree = null, field = null;
      if (rawDegree) {
        const parts = rawDegree.split(/[,·]/);
        degree = parts[0]?.trim() || null;
        field  = parts[1]?.trim() || null;
      }

      // Dates in caption
      const captionEl = li.querySelector('.pvs-entity__caption-wrapper span[aria-hidden="true"], .t-14.t-normal.t-black--light span[aria-hidden="true"]');
      const dateRange = cleanText(captionEl);
      const { start, end } = parseDateRange(dateRange);

      entries.push({ school, degree, field, start, end });
    }

    return entries;
  }

  // ── Skills ─────────────────────────────────────────────────────────────────

  function extractSkills() {
    const section = findSection('skills');
    if (!section) return [];

    const skills = [];
    const listItems = section.querySelectorAll('li.artdeco-list__item');
    for (const li of listItems) {
      const name = cleanText(li.querySelector('.mr1.t-bold span[aria-hidden="true"], .t-16.t-bold span[aria-hidden="true"]'));
      if (name) skills.push(name);
      if (skills.length >= 30) break; // cap at 30 — the rest are rarely visible anyway
    }

    return skills;
  }

  // ── Section Finder ─────────────────────────────────────────────────────────

  function findSection(id) {
    // LinkedIn uses id="experience" etc. on the section or its heading
    let section = document.querySelector(`#${id}`);
    if (section) {
      // Walk up to the closest section container
      return section.closest('section') || section.parentElement;
    }
    // Fallback: aria-label
    section = document.querySelector(`section[aria-label*="${id}" i]`);
    return section || null;
  }

  // ── Company Extraction ─────────────────────────────────────────────────────

  function extractCurrentCompany() {
    // Try experience section first (most reliable)
    const expEntry = document.querySelector(
      '#experience ~ div li:first-child .t-14.t-normal, ' +
      'section[id*="experience"] li:first-child .t-14.t-normal'
    );
    if (expEntry) return expEntry.innerText?.trim()?.split('·')[0]?.trim();

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
    const t = degreeEl.innerText?.trim();
    if (t === '1st') return 1;
    if (t === '2nd') return 2;
    if (t === '3rd') return 3;
    return null;
  }

  // ── Date Range Parser ──────────────────────────────────────────────────────

  function parseDateRange(raw) {
    if (!raw) return { start: null, end: null, current: false };

    // "Jan 2022 – Present", "2019 – 2023", "Mar 2020 – Dec 2021"
    const parts = raw.split(/–|-/);
    const start = parts[0]?.trim() || null;
    const endRaw = parts[1]?.trim() || null;
    const current = !endRaw || /present/i.test(endRaw);
    const end = current ? null : endRaw;

    return { start, end, current };
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

  function cleanText(el) {
    return el?.innerText?.trim() || null;
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
