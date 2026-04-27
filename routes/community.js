/**
 * Community user-facing routes (KYC submit / status).
 *
 * POST /api/community/kyc     — submit a KYC application
 * GET  /api/community/kyc/me  — my latest KYC status (or 404 if never submitted)
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const db = require('../db');

function deriveDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().trim() || null;
}

router.post('/kyc', authenticateToken, async (req, res) => {
  const {
    full_legal_name,
    org_name,
    org_email,
    org_role,
    id_document_url,
    proof_of_org_url,
    notes,
  } = req.body || {};

  if (!full_legal_name || !org_name || !org_email) {
    return res.status(400).json({
      success: false,
      error: 'full_legal_name, org_name, and org_email are required',
    });
  }

  const org_domain = deriveDomain(org_email);
  if (!org_domain) {
    return res.status(400).json({ success: false, error: 'Invalid org_email' });
  }

  // Block duplicate active submission. The unique partial index also enforces
  // this at the DB level — handle the race cleanly.
  try {
    const { rows } = await db.query(
      `INSERT INTO community_kyc_submissions
         (user_id, full_legal_name, org_name, org_email, org_domain, org_role,
          id_document_url, proof_of_org_url, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        req.userId,
        full_legal_name,
        org_name,
        org_email,
        org_domain,
        org_role || null,
        id_document_url || null,
        proof_of_org_url || null,
        notes || null,
      ]
    );
    return res.status(201).json({ success: true, submission: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        error: 'You already have a pending or approved KYC submission',
      });
    }
    throw err;
  }
});

router.get('/kyc/me', authenticateToken, async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM community_kyc_submissions
      WHERE user_id = $1
      ORDER BY submitted_at DESC
      LIMIT 1`,
    [req.userId]
  );
  if (!rows.length) {
    return res.status(404).json({ success: false, error: 'No KYC submission found' });
  }
  res.json({ success: true, submission: rows[0] });
});

module.exports = router;
