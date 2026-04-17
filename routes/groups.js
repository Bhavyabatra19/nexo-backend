/**
 * Community Groups Routes
 * POST /api/groups              — create group (admin)
 * GET  /api/groups              — list my groups
 * GET  /api/groups/:id          — group details + stats
 * POST /api/groups/join/:code   — join via invite link
 * GET  /api/groups/:id/members  — list members
 * DELETE /api/groups/:id/members/:userId — remove member (admin)
 * POST /api/groups/:id/consent  — give data sharing consent
 */

const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');
const db = require('../db');
const { networkScanQueue } = require('../workers/queues');
const logger = require('../logger');

// Generate a URL-friendly invite code
function generateInviteCode(name) {
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 30);
  const rand = Math.random().toString(36).substring(2, 8);
  return `${slug}-${rand}`;
}

// ── Create Group ─────────────────────────────────────────────────────────────
router.post('/', authenticateToken, async (req, res) => {
  const { name, description, logo_url } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'name is required' });

  const invite_code = generateInviteCode(name);

  const { rows } = await db.query(`
    INSERT INTO groups (name, description, admin_user_id, invite_code, logo_url)
    VALUES ($1, $2, $3, $4, $5) RETURNING *
  `, [name, description, req.userId, invite_code, logo_url]);

  const group = rows[0];

  // Admin is automatically first member with consent
  await db.query(`
    INSERT INTO group_members (group_id, user_id, role, consent_given_at)
    VALUES ($1, $2, 'admin', NOW())
  `, [group.id, req.userId]);

  res.json({
    success:    true,
    group,
    invite_url: `${process.env.FRONTEND_URL || 'https://nexo.app'}/join/${invite_code}`,
  });
});

// ── List My Groups ────────────────────────────────────────────────────────────
router.get('/', authenticateToken, async (req, res) => {
  const { rows } = await db.query(`
    SELECT g.*, gm.role, gm.joined_at,
      (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
    FROM groups g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.user_id = $1 AND g.is_active = true
    ORDER BY gm.joined_at DESC
  `, [req.userId]);

  res.json({ success: true, groups: rows });
});

// ── Group Details + Stats ─────────────────────────────────────────────────────
router.get('/:id', authenticateToken, async (req, res) => {
  // Must be a member
  const { rows: membership } = await db.query(
    `SELECT * FROM group_members WHERE group_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!membership.length) return res.status(403).json({ success: false, error: 'Not a member' });

  const { rows: group } = await db.query(
    `SELECT g.*, u.full_name as admin_name FROM groups g JOIN users u ON u.id = g.admin_user_id WHERE g.id = $1`,
    [req.params.id]
  );
  if (!group.length) return res.status(404).json({ success: false, error: 'Group not found' });

  const { rows: stats } = await db.query(`
    SELECT
      COUNT(DISTINCT gm.user_id) AS member_count,
      COUNT(DISTINCT gm.user_id) FILTER (WHERE gm.linkedin_uploaded = true) AS linkedin_members,
      COUNT(DISTINCT c.id) AS total_contacts,
      COUNT(DISTINCT c.id) FILTER (WHERE c.enrichment_status = 'enriched') AS enriched_contacts,
      COUNT(DISTINCT gse.id) FILTER (WHERE gse.searched_at > NOW() - INTERVAL '7 days') AS searches_this_week,
      COUNT(DISTINCT ir.id) FILTER (WHERE ir.requested_at > NOW() - INTERVAL '7 days') AS intros_this_week
    FROM groups g
    LEFT JOIN group_members gm ON gm.group_id = g.id
    LEFT JOIN contacts c ON c.user_id = gm.user_id AND c.is_private = false
    LEFT JOIN group_search_events gse ON gse.group_id = g.id
    LEFT JOIN introduction_requests ir ON ir.group_id = g.id
    WHERE g.id = $1
  `, [req.params.id]);

  res.json({
    success: true,
    group:   group[0],
    stats:   stats[0],
    myRole:  membership[0].role,
    consentGiven: !!membership[0].consent_given_at,
    inviteUrl: `${process.env.FRONTEND_URL || 'https://nexo.app'}/join/${group[0].invite_code}`,
  });
});

// ── Join Group via Invite Link ─────────────────────────────────────────────────
router.post('/join/:code', authenticateToken, async (req, res) => {
  const { rows: groups } = await db.query(
    `SELECT * FROM groups WHERE invite_code = $1 AND is_active = true`,
    [req.params.code]
  );
  if (!groups.length) return res.status(404).json({ success: false, error: 'Invalid invite link' });

  const group = groups[0];

  // Already a member?
  const { rows: existing } = await db.query(
    `SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2`,
    [group.id, req.userId]
  );
  if (existing.length) {
    return res.json({ success: true, group, alreadyMember: true });
  }

  // Join without consent yet (consent is separate step)
  await db.query(`
    INSERT INTO group_members (group_id, user_id, role)
    VALUES ($1, $2, 'member')
  `, [group.id, req.userId]);

  res.json({
    success:    true,
    group,
    needsConsent: true,
    message:    'Joined successfully. Please give consent to activate network search.',
  });
});

// ── Give Consent ────────────────────────────────────────────────────────────────
router.post('/:id/consent', authenticateToken, async (req, res) => {
  await db.query(`
    UPDATE group_members SET consent_given_at = NOW()
    WHERE group_id = $1 AND user_id = $2
  `, [req.params.id, req.userId]);

  // Trigger network scan for this member
  await networkScanQueue.add('scan', { userId: req.userId, groupId: req.params.id }, {
    priority: 5,
    attempts: 2,
  });

  res.json({ success: true, message: 'Consent recorded. Network scan started.' });
});

// ── List Members ────────────────────────────────────────────────────────────────
router.get('/:id/members', authenticateToken, async (req, res) => {
  const { rows: membership } = await db.query(
    `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!membership.length) return res.status(403).json({ success: false, error: 'Not a member' });

  const { rows } = await db.query(`
    SELECT
      u.id, u.full_name, u.email, u.profile_picture,
      gm.role, gm.joined_at, gm.linkedin_uploaded,
      gm.google_synced, gm.enrichment_coverage,
      gm.consent_given_at IS NOT NULL AS consent_given,
      COUNT(c.id) AS contact_count
    FROM group_members gm
    JOIN users u ON u.id = gm.user_id
    LEFT JOIN contacts c ON c.user_id = gm.user_id AND c.is_private = false
    WHERE gm.group_id = $1
    GROUP BY u.id, u.full_name, u.email, u.profile_picture,
             gm.role, gm.joined_at, gm.linkedin_uploaded,
             gm.google_synced, gm.enrichment_coverage, gm.consent_given_at
    ORDER BY gm.joined_at
  `, [req.params.id]);

  res.json({ success: true, members: rows });
});

// ── Remove Member (admin only) ───────────────────────────────────────────────────
router.delete('/:id/members/:memberId', authenticateToken, async (req, res) => {
  const { rows } = await db.query(
    `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!rows.length || rows[0].role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin only' });
  }

  await db.query(
    `DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`,
    [req.params.id, req.params.memberId]
  );

  res.json({ success: true });
});

module.exports = router;
