/**
 * Search Routes — the primary Nexo experience
 *
 * GET /api/search?q=...&scope=personal|group|all&group_id=...
 *
 * Scopes:
 *   personal  — user's own contacts only (fast, personal)
 *   group     — all members' non-private contacts in a group
 *   all       — across all groups user belongs to
 *
 * Ranking: semantic × confidence × tier × intro_path
 * Privacy: only name+title+company visible for other members' contacts
 */

const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');
const db = require('../db');
const pineconeService = require('../services/pineconeService');
const { computeRankingScore, computeIntroPathScore, confidenceLabel } = require('../services/confidence');
const { findIntroPaths } = require('../services/networkScan');
const logger = require('../logger');

router.get('/', authenticateToken, async (req, res) => {
  const { q, scope = 'personal', group_id } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ success: false, error: 'Query too short' });
  }

  const startTime = Date.now();

  try {
    let pineconeMatches = [];

    if (scope === 'personal') {
      pineconeMatches = await pineconeService.searchPersonal(req.userId, q, 30);
    } else if (scope === 'group' && group_id) {
      // Verify membership
      const { rows: membership } = await db.query(
        `SELECT user_id FROM group_members WHERE group_id = $1 AND consent_given_at IS NOT NULL`,
        [group_id]
      );
      if (!membership.some(m => m.user_id === req.userId)) {
        return res.status(403).json({ success: false, error: 'Not a consented member of this group' });
      }
      const memberIds = membership.map(m => m.user_id);
      pineconeMatches = await pineconeService.searchGroup(memberIds, q, 40);
    } else if (scope === 'all') {
      const { rows: myGroups } = await db.query(
        `SELECT DISTINCT gm2.user_id FROM group_members gm
         JOIN group_members gm2 ON gm2.group_id = gm.group_id
         WHERE gm.user_id = $1 AND gm.consent_given_at IS NOT NULL
           AND gm2.consent_given_at IS NOT NULL`,
        [req.userId]
      );
      const allMemberIds = [...new Set(myGroups.map(m => m.user_id))];
      pineconeMatches = await pineconeService.searchGroup(allMemberIds, q, 40);
    } else {
      return res.status(400).json({ success: false, error: 'Invalid scope or missing group_id' });
    }

    if (!pineconeMatches.length) {
      return res.json({ success: true, results: [], query: q, scope, elapsed_ms: Date.now() - startTime });
    }

    // Fetch full contact details for matched IDs
    const contactIds = pineconeMatches.map(m => m.contactId);
    const { rows: contacts } = await db.query(`
      SELECT
        c.id, c.user_id, c.full_name, c.first_name, c.last_name,
        c.job_title, c.company, c.bio, c.photo_url, c.address,
        c.email, c.phone, c.linkedin_url,
        c.connection_tier, c.confidence_score, c.confidence_breakdown,
        c.enrichment_status, c.skills, c.is_private,
        c.notes, c.last_contacted,
        u.full_name AS owner_name,
        u.id AS owner_id
      FROM contacts c
      JOIN users u ON u.id = c.user_id
      WHERE c.id = ANY($1) AND c.is_private = false
    `, [contactIds]);

    // Build result objects, applying privacy mask for non-owned contacts
    const results = await Promise.all(contacts.map(async (contact) => {
      const match = pineconeMatches.find(m => m.contactId === contact.id);
      if (!match) return null;

      const isOwn = contact.user_id === req.userId;

      // Fetch intro paths for group results
      let introPaths = [];
      if (!isOwn && (scope === 'group' || scope === 'all')) {
        introPaths = await findIntroPaths(req.userId, contact.id, group_id || null);
      }

      const bestPath = introPaths[0] || null;
      const introPathScore = bestPath
        ? computeIntroPathScore(bestPath.requesterTierWithConnector, bestPath.connectorTierWithTarget)
        : 1.0;

      const rankingScore = computeRankingScore(match.score, contact, introPathScore);

      // Determine what fields to show
      const base = {
        id:               contact.id,
        full_name:        contact.full_name,
        job_title:        contact.job_title,
        company:          contact.company,
        photo_url:        contact.photo_url,
        connection_tier:  contact.connection_tier,
        confidence_score: contact.confidence_score,
        confidence_label: confidenceLabel(contact.confidence_score),
        enrichment_status:contact.enrichment_status,
        semantic_score:   match.score,
        ranking_score:    rankingScore,
        is_own:           isOwn,
      };

      if (isOwn) {
        // Full details for own contacts
        Object.assign(base, {
          email:        contact.email,
          phone:        contact.phone,
          linkedin_url: contact.linkedin_url,
          bio:          contact.bio,
          notes:        contact.notes,
          skills:       contact.skills,
          address:      contact.address,
          last_contacted: contact.last_contacted,
          confidence_breakdown: contact.confidence_breakdown,
        });
      } else {
        // Group-visible only: name + title + company + tier of connector
        base.via = {
          owner_id:   contact.owner_id,
          owner_name: contact.owner_name,
        };
        base.intro_paths  = introPaths.slice(0, 3); // top 3 paths
        base.intro_quality = bestPath
          ? (introPathScore >= 1.5 ? 'strong' : introPathScore >= 1.0 ? 'medium' : 'weak')
          : 'none';
        // Partial location — public info only
        if (contact.address) base.location = contact.address.split(',').slice(-1)[0]?.trim();
      }

      return base;
    }));

    const sorted = results
      .filter(Boolean)
      .sort((a, b) => b.ranking_score - a.ranking_score);

    // Log search event
    if (scope !== 'personal' && group_id) {
      db.query(
        `INSERT INTO group_search_events (group_id, user_id, query, result_count, scope)
         VALUES ($1, $2, $3, $4, $5)`,
        [group_id, req.userId, q, sorted.length, scope]
      ).catch(() => {});
    }

    res.json({
      success:    true,
      results:    sorted.slice(0, 20),
      total:      sorted.length,
      query:      q,
      scope,
      elapsed_ms: Date.now() - startTime,
    });

  } catch (err) {
    logger.error('[Search] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
