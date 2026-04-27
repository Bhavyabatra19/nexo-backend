/**
 * Platform-admin routes. Gated by requirePlatformAdmin (users.is_platform_admin).
 *
 * GET  /api/admin/kyc/pending        — review queue
 * GET  /api/admin/kyc/:id            — submission detail
 * POST /api/admin/kyc/:id/approve    — approve submission
 * POST /api/admin/kyc/:id/reject     — reject submission (with reason)
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requirePlatformAdmin } = require('../middleware/platformAdmin');
const db = require('../db');

router.use(authenticateToken, requirePlatformAdmin);

router.get('/kyc/pending', async (req, res) => {
  const { rows } = await db.query(
    `SELECT s.*, u.email AS user_email, u.full_name AS user_full_name
       FROM community_kyc_submissions s
       JOIN users u ON u.id = s.user_id
      WHERE s.status = 'pending'
      ORDER BY s.submitted_at ASC`
  );
  res.json({ success: true, submissions: rows });
});

router.get('/kyc/:id', async (req, res) => {
  const { rows } = await db.query(
    `SELECT s.*, u.email AS user_email, u.full_name AS user_full_name
       FROM community_kyc_submissions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, submission: rows[0] });
});

router.post('/kyc/:id/approve', async (req, res) => {
  const { rows } = await db.query(
    `UPDATE community_kyc_submissions
        SET status = 'approved',
            reviewed_at = NOW(),
            reviewed_by = $2,
            rejection_reason = NULL
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [req.params.id, req.userId]
  );
  if (!rows.length) {
    return res.status(409).json({ success: false, error: 'Submission not pending' });
  }
  res.json({ success: true, submission: rows[0] });
});

router.post('/kyc/:id/reject', async (req, res) => {
  const reason = (req.body?.reason || '').trim();
  if (!reason) {
    return res.status(400).json({ success: false, error: 'reason is required' });
  }
  const { rows } = await db.query(
    `UPDATE community_kyc_submissions
        SET status = 'rejected',
            reviewed_at = NOW(),
            reviewed_by = $2,
            rejection_reason = $3
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [req.params.id, req.userId, reason]
  );
  if (!rows.length) {
    return res.status(409).json({ success: false, error: 'Submission not pending' });
  }
  res.json({ success: true, submission: rows[0] });
});

module.exports = router;
