/**
 * Confidence Score Engine — TrueCaller-inspired
 *
 * Scores how well we *know* a contact based on data provenance.
 * Separate from connection_tier (trust). Confidence affects group search ranking.
 *
 * Rule: high-confidence sources (notes, messages) have HIGHER privacy protection.
 * They boost the owner's search quality but are NEVER exposed to the group.
 */

const db = require('../db');

const SOURCE_WEIGHTS = {
  google_contacts_sync:     0.10,
  linkedin_csv_connection:  0.25,
  proxycurl_enriched:       0.15,
  scrapingdog_enriched:     0.10,
  linkedin_messages_parsed: 0.20,
  manual_note:              0.15,
  calendar_meeting:         0.10,
  voice_note:               0.08,
  chrome_extension:         0.08,
  additional_member_knows:  0.05,   // per extra member, max 4 (→ +0.20)
};

const TIER_SEARCH_BOOST = {
  close:        1.5,
  acquaintance: 1.2,
  social:       1.0,
};

/**
 * Compute and persist confidence score for a single contact.
 * Called whenever a new data point is added to the contact.
 */
async function recomputeConfidence(contactId) {
  const { rows } = await db.query(`
    SELECT
      c.source,
      c.linkedin_url,
      c.enrichment_status,
      c.enrichment_provider,
      c.connection_tier,
      c.last_contacted,
      c.custom_fields,
      (SELECT COUNT(*) FROM notes WHERE contact_id = c.id)          AS note_count,
      (SELECT COUNT(*) FROM calendar_events
         WHERE $1::uuid = ANY(
           SELECT (attendee->>'contactId')::uuid
           FROM jsonb_array_elements(attendees) attendee
         ))                                                           AS meeting_count,
      (SELECT COUNT(*) FROM linkedin_messages WHERE contact_id = c.id) AS msg_record_count,
      (SELECT COUNT(DISTINCT oc.user_id)
         FROM contacts oc
         WHERE oc.linkedin_url = c.linkedin_url
           AND oc.linkedin_url IS NOT NULL
           AND oc.user_id != c.user_id)                              AS other_members_know
    FROM contacts c
    WHERE c.id = $1
  `, [contactId]);

  if (!rows.length) return 0;

  const s = rows[0];
  let score = 0;
  const breakdown = {};

  // Source weights
  if (s.source === 'google' || s.source === 'google_sync') {
    score += SOURCE_WEIGHTS.google_contacts_sync;
    breakdown.google_contacts_sync = SOURCE_WEIGHTS.google_contacts_sync;
  }

  if (s.linkedin_url && (s.source === 'linkedin' || s.source === 'linkedin_csv')) {
    score += SOURCE_WEIGHTS.linkedin_csv_connection;
    breakdown.linkedin_csv_connection = SOURCE_WEIGHTS.linkedin_csv_connection;
  }

  if (s.linkedin_url && s.source === 'chrome_extension') {
    score += SOURCE_WEIGHTS.chrome_extension;
    breakdown.chrome_extension = SOURCE_WEIGHTS.chrome_extension;
  }

  if (s.enrichment_status === 'enriched') {
    if (s.enrichment_provider === 'proxycurl') {
      score += SOURCE_WEIGHTS.proxycurl_enriched;
      breakdown.proxycurl_enriched = SOURCE_WEIGHTS.proxycurl_enriched;
    } else {
      score += SOURCE_WEIGHTS.scrapingdog_enriched;
      breakdown.scrapingdog_enriched = SOURCE_WEIGHTS.scrapingdog_enriched;
    }
  }

  if (parseInt(s.msg_record_count) > 0) {
    score += SOURCE_WEIGHTS.linkedin_messages_parsed;
    breakdown.linkedin_messages_parsed = SOURCE_WEIGHTS.linkedin_messages_parsed;
  }

  if (parseInt(s.note_count) > 0) {
    score += SOURCE_WEIGHTS.manual_note;
    breakdown.manual_note = SOURCE_WEIGHTS.manual_note;
  }

  if (parseInt(s.meeting_count) > 0) {
    score += SOURCE_WEIGHTS.calendar_meeting;
    breakdown.calendar_meeting = SOURCE_WEIGHTS.calendar_meeting;
  }

  // Network-of-network boost: other members who know this contact
  const extraMembers = Math.min(parseInt(s.other_members_know) || 0, 4);
  if (extraMembers > 0) {
    const boost = extraMembers * SOURCE_WEIGHTS.additional_member_knows;
    score += boost;
    breakdown.multiple_members_know = boost;
    breakdown.known_by_count = extraMembers + 1;
  }

  // Recency decay on final score
  let recencyFactor = 0.6; // default: no tracked interaction
  if (s.last_contacted) {
    const days = (Date.now() - new Date(s.last_contacted)) / 86400000;
    recencyFactor = days < 30 ? 1.0 : days < 90 ? 0.9 : days < 180 ? 0.8 : 0.7;
  }
  breakdown.recency_factor = recencyFactor;

  const finalScore = Math.min(parseFloat((score * recencyFactor).toFixed(4)), 1.0);

  await db.query(
    `UPDATE contacts SET confidence_score = $1, confidence_breakdown = $2 WHERE id = $3`,
    [finalScore, JSON.stringify(breakdown), contactId]
  );

  return finalScore;
}

/**
 * Batch recompute confidence for all contacts belonging to a user.
 * Called after LinkedIn upload or enrichment completes.
 */
async function recomputeUserConfidence(userId) {
  const { rows } = await db.query(
    `SELECT id FROM contacts WHERE user_id = $1`,
    [userId]
  );
  for (const row of rows) {
    await recomputeConfidence(row.id);
  }
  return rows.length;
}

/**
 * Compute ranking score for search results.
 * Used at query time, not stored.
 */
function computeRankingScore(semanticScore, contact, introPathScore = 1.0) {
  const tierBoost = TIER_SEARCH_BOOST[contact.connection_tier] || 1.0;
  return semanticScore * tierBoost * (contact.confidence_score || 0.1) * introPathScore;
}

/**
 * Intro path quality: how strong is the connection chain?
 * requesterTier = tier I have with the connector
 * connectorTier = tier connector has with the target contact
 */
function computeIntroPathScore(requesterTierWithConnector, connectorTierWithTarget) {
  const matrix = {
    'close-close':           2.0,
    'close-acquaintance':    1.5,
    'acquaintance-close':    1.3,
    'acquaintance-acquaintance': 1.0,
    'social-close':          0.8,
    'social-acquaintance':   0.7,
    'social-social':         0.5,
  };
  const key = `${requesterTierWithConnector || 'social'}-${connectorTierWithTarget || 'social'}`;
  return matrix[key] || 0.5;
}

function confidenceLabel(score) {
  if (score >= 0.75) return 'High';
  if (score >= 0.45) return 'Medium';
  if (score >= 0.20) return 'Low';
  return 'Minimal';
}

module.exports = {
  recomputeConfidence,
  recomputeUserConfidence,
  computeRankingScore,
  computeIntroPathScore,
  confidenceLabel,
  TIER_SEARCH_BOOST,
};
