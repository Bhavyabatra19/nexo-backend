const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { authenticateToken } = require('../middleware/auth');
const aiDeduplicationService = require('../services/aiDeduplicationService');
const AITokenService = require('../services/aiTokenService');
const db = require('../db');

// In-memory job store for active (processing) jobs only.
// Results are persisted to user_jobs table when done.
const dedupJobs = new Map();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of dedupJobs) {
    if (job.createdAt < cutoff) dedupJobs.delete(id);
  }
}, 5 * 60 * 1000);

/**
 * GET /api/dedup/status
 * Returns the current dedup job state for the authenticated user.
 * Used on page load to restore state across reloads / tab closes.
 *
 * Responses:
 *   { status: 'idle' }
 *   { status: 'processing', jobId, progress }
 *   { status: 'pending_review', duplicateDetails, summary }
 *   { status: 'idle', notice: '...' }  ← job was lost on server restart
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM user_jobs
       WHERE user_id = $1 AND job_type = 'dedup'
         AND status IN ('processing', 'pending_review')
       LIMIT 1`,
      [req.userId]
    );

    if (rows.length === 0) return res.json({ success: true, status: 'idle' });

    const row = rows[0];

    if (row.status === 'processing') {
      const inMemJob = row.job_id ? dedupJobs.get(row.job_id) : null;
      if (inMemJob) {
        return res.json({ success: true, status: 'processing', jobId: row.job_id, progress: inMemJob.progress });
      }
      // Server restarted — job is gone; clean up DB and return idle
      await db.query(`DELETE FROM user_jobs WHERE id = $1`, [row.id]);
      return res.json({
        success: true,
        status: 'idle',
        notice: 'The previous scan was interrupted by a server restart. Please start a new scan.',
      });
    }

    if (row.status === 'pending_review') {
      return res.json({
        success: true,
        status: 'pending_review',
        duplicateDetails: row.result?.duplicateDetails || [],
        summary: row.result?.summary || {},
      });
    }

    return res.json({ success: true, status: 'idle' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dedup/start
 * Kick off a global deduplication job across all user contacts.
 */
router.post('/start', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;

    // Check AI token limit before starting the dedup scan
    const isWithinLimit = await AITokenService.checkLimit(userId);
    if (!isWithinLimit) {
      return res.status(429).json({ success: false, error: 'Retry tomorrow you have consumed your daily ai usage limit' });
    }

    // Clear any previous job for this user (processing or pending_review)
    await db.query(
      `DELETE FROM user_jobs WHERE user_id = $1 AND job_type = 'dedup'`,
      [userId]
    );

    const jobId = crypto.randomUUID();
    dedupJobs.set(jobId, {
      status: 'processing',
      userId,
      progress: { current: 0, total: 0 },
      createdAt: Date.now(),
    });

    // Persist to DB immediately
    await db.query(
      `INSERT INTO user_jobs (user_id, job_type, status, job_id)
       VALUES ($1, 'dedup', 'processing', $2)`,
      [userId, jobId]
    );

    res.json({ success: true, jobId });

    // Run in background
    (async () => {
      try {
        const contactsResult = await db.query(
          `SELECT id, full_name, first_name, last_name, email, company, job_title,
                  phone, linkedin_url, notes, source, emails, phones
           FROM contacts WHERE user_id = $1`,
          [userId]
        );

        const result = await aiDeduplicationService.findGlobalDuplicates(
          contactsResult.rows,
          (progress) => {
            const job = dedupJobs.get(jobId);
            if (job) job.progress = progress;
          },
          userId
        );

        // Persist result to DB
        await db.query(
          `UPDATE user_jobs
           SET status = 'pending_review',
               result = $1,
               job_id = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $2 AND job_type = 'dedup'`,
          [
            JSON.stringify({
              duplicateDetails: result.duplicateDetails,
              summary: { total: result.total, duplicates: result.duplicates },
            }),
            userId,
          ]
        );

        const job = dedupJobs.get(jobId);
        if (job) { job.status = 'done'; job.result = result; }
      } catch (err) {
        console.error('[GlobalDedup] Job failed:', err.message);
        // Clean up DB row on error so user can retry
        try {
          await db.query(
            `DELETE FROM user_jobs WHERE user_id = $1 AND job_type = 'dedup'`,
            [userId]
          );
        } catch {}
        const job = dedupJobs.get(jobId);
        if (job) { job.status = 'error'; job.error = err.message; }
      }
    })();

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/dedup/job/:jobId
 * Poll for job status while processing (in-memory only — result goes to DB).
 */
router.get('/job/:jobId', authenticateToken, (req, res) => {
  const job = dedupJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found or expired' });
  if (job.userId !== req.userId) return res.status(403).json({ success: false, error: 'Forbidden' });

  if (job.status === 'processing') {
    return res.json({ success: true, status: 'processing', progress: job.progress });
  }
  if (job.status === 'error') {
    return res.json({ success: false, status: 'error', error: job.error });
  }
  // done — client should have already received pending_review from GET /status
  // Do NOT delete the job immediately to avoid 404 race conditions from React multi-renders/polling
  delete job.result; // free memory
  return res.json({ success: true, status: 'done' });
});

/**
 * POST /api/dedup/apply
 * Apply accepted merges, then delete the job from DB.
 */
router.post('/apply', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { acceptedMerges = [] } = req.body;

    let merged = 0;
    const errors = [];

    for (const m of acceptedMerges) {
      const { existingId, incomingId, mergedData } = m;
      if (!existingId || !incomingId || !mergedData) continue;

      try {
        await db.query(
          `UPDATE contacts SET
            full_name    = COALESCE($1, full_name),
            first_name   = COALESCE($2, first_name),
            last_name    = COALESCE($3, last_name),
            email        = COALESCE($4, email),
            company      = COALESCE($5, company),
            job_title    = COALESCE($6, job_title),
            linkedin_url = COALESCE($7, linkedin_url),
            phone        = COALESCE($8, phone),
            emails       = COALESCE($11::jsonb, emails),
            phones       = COALESCE($12::jsonb, phones),
            updated_at   = CURRENT_TIMESTAMP
           WHERE id = $9 AND user_id = $10`,
          [
            mergedData.full_name   || null,
            mergedData.first_name  || null,
            mergedData.last_name   || null,
            mergedData.email       || null,
            mergedData.company     || null,
            mergedData.job_title   || null,
            mergedData.linkedin_url|| null,
            mergedData.phone       || null,
            existingId,
            userId,
            mergedData.emails ? JSON.stringify(mergedData.emails) : null,
            mergedData.phones ? JSON.stringify(mergedData.phones) : null,
          ]
        );

        await db.query(`UPDATE notes      SET contact_id = $1 WHERE contact_id = $2 AND user_id = $3`, [existingId, incomingId, userId]);
        await db.query(`UPDATE reminders  SET contact_id = $1 WHERE contact_id = $2 AND user_id = $3`, [existingId, incomingId, userId]);
        await db.query(`UPDATE activities SET contact_id = $1 WHERE contact_id = $2 AND user_id = $3`, [existingId, incomingId, userId]);

        await db.query(
          `INSERT INTO contact_tags (contact_id, tag_id)
           SELECT $1, tag_id FROM contact_tags WHERE contact_id = $2
           ON CONFLICT DO NOTHING`,
          [existingId, incomingId]
        );

        await db.query(
          `INSERT INTO contact_lists (contact_id, list_id)
           SELECT $1, list_id FROM contact_lists WHERE contact_id = $2
           ON CONFLICT DO NOTHING`,
          [existingId, incomingId]
        );

        await db.query(`DELETE FROM contacts WHERE id = $1 AND user_id = $2`, [incomingId, userId]);
        merged++;
      } catch (err) {
        console.error(`[GlobalDedup] Merge error for ${existingId}/${incomingId}:`, err.message);
        errors.push({ existingId, incomingId, error: err.message });
      }
    }

    // Job is complete — remove from DB regardless of errors
    await db.query(
      `DELETE FROM user_jobs WHERE user_id = $1 AND job_type = 'dedup'`,
      [userId]
    );

    res.json({ success: true, merged, skipped: acceptedMerges.length - merged - errors.length, errors });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/dedup/cancel
 * User dismissed the results without applying — clean up the job.
 */
router.delete('/cancel', authenticateToken, async (req, res) => {
  try {
    await db.query(
      `DELETE FROM user_jobs WHERE user_id = $1 AND job_type = 'dedup'`,
      [req.userId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
