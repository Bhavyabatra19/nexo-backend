/**
 * scanOrchestrator — runs a chat-based network-of-network scan.
 *
 * Flow:
 *   1. Load the scans row (created by the API).
 *   2. Parse the natural-language query into filters (LLM, with fallback).
 *   3. Retrieve candidates in parallel:
 *        a. user's own contacts via Pinecone personal namespace
 *        b. extended-network contacts via Pinecone group namespaces
 *           (covers every group the user is a consented member of)
 *   4. Hydrate matches from Postgres (full contact + bridge user info).
 *   5. Rank by vector × bridge warmth × stage/geo boosts × recency.
 *   6. Persist top 25 back to the scans row, mark completed.
 *
 * Naming note: this is the "scan" surface (chat → ranked results). The older
 * services/networkScan.js handles cross-member overlap detection from mig 027
 * — totally different concern.
 */

const db = require('../db');
const logger = require('../logger');
const pineconeService = require('./pineconeService');
const { parseScanQuery } = require('./scanQueryParser');
const { rankResults } = require('./scanRanking');

const TOP_N = 25;
const PER_USER_TOPK = 30;
const FALLBACK_LIMIT = 80;

function ilikeFilter(parsed) {
  // Only used when Pinecone is unavailable. Builds an OR of haystacks against
  // the parsed terms so we still return *something* in offline / unconfigured
  // environments rather than an empty result set.
  const terms = [parsed.role, parsed.industry, parsed.geo, ...(parsed.keywords || [])]
    .filter(Boolean)
    .map(s => `%${s.toLowerCase()}%`);
  return terms;
}

async function fallbackPersonal(userId, parsed) {
  const terms = ilikeFilter(parsed);
  if (!terms.length) {
    const { rows } = await db.query(
      `SELECT id FROM contacts WHERE user_id = $1 AND is_private = false
       ORDER BY confidence_score DESC NULLS LAST LIMIT $2`,
      [userId, FALLBACK_LIMIT]
    );
    return rows.map(r => ({ contactId: r.id, score: 0.5 }));
  }
  const { rows } = await db.query(
    `SELECT id,
            (CASE WHEN job_title ILIKE ANY($2) THEN 0.4 ELSE 0 END
           + CASE WHEN company   ILIKE ANY($2) THEN 0.3 ELSE 0 END
           + CASE WHEN bio       ILIKE ANY($2) THEN 0.2 ELSE 0 END
           + CASE WHEN address   ILIKE ANY($2) THEN 0.1 ELSE 0 END) AS score
       FROM contacts
      WHERE user_id = $1 AND is_private = false
        AND (job_title ILIKE ANY($2) OR company ILIKE ANY($2) OR bio ILIKE ANY($2) OR address ILIKE ANY($2))
      ORDER BY score DESC
      LIMIT $3`,
    [userId, terms, FALLBACK_LIMIT]
  );
  return rows.map(r => ({ contactId: r.id, score: Math.min(1, Number(r.score) || 0.3) }));
}

async function fallbackGroup(memberUserIds, parsed) {
  if (!memberUserIds.length) return [];
  const terms = ilikeFilter(parsed);
  if (!terms.length) return [];
  const { rows } = await db.query(
    `SELECT id, user_id,
            (CASE WHEN job_title ILIKE ANY($2) THEN 0.4 ELSE 0 END
           + CASE WHEN company   ILIKE ANY($2) THEN 0.3 ELSE 0 END
           + CASE WHEN bio       ILIKE ANY($2) THEN 0.2 ELSE 0 END
           + CASE WHEN address   ILIKE ANY($2) THEN 0.1 ELSE 0 END) AS score
       FROM contacts
      WHERE user_id = ANY($1) AND is_private = false
        AND (job_title ILIKE ANY($2) OR company ILIKE ANY($2) OR bio ILIKE ANY($2) OR address ILIKE ANY($2))
      ORDER BY score DESC
      LIMIT $3`,
    [memberUserIds, terms, FALLBACK_LIMIT]
  );
  return rows.map(r => ({ contactId: r.id, ownerId: r.user_id, score: Math.min(1, Number(r.score) || 0.3) }));
}

async function gatherGroupMemberIds(userId) {
  const { rows } = await db.query(
    `SELECT DISTINCT gm2.user_id
       FROM group_members gm
       JOIN group_members gm2 ON gm2.group_id = gm.group_id
      WHERE gm.user_id = $1
        AND gm.consent_given_at IS NOT NULL
        AND gm2.consent_given_at IS NOT NULL
        AND gm2.user_id <> $1`,
    [userId]
  );
  return rows.map(r => r.user_id);
}

async function hydrateContacts(contactIds) {
  if (!contactIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT
        c.id, c.user_id, c.full_name, c.first_name, c.last_name,
        c.job_title, c.company, c.bio, c.photo_url, c.address,
        c.linkedin_url, c.skills, c.is_private,
        c.connection_tier, c.confidence_score, c.last_contacted,
        u.full_name AS owner_name, u.id AS owner_id, u.profile_picture AS owner_photo
       FROM contacts c
       JOIN users u ON u.id = c.user_id
      WHERE c.id = ANY($1) AND c.is_private = false`,
    [contactIds]
  );
  const map = new Map();
  for (const r of rows) map.set(r.id, r);
  return map;
}

async function runScan(scanId) {
  const start = Date.now();

  await db.query(
    `UPDATE scans SET status='running', started_at=NOW() WHERE id=$1`,
    [scanId]
  );

  try {
    const { rows: scanRows } = await db.query(
      `SELECT id, user_id, query FROM scans WHERE id = $1`, [scanId]
    );
    if (!scanRows.length) throw new Error(`scan ${scanId} not found`);
    const scan = scanRows[0];

    // 1. Parse the natural-language query.
    const parsed = await parseScanQuery(scan.query);
    const queryText = parsed.query || scan.query;

    // 2. Build scope: own user + every co-member across user's groups.
    const groupMemberIds = await gatherGroupMemberIds(scan.user_id);
    const scope = { include_own: true, group_member_count: groupMemberIds.length };

    // 3. Retrieval — Pinecone preferred, ILIKE fallback per surface.
    const usePinecone = !!(process.env.PINECONE_API_KEY && process.env.GEMINI_API_KEY);

    const [personalMatches, groupMatches] = await Promise.all([
      (async () => {
        if (usePinecone) {
          try { return await pineconeService.searchPersonal(scan.user_id, queryText, PER_USER_TOPK); }
          catch (e) { logger.warn(`[scan] personal pinecone failed: ${e.message}`); }
        }
        return await fallbackPersonal(scan.user_id, parsed);
      })(),
      (async () => {
        if (!groupMemberIds.length) return [];
        if (usePinecone) {
          try { return await pineconeService.searchGroup(groupMemberIds, queryText, PER_USER_TOPK); }
          catch (e) { logger.warn(`[scan] group pinecone failed: ${e.message}`); }
        }
        return await fallbackGroup(groupMemberIds, parsed);
      })(),
    ]);

    const ownIds   = personalMatches.map(m => m.contactId);
    const groupIds = groupMatches.map(m => m.contactId);
    const hydrated = await hydrateContacts([...new Set([...ownIds, ...groupIds])]);

    // 4. Build candidate rows. Key on contactId; if a contact appears in both
    //    personal and group results, prefer the personal record (1st-degree).
    const candidates = new Map();

    for (const m of personalMatches) {
      const c = hydrated.get(m.contactId);
      if (!c) continue;
      candidates.set(m.contactId, {
        contact_id:   c.id,
        full_name:    c.full_name,
        job_title:    c.job_title,
        company:      c.company,
        photo_url:    c.photo_url,
        linkedin_url: c.linkedin_url,
        address:      c.address,
        bio:          c.bio,
        skills:       c.skills,
        last_contacted: c.last_contacted,
        connection_tier: c.connection_tier,
        confidence_score: c.confidence_score,
        vector_score: m.score,
        degree:       1,
        bridge:       null,        // self = no separate bridge
      });
    }

    for (const m of groupMatches) {
      if (candidates.has(m.contactId)) continue;
      const c = hydrated.get(m.contactId);
      if (!c) continue;
      // Skip results owned by the requester themselves (already covered above).
      if (c.user_id === scan.user_id) continue;
      candidates.set(m.contactId, {
        contact_id:   c.id,
        full_name:    c.full_name,
        job_title:    c.job_title,
        company:      c.company,
        photo_url:    c.photo_url,
        // Privacy: don't surface email/phone for someone else's contact.
        linkedin_url: null,
        address:      c.address ? c.address.split(',').slice(-1)[0]?.trim() : null,
        bio:          null,
        skills:       null,
        last_contacted: null,
        vector_score: m.score,
        degree:       2,
        bridge: {
          owner_id:   c.owner_id,
          owner_name: c.owner_name,
          owner_photo: c.owner_photo,
          confidence_score: c.confidence_score,
          connection_tier: c.connection_tier,
        },
      });
    }

    // 5. Rank.
    const ranked = rankResults(Array.from(candidates.values()), parsed).slice(0, TOP_N);

    const ms = Date.now() - start;
    await db.query(
      `UPDATE scans
          SET status='completed',
              parsed=$2,
              scope=$3,
              results=$4,
              result_count=$5,
              completed_at=NOW(),
              duration_ms=$6
        WHERE id=$1`,
      [scanId, JSON.stringify(parsed), JSON.stringify(scope), JSON.stringify(ranked), ranked.length, ms]
    );

    logger.info(`[scan] ${scanId} done in ${ms}ms — ${ranked.length} results (${ownIds.length} own / ${groupIds.length} group raw)`);
    return { ok: true, count: ranked.length, ms };
  } catch (err) {
    logger.error(`[scan] ${scanId} failed: ${err.message}`);
    await db.query(
      `UPDATE scans SET status='failed', error=$2, completed_at=NOW(), duration_ms=$3 WHERE id=$1`,
      [scanId, String(err.message || err), Date.now() - start]
    );
    throw err;
  }
}

module.exports = { runScan };
