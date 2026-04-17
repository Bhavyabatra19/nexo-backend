/**
 * Network-of-Network Scan
 *
 * When a member joins a group or uploads contacts, this service:
 * 1. Scans for overlaps with other members' contacts (TrueCaller-style)
 * 2. Builds group_contacts canonical records
 * 3. Boosts confidence scores for shared contacts
 * 4. Assigns confidence tiers: low (scan only) → high (manual/messages)
 *
 * Privacy rule: overlap detection uses linkedin_url and email only.
 * Names/notes from other members are NEVER accessed.
 */

const db = require('../db');
const logger = require('../logger');
const { recomputeConfidence } = require('./confidence');

/**
 * Run the full network scan for a user within a group.
 * Called after member joins or after LinkedIn upload completes.
 */
async function runNetworkScan(userId, groupId) {
  logger.info(`[NetworkScan] Starting scan for user ${userId} in group ${groupId}`);

  // Get all group members except this user
  const { rows: members } = await db.query(
    `SELECT user_id FROM group_members WHERE group_id = $1 AND user_id != $2`,
    [groupId, userId]
  );
  if (!members.length) return { overlaps: 0, newCanonicals: 0 };

  const memberIds = members.map(m => m.user_id);

  // Get this user's contacts
  const { rows: myContacts } = await db.query(
    `SELECT id, linkedin_url, email, full_name, company, job_title, connection_tier, confidence_score
     FROM contacts WHERE user_id = $1 AND is_private = false`,
    [userId]
  );

  let overlapsFound = 0;
  let newCanonicals = 0;

  for (const myContact of myContacts) {
    // Find matching contacts from other group members
    // Match priority: linkedin_url (strongest) → email → name+company
    const { rows: matches } = await db.query(`
      SELECT c.id, c.user_id, c.linkedin_url, c.email, c.full_name,
             c.job_title, c.company, c.connection_tier, c.confidence_score
      FROM contacts c
      WHERE c.user_id = ANY($1)
        AND c.is_private = false
        AND (
          (c.linkedin_url IS NOT NULL AND c.linkedin_url = $2)
          OR (c.email IS NOT NULL AND c.email = $3 AND $3 IS NOT NULL)
        )
    `, [memberIds, myContact.linkedin_url, myContact.email]);

    for (const match of matches) {
      const matchField = match.linkedin_url && match.linkedin_url === myContact.linkedin_url
        ? 'linkedin_url'
        : 'email';
      const matchValue = matchField === 'linkedin_url' ? myContact.linkedin_url : myContact.email;

      // Record overlap (both directions, lower id first to avoid duplicates)
      const [idA, idB] = [myContact.id, match.id].sort();
      await db.query(`
        INSERT INTO network_overlaps
          (group_id, contact_a_id, contact_b_id, match_field, match_value)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (group_id, contact_a_id, contact_b_id) DO NOTHING
      `, [groupId, idA, idB, matchField, matchValue]);

      overlapsFound++;

      // Recompute confidence for both contacts (network boost)
      await recomputeConfidence(myContact.id);
      await recomputeConfidence(match.id);
    }

    // Upsert group_contacts canonical record
    const allMatchIds = [myContact.id, ...matches.map(m => m.id)];
    const allTiers = [myContact.connection_tier, ...matches.map(m => m.connection_tier)];
    const highestTier = allTiers.includes('close') ? 'close'
      : allTiers.includes('acquaintance') ? 'acquaintance' : 'social';
    const avgConfidence = (
      [myContact.confidence_score, ...matches.map(m => m.confidence_score)]
        .reduce((a, b) => a + (b || 0), 0) / allMatchIds.length
    );

    if (myContact.linkedin_url) {
      const existing = await db.query(
        `SELECT id FROM group_contacts WHERE group_id = $1 AND linkedin_url = $2`,
        [groupId, myContact.linkedin_url]
      );
      if (existing.rows.length) {
        await db.query(`
          UPDATE group_contacts SET
            member_contact_ids   = $1,
            known_by_count       = $2,
            aggregate_confidence = $3,
            highest_tier         = $4,
            updated_at           = NOW()
          WHERE id = $5
        `, [allMatchIds, allMatchIds.length, avgConfidence, highestTier, existing.rows[0].id]);
      } else {
        await db.query(`
          INSERT INTO group_contacts
            (group_id, canonical_name, canonical_title, canonical_company,
             linkedin_url, member_contact_ids, known_by_count, aggregate_confidence, highest_tier)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          groupId, myContact.full_name, myContact.job_title, myContact.company,
          myContact.linkedin_url, allMatchIds, allMatchIds.length, avgConfidence, highestTier
        ]);
        newCanonicals++;
      }
    }
  }

  logger.info(`[NetworkScan] Done: ${overlapsFound} overlaps, ${newCanonicals} new canonicals`);
  return { overlaps: overlapsFound, newCanonicals };
}

/**
 * Get the intro path between a requester and a target contact within a group.
 * Returns all possible paths ranked by strength.
 */
async function findIntroPaths(requesterId, targetContactId, groupId) {
  // Find all group members who know the target contact
  const { rows: connectors } = await db.query(`
    SELECT
      c.id as contact_id,
      c.user_id as connector_user_id,
      u.full_name as connector_name,
      c.connection_tier as connector_tier_with_target
    FROM contacts c
    JOIN users u ON u.id = c.user_id
    JOIN group_members gm ON gm.user_id = c.user_id AND gm.group_id = $2
    WHERE c.id = $1 OR (
      c.linkedin_url = (SELECT linkedin_url FROM contacts WHERE id = $1)
      AND c.linkedin_url IS NOT NULL
    )
    AND c.user_id != $3
  `, [targetContactId, groupId, requesterId]);

  // For each connector, determine the requester's tier with that connector
  const paths = [];
  for (const conn of connectors) {
    const { rows: myRelation } = await db.query(`
      SELECT connection_tier FROM contacts
      WHERE user_id = $1 AND (
        email = (SELECT email FROM users WHERE id = $2)
        OR linkedin_url = (SELECT linkedin_url FROM contacts
                          WHERE user_id = $2 ORDER BY confidence_score DESC LIMIT 1)
      )
      LIMIT 1
    `, [requesterId, conn.connector_user_id]);

    const requesterTierWithConnector = myRelation[0]?.connection_tier || 'social';

    paths.push({
      connectorId:   conn.connector_user_id,
      connectorName: conn.connector_name,
      requesterTierWithConnector,
      connectorTierWithTarget: conn.connector_tier_with_target,
      pathLabel: `${requesterTierWithConnector} → ${conn.connector_tier_with_target}`,
    });
  }

  // Sort by path strength
  const tierRank = { close: 3, acquaintance: 2, social: 1 };
  paths.sort((a, b) =>
    (tierRank[b.requesterTierWithConnector] + tierRank[b.connectorTierWithTarget]) -
    (tierRank[a.requesterTierWithConnector] + tierRank[a.connectorTierWithTarget])
  );

  return paths;
}

module.exports = { runNetworkScan, findIntroPaths };
