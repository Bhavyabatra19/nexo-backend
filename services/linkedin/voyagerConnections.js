/**
 * LinkedIn Voyager API — Connections Fetcher
 *
 * LinkedIn's internal API used by their own web app.
 * Same approach used by Clay, Dex, PhantomBuster, and Apollo.
 *
 * Requires: li_at + JSESSIONID session cookies from the user's browser.
 * Rate limiting: 2-3s between pages of 100, max 500 per session.
 *
 * How to get cookies:
 *   1. Open linkedin.com in Chrome while logged in
 *   2. DevTools (F12) → Application → Cookies → www.linkedin.com
 *   3. Copy values for: li_at  and  JSESSIONID
 */

const axios = require('axios');
const logger = require('../../logger');

const VOYAGER_CONNECTIONS_URL =
  'https://www.linkedin.com/voyager/api/relationships/dash/connections';

const PAGE_SIZE = 100;
// 2.5-3.5s random delay between pages — mimics human scrolling pace
const pageDelay = () =>
  new Promise(r => setTimeout(r, 2500 + Math.random() * 1000));

/**
 * Fetch all first-degree LinkedIn connections for a user.
 *
 * @param {string} liAt       - li_at cookie value
 * @param {string} jsessionId - JSESSIONID cookie value (used as CSRF token)
 * @param {Function} onProgress - called with ({ fetched, total }) after each page
 * @returns {Array} normalized connection objects
 */
async function fetchAllConnections(liAt, jsessionId, onProgress = () => {}) {
  // JSESSIONID is used as CSRF token — strip surrounding quotes if present
  const csrfToken = jsessionId.replace(/^"|"$/g, '');

  const headers = buildHeaders(liAt, jsessionId, csrfToken);

  // First page — also tells us the total
  const firstPage = await fetchPage(headers, 0);
  const total = firstPage.paging?.total ?? firstPage.elements?.length ?? 0;
  logger.info(`[Voyager] Total connections: ${total}`);

  const allConnections = parseConnections(firstPage.elements || []);
  onProgress({ fetched: allConnections.length, total });

  // Paginate through remaining pages
  let start = PAGE_SIZE;
  while (start < total && start < 30000) { // 30k hard cap
    await pageDelay();

    const page = await fetchPage(headers, start);
    const batch = parseConnections(page.elements || []);
    allConnections.push(...batch);

    onProgress({ fetched: allConnections.length, total });
    logger.info(`[Voyager] Fetched ${allConnections.length}/${total}`);

    if (!page.elements?.length) break; // LinkedIn returned empty page early
    start += PAGE_SIZE;
  }

  return allConnections;
}

const DECORATION_IDS = [
  'com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithDistance-16',
  'com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithDistance-14',
];

async function fetchPage(headers, start) {
  let lastErr;
  for (const decorationId of DECORATION_IDS) {
    try {
      const response = await axios.get(VOYAGER_CONNECTIONS_URL, {
        params: { decorationId, count: PAGE_SIZE, q: 'viewer', start, sortType: 'RECENTLY_ADDED' },
        headers,
        timeout: 20000,
      });
      return response.data;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      // Only retry with next decorationId on 400 (bad params) — anything else is a real error
      if (status !== 400) {
        const body = JSON.stringify(err.response?.data || {}).slice(0, 300);
        logger.error(`[Voyager] fetchPage start=${start} → HTTP ${status}: ${body}`);
        throw err;
      }
      logger.warn(`[Voyager] decorationId ${decorationId} returned 400, trying fallback`);
    }
  }
  const status = lastErr?.response?.status;
  const body = JSON.stringify(lastErr?.response?.data || {}).slice(0, 300);
  logger.error(`[Voyager] fetchPage start=${start} → all decorationIds failed, last HTTP ${status}: ${body}`);
  throw lastErr;
}

async function fetchPageV2(headers, start) {
  // Alternative endpoint — try if primary returns 400
  const response = await axios.get(
    'https://www.linkedin.com/voyager/api/relationships/dash/connections',
    {
      params: {
        decorationId: 'com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithDistance-16',
        count: PAGE_SIZE,
        q: 'viewer',
        start,
      },
      headers,
      timeout: 20000,
    }
  );
  return response.data;
}

function buildHeaders(liAt, jsessionId, csrfToken) {
  return {
    'Cookie': `li_at=${liAt}; JSESSIONID=${csrfToken}`,
    'Csrf-Token': csrfToken,
    'X-RestLi-Protocol-Version': '2.0.0',
    'X-Li-Lang': 'en_US',
    'X-Li-Track': JSON.stringify({
      clientVersion: '1.13.31027',
      mpVersion: '1.13.31027',
      osName: 'web',
      timezoneOffset: 5.5,
      timezone: 'Asia/Kolkata',
      deviceFormFactor: 'DESKTOP',
      mpName: 'voyager-web',
      displayDensity: 1,
      displayWidth: 1920,
      displayHeight: 1080,
    }),
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Accept': 'application/vnd.linkedin.normalized+json+2.1',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
  };
}

/**
 * Normalize raw Voyager connection elements into a flat contact shape
 * compatible with processExtensionProfile().
 */
function parseConnections(elements) {
  const results = [];

  for (const el of elements) {
    const profile = el.connectedMember || el.miniProfile;
    if (!profile) continue;

    const firstName  = profile.firstName  || '';
    const lastName   = profile.lastName   || '';
    const fullName   = `${firstName} ${lastName}`.trim();
    const username   = profile.publicIdentifier || null;
    const headline   = profile.occupation || null;
    const connectedAt = el.connectedAt ? new Date(el.connectedAt) : null;

    if (!username && !fullName) continue;

    // Build profile pic URL from nested CDN structure
    const pic = profile.picture;
    let photoUrl = null;
    if (pic?.rootUrl && pic?.artifacts?.length) {
      const largest = pic.artifacts[pic.artifacts.length - 1];
      photoUrl = pic.rootUrl + largest.fileIdentifyingUrlPathSegment;
    }

    results.push({
      name:            fullName,
      headline,
      company:         extractCompany(headline),
      linkedin_url:    username ? `https://www.linkedin.com/in/${username}` : null,
      profile_pic:     photoUrl,
      connection_degree: 1,
      connected_at:    connectedAt,
      captured_at:     new Date().toISOString(),
    });
  }

  return results;
}

// "Software Engineer at Google" → "Google"
function extractCompany(headline) {
  if (!headline) return null;
  const match = headline.match(/\bat\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

module.exports = { fetchAllConnections };
