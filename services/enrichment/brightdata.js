/**
 * Bright Data LinkedIn Profile Scraper enrichment provider.
 * Dataset ID: gd_lyy3tktm25m4avu764 (Profile URL collector)
 *
 * Flow: trigger snapshot → poll until ready → normalize results.
 * Supports single profile (enrich) and batch (enrichBatch).
 *
 * Env vars required:
 *   BRIGHTDATA_API_KEY   — API token from brightdata.com/cp/api_tokens
 *   BRIGHTDATA_DATASET_ID — defaults to gd_lyy3tktm25m4avu764
 */

const axios = require('axios');
const logger = require('../../logger');

const DATASET_ID   = process.env.BRIGHTDATA_DATASET_ID || 'gd_lyy3tktm25m4avu764';
const API_BASE     = 'https://api.brightdata.com/datasets/v3';
const POLL_INTERVAL_MS = 4000;
const MAX_POLL_ATTEMPTS = 60; // 60 × 4s = 4-minute timeout

function headers() {
  if (!process.env.BRIGHTDATA_API_KEY) throw new Error('BRIGHTDATA_API_KEY not configured');
  return {
    'Authorization': `Bearer ${process.env.BRIGHTDATA_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Enrich a single LinkedIn profile URL.
 * Returns normalized contact data compatible with adapter.js.
 */
async function enrich(linkedinUrl) {
  const results = await enrichBatch([linkedinUrl]);
  if (!results.length) throw new Error('No data returned from Bright Data');
  return results[0];
}

/**
 * Enrich a batch of LinkedIn URLs (up to 100 per trigger).
 * Returns array of normalized contact objects.
 * Items that fail silently return null in their position.
 */
async function enrichBatch(linkedinUrls) {
  const payload = linkedinUrls.map(url => ({ url }));

  // Trigger the snapshot
  const triggerRes = await axios.post(
    `${API_BASE}/trigger?dataset_id=${DATASET_ID}&include_errors=true`,
    payload,
    { headers: headers(), timeout: 30000 }
  );

  const snapshotId = triggerRes.data?.snapshot_id;
  if (!snapshotId) throw new Error(`Bright Data trigger failed: ${JSON.stringify(triggerRes.data)}`);

  logger.info(`[BrightData] Triggered snapshot ${snapshotId} for ${linkedinUrls.length} URLs`);

  // Poll until ready
  const rawResults = await pollUntilReady(snapshotId);
  return rawResults.map(normalizeProfile).filter(Boolean);
}

async function pollUntilReady(snapshotId) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    const res = await axios.get(
      `${API_BASE}/snapshot/${snapshotId}?format=json`,
      { headers: headers(), timeout: 20000 }
    );

    const status = res.data?.status || res.status;

    if (status === 'running' || res.status === 202) {
      logger.info(`[BrightData] Snapshot ${snapshotId} still running (attempt ${attempt + 1})`);
      continue;
    }

    if (res.status === 200) {
      const data = res.data;
      // Response is an array of profile objects
      return Array.isArray(data) ? data : [data];
    }

    throw new Error(`Bright Data snapshot error: status ${res.status}`);
  }

  throw new Error(`Bright Data snapshot ${snapshotId} timed out after ${MAX_POLL_ATTEMPTS} attempts`);
}

/**
 * Normalize a Bright Data LinkedIn profile into the shape
 * expected by enrichment/adapter.js.
 */
function normalizeProfile(raw) {
  if (!raw || raw.error) {
    logger.warn(`[BrightData] Skipping errored record: ${raw?.error}`);
    return null;
  }

  return {
    full_name:       raw.name || raw.full_name || null,
    first_name:      raw.first_name || null,
    last_name:       raw.last_name  || null,
    bio:             raw.about || raw.summary || null,
    occupation:      raw.headline || raw.title || null,
    company:         extractCurrentCompany(raw),
    profile_pic_url: raw.profile_pic_url || raw.avatar || null,

    skills: normalizeSkills(raw.skills),

    experiences: (raw.experience || []).map(e => ({
      title:       e.title || null,
      company:     e.company || e.company_name || null,
      start:       e.start_date || e.date_range?.start || null,
      end:         e.end_date   || e.date_range?.end   || null,
      current:     e.is_current ?? (e.end_date?.toLowerCase?.() === 'present') ?? false,
      description: e.description || null,
      location:    e.location || null,
    })),

    education: (raw.education || []).map(e => ({
      school: e.school || e.institution || null,
      degree: e.degree || null,
      field:  e.field_of_study || e.field || null,
      start:  e.start_date || null,
      end:    e.end_date   || null,
    })),

    city:    extractCity(raw),
    country: extractCountry(raw),

    connections_count: extractIntMetric(raw, ['connections_count', 'connections', 'connection_count', 'num_connections']),
    followers_count:   extractIntMetric(raw, ['followers_count', 'followers', 'follower_count', 'num_followers']),
    last_post:         extractLastPost(raw),

    _provider: 'brightdata',
    _raw_url:  raw.url || raw.profile_url || null,
  };
}

// LinkedIn often shows "500+ connections" — strip non-digits and cap to int.
function extractIntMetric(raw, candidates) {
  for (const key of candidates) {
    const v = raw[key];
    if (v == null) continue;
    if (typeof v === 'number') return Math.trunc(v);
    if (typeof v === 'string') {
      const digits = v.replace(/[^0-9]/g, '');
      if (digits) return parseInt(digits, 10);
    }
  }
  return null;
}

// Bright Data's profile dataset surfaces recent posts under varying keys
// across plan tiers. Pick the most recent one we can find, normalize the
// shape, and let the DB store the timestamp + the JSON blob.
function extractLastPost(raw) {
  const candidates = [raw.posts, raw.recent_posts, raw.activity, raw.latest_posts];
  let posts = null;
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) { posts = c; break; }
  }
  if (!posts) return null;

  const normalized = posts
    .map((p) => {
      if (!p || typeof p !== 'object') return null;
      const text =
        p.text || p.content || p.post_text || p.body || p.title || null;
      const url = p.url || p.post_url || p.link || p.permalink || null;
      const postedAtRaw =
        p.posted_at || p.date || p.published_at || p.time || p.created_at || null;
      const posted_at = postedAtRaw ? toIsoSafe(postedAtRaw) : null;
      const likes    = numericOr(p.likes ?? p.likes_count ?? p.reactions, null);
      const comments = numericOr(p.comments ?? p.comments_count, null);
      if (!text && !url) return null;
      return { text, url, posted_at, likes, comments };
    })
    .filter(Boolean);

  if (!normalized.length) return null;

  // Prefer most recent by posted_at, falling back to array order.
  normalized.sort((a, b) => {
    const ta = a.posted_at ? Date.parse(a.posted_at) : 0;
    const tb = b.posted_at ? Date.parse(b.posted_at) : 0;
    return tb - ta;
  });
  return normalized[0];
}

function toIsoSafe(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function numericOr(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string') {
    const digits = v.replace(/[^0-9]/g, '');
    return digits ? parseInt(digits, 10) : fallback;
  }
  return fallback;
}

function extractCurrentCompany(raw) {
  if (raw.current_company) return raw.current_company;
  const current = (raw.experience || []).find(e => e.is_current || !e.end_date || e.end_date?.toLowerCase() === 'present');
  return current?.company || current?.company_name || null;
}

function normalizeSkills(skills) {
  if (!skills) return [];
  return skills.map(s => (typeof s === 'string' ? s : s.name || s.skill)).filter(Boolean);
}

function extractCity(raw) {
  if (raw.city) return raw.city;
  const loc = raw.location || '';
  return loc.split(',')[0]?.trim() || null;
}

function extractCountry(raw) {
  if (raw.country) return raw.country;
  const loc = raw.location || '';
  const parts = loc.split(',');
  return parts[parts.length - 1]?.trim() || null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { enrich, enrichBatch };
