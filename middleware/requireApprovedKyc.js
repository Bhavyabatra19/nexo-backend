const db = require('../db');

/**
 * Gate community-creation routes behind an approved KYC submission.
 * Attaches req.kycSubmissionId so the handler can store the FK on groups.
 */
async function requireApprovedKyc(req, res, next) {
  const { rows } = await db.query(
    `SELECT id FROM community_kyc_submissions
      WHERE user_id = $1 AND status = 'approved'
      ORDER BY reviewed_at DESC NULLS LAST
      LIMIT 1`,
    [req.userId]
  );
  if (!rows.length) {
    return res.status(403).json({
      success: false,
      error: 'Community creation requires an approved KYC submission',
      code: 'KYC_REQUIRED',
    });
  }
  req.kycSubmissionId = rows[0].id;
  next();
}

module.exports = { requireApprovedKyc };
