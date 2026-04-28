/**
 * Community Groups Routes
 * POST   /api/groups                          — create group (KYC-gated)
 * GET    /api/groups                          — list my groups
 * GET    /api/groups/discoverable             — communities I'm eligible to join
 * GET    /api/groups/:id                      — group details + stats
 * POST   /api/groups/join/:code               — join via invite link
 * POST   /api/groups/:id/join                 — request to join (rule-matched or pending)
 * GET    /api/groups/:id/members              — list members
 * DELETE /api/groups/:id/members/:userId      — remove member (admin)
 * POST   /api/groups/:id/consent              — give data sharing consent
 * GET    /api/groups/:id/rules                — list membership rules (members)
 * POST   /api/groups/:id/rules                — add rule (admin)
 * DELETE /api/groups/:id/rules/:ruleId        — remove rule (admin)
 * GET    /api/groups/:id/join-requests        — pending requests (admin)
 * POST   /api/groups/:id/join-requests/:reqId/approve — approve request (admin)
 * POST   /api/groups/:id/join-requests/:reqId/reject  — reject request (admin)
 */

const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requireApprovedKyc } = require('../middleware/requireApprovedKyc');
const db = require('../db');
const { networkScanQueue } = require('../workers/queues');
const logger = require('../logger');

// Resolve email domain for the requesting user. Falls back to parsing
// req.user.email if org_domain wasn't backfilled (defence in depth).
function userDomain(req) {
  if (req.user?.org_domain) return req.user.org_domain;
  const email = req.user?.email;
  if (!email) return null;
  const at = email.indexOf('@');
  return at < 0 ? null : email.slice(at + 1).toLowerCase();
}

// Match a single rule against the requesting user's email/domain. Currently
// supports email_domain and email_pattern (glob with * wildcard); org_id is
// reserved for a future user.org_id field and never matches today.
function ruleMatches(rule, { domain, email }) {
  if (rule.rule_type === 'email_domain') {
    return domain && rule.pattern.toLowerCase() === domain;
  }
  if (rule.rule_type === 'email_pattern') {
    if (!email) return false;
    const re = new RegExp(
      '^' + rule.pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    );
    return re.test(email.toLowerCase());
  }
  return false;
}

async function isGroupAdmin(groupId, userId) {
  const { rows } = await db.query(
    `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`,
    [groupId, userId]
  );
  return rows.length > 0 && rows[0].role === 'admin';
}

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
// Gated on approved KYC. requireApprovedKyc populates req.kycSubmissionId.
router.post('/', authenticateToken, requireApprovedKyc, async (req, res) => {
  const { name, description, logo_url } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'name is required' });

  const invite_code = generateInviteCode(name);

  const { rows } = await db.query(`
    INSERT INTO groups (name, description, admin_user_id, invite_code, logo_url, kyc_submission_id)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [name, description, req.userId, invite_code, logo_url, req.kycSubmissionId]);

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

// ── Discoverable: communities I'm eligible to auto-join or request to join ────
// Listed before /:id so the literal path doesn't get captured as an :id.
router.get('/discoverable', authenticateToken, async (req, res) => {
  const domain = userDomain(req);
  const email  = req.user?.email || null;
  if (!domain) return res.json({ success: true, communities: [] });

  // Pull every active group with at least one rule the user matches, plus the
  // user's existing membership/request state so the UI can render correct CTAs.
  const { rows } = await db.query(`
    SELECT
      g.id, g.name, g.description, g.logo_url, g.invite_code,
      (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count,
      (
        SELECT json_agg(r.*) FROM group_membership_rules r
         WHERE r.group_id = g.id AND r.rule_type IN ('email_domain','email_pattern')
      ) AS rules,
      gm.role AS my_role,
      gjr.status AS my_request_status
    FROM groups g
    LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $1
    LEFT JOIN group_join_requests gjr ON gjr.group_id = g.id AND gjr.user_id = $1
    WHERE g.is_active = true
      AND EXISTS (
        SELECT 1 FROM group_membership_rules r
         WHERE r.group_id = g.id AND r.rule_type IN ('email_domain','email_pattern')
      )
    ORDER BY member_count DESC NULLS LAST, g.created_at DESC
  `, [req.userId]);

  const communities = rows
    .map((g) => {
      const matched = (g.rules || []).find((r) => ruleMatches(r, { domain, email }));
      if (!matched) return null;
      return {
        id: g.id,
        name: g.name,
        description: g.description,
        logo_url: g.logo_url,
        member_count: Number(g.member_count) || 0,
        my_role: g.my_role,
        my_request_status: g.my_request_status,
        match: { rule_id: matched.id, rule_type: matched.rule_type, pattern: matched.pattern, auto_approve: matched.auto_approve },
      };
    })
    .filter(Boolean);

  res.json({ success: true, communities });
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

// ── Request to Join (rule-matched auto-join, or pending request) ──────────────
router.post('/:id/join', authenticateToken, async (req, res) => {
  const domain = userDomain(req);
  const email  = req.user?.email || null;

  const { rows: groups } = await db.query(
    `SELECT * FROM groups WHERE id = $1 AND is_active = true`,
    [req.params.id]
  );
  if (!groups.length) return res.status(404).json({ success: false, error: 'Group not found' });

  // Already a member?
  const { rows: existing } = await db.query(
    `SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (existing.length) {
    return res.json({ success: true, alreadyMember: true });
  }

  // Find the highest-precedence matching rule. auto_approve=true wins so a
  // user who matches both an auto-approve and a manual rule gets auto-joined.
  const { rows: rules } = await db.query(
    `SELECT * FROM group_membership_rules WHERE group_id = $1`,
    [req.params.id]
  );
  const matches = rules.filter((r) => ruleMatches(r, { domain, email }));
  const autoMatch = matches.find((r) => r.auto_approve);
  const manualMatch = matches.find((r) => !r.auto_approve);

  if (autoMatch) {
    await db.query(
      `INSERT INTO group_members (group_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [req.params.id, req.userId]
    );
    return res.json({ success: true, joined: true, matched_rule_id: autoMatch.id, needsConsent: true });
  }

  if (manualMatch) {
    try {
      const { rows: reqRows } = await db.query(
        `INSERT INTO group_join_requests (group_id, user_id, matched_rule_id, message)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.params.id, req.userId, manualMatch.id, req.body?.message || null]
      );
      return res.json({ success: true, joined: false, request: reqRows[0] });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ success: false, error: 'Join request already exists' });
      }
      throw err;
    }
  }

  return res.status(403).json({
    success: false,
    error: 'You do not match any membership rule for this community',
    code: 'NO_RULE_MATCH',
  });
});

// ── Membership Rules ────────────────────────────────────────────────────────────
router.get('/:id/rules', authenticateToken, async (req, res) => {
  const { rows: m } = await db.query(
    `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!m.length) return res.status(403).json({ success: false, error: 'Not a member' });

  const { rows } = await db.query(
    `SELECT * FROM group_membership_rules WHERE group_id = $1 ORDER BY created_at`,
    [req.params.id]
  );
  res.json({ success: true, rules: rows });
});

router.post('/:id/rules', authenticateToken, async (req, res) => {
  if (!(await isGroupAdmin(req.params.id, req.userId))) {
    return res.status(403).json({ success: false, error: 'Admin only' });
  }
  const { rule_type = 'email_domain', pattern, auto_approve = true } = req.body || {};
  if (!pattern || typeof pattern !== 'string') {
    return res.status(400).json({ success: false, error: 'pattern is required' });
  }
  if (!['email_domain', 'email_pattern', 'org_id'].includes(rule_type)) {
    return res.status(400).json({ success: false, error: 'Invalid rule_type' });
  }
  const normalized = rule_type === 'email_domain' ? pattern.toLowerCase().trim() : pattern.trim();

  try {
    const { rows } = await db.query(
      `INSERT INTO group_membership_rules (group_id, rule_type, pattern, auto_approve, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.id, rule_type, normalized, !!auto_approve, req.userId]
    );
    res.status(201).json({ success: true, rule: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, error: 'Rule already exists' });
    }
    throw err;
  }
});

router.delete('/:id/rules/:ruleId', authenticateToken, async (req, res) => {
  if (!(await isGroupAdmin(req.params.id, req.userId))) {
    return res.status(403).json({ success: false, error: 'Admin only' });
  }
  await db.query(
    `DELETE FROM group_membership_rules WHERE id = $1 AND group_id = $2`,
    [req.params.ruleId, req.params.id]
  );
  res.json({ success: true });
});

// ── Pending Join Requests ───────────────────────────────────────────────────────
router.get('/:id/join-requests', authenticateToken, async (req, res) => {
  if (!(await isGroupAdmin(req.params.id, req.userId))) {
    return res.status(403).json({ success: false, error: 'Admin only' });
  }
  const { rows } = await db.query(`
    SELECT r.*, u.email AS user_email, u.full_name AS user_full_name, u.profile_picture
      FROM group_join_requests r
      JOIN users u ON u.id = r.user_id
     WHERE r.group_id = $1 AND r.status = 'pending'
     ORDER BY r.requested_at ASC
  `, [req.params.id]);
  res.json({ success: true, requests: rows });
});

router.post('/:id/join-requests/:reqId/approve', authenticateToken, async (req, res) => {
  if (!(await isGroupAdmin(req.params.id, req.userId))) {
    return res.status(403).json({ success: false, error: 'Admin only' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: reqRows } = await client.query(
      `UPDATE group_join_requests
          SET status = 'approved', decided_at = NOW(), decided_by = $3
        WHERE id = $1 AND group_id = $2 AND status = 'pending'
        RETURNING *`,
      [req.params.reqId, req.params.id, req.userId]
    );
    if (!reqRows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'Request not pending' });
    }
    await client.query(
      `INSERT INTO group_members (group_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [req.params.id, reqRows[0].user_id]
    );
    await client.query('COMMIT');
    res.json({ success: true, request: reqRows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.post('/:id/join-requests/:reqId/reject', authenticateToken, async (req, res) => {
  if (!(await isGroupAdmin(req.params.id, req.userId))) {
    return res.status(403).json({ success: false, error: 'Admin only' });
  }
  const { rows } = await db.query(
    `UPDATE group_join_requests
        SET status = 'rejected', decided_at = NOW(), decided_by = $3
      WHERE id = $1 AND group_id = $2 AND status = 'pending'
      RETURNING *`,
    [req.params.reqId, req.params.id, req.userId]
  );
  if (!rows.length) {
    return res.status(409).json({ success: false, error: 'Request not pending' });
  }
  res.json({ success: true, request: rows[0] });
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
