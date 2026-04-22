/**
 * Profile Monitor Routes
 *
 * GET    /api/monitors              — list all active monitors for user
 * POST   /api/monitors/:contactId   — enable / update monitoring for a contact
 * DELETE /api/monitors/:contactId   — disable monitoring
 * GET    /api/monitors/:contactId/changes — change history for a contact
 * POST   /api/monitors/:contactId/check-now — trigger immediate re-check
 */

const express  = require('express');
const router   = express.Router();
const db       = require('../db');
const logger   = require('../logger');
const { authenticateToken } = require('../middleware/auth');
const { profileMonitorQueue } = require('../workers/queues');

// List all active monitors
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        pm.id, pm.contact_id, pm.linkedin_url, pm.frequency,
        pm.last_checked_at, pm.next_check_at, pm.changes_detected,
        pm.is_active, pm.created_at,
        c.full_name, c.photo_url, c.job_title, c.company
      FROM profile_monitors pm
      JOIN contacts c ON c.id = pm.contact_id
      WHERE pm.user_id = $1 AND pm.is_active = true
      ORDER BY pm.changes_detected DESC, pm.created_at DESC
    `, [req.userId]);

    res.json({ success: true, monitors: rows });
  } catch (err) {
    logger.error(`[Monitors] GET / failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Check monitor status for a single contact
router.get('/:contactId/status', authenticateToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, frequency, last_checked_at, next_check_at, changes_detected, is_active
       FROM profile_monitors
       WHERE contact_id = $1 AND user_id = $2
       LIMIT 1`,
      [req.params.contactId, req.userId]
    );
    res.json({ success: true, monitor: rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enable / update monitoring for a contact
router.post('/:contactId', authenticateToken, async (req, res) => {
  const { frequency = 'weekly' } = req.body;
  const { contactId } = req.params;

  if (!['daily', 'weekly', 'monthly'].includes(frequency)) {
    return res.status(400).json({ error: 'frequency must be daily, weekly, or monthly' });
  }

  try {
    const { rows: [contact] } = await db.query(
      `SELECT linkedin_url FROM contacts WHERE id = $1 AND user_id = $2`,
      [contactId, req.userId]
    );

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    if (!contact.linkedin_url) {
      return res.status(400).json({ error: 'Contact has no LinkedIn URL — cannot monitor' });
    }

    const intervalSql = { daily: '1 day', weekly: '7 days', monthly: '30 days' }[frequency];

    const { rows: [monitor] } = await db.query(`
      INSERT INTO profile_monitors
        (user_id, contact_id, linkedin_url, frequency, next_check_at)
      VALUES ($1, $2, $3, $4, NOW() + INTERVAL '${intervalSql}')
      ON CONFLICT (user_id, contact_id)
      DO UPDATE SET
        is_active     = true,
        frequency     = EXCLUDED.frequency,
        next_check_at = NOW() + INTERVAL '${intervalSql}'
      RETURNING id, frequency, next_check_at
    `, [req.userId, contactId, contact.linkedin_url, frequency]);

    logger.info(`[Monitors] Enabled monitor ${monitor.id} for contact ${contactId} (${frequency})`);
    res.json({ success: true, monitor });
  } catch (err) {
    logger.error(`[Monitors] POST /${contactId} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Disable monitoring
router.delete('/:contactId', authenticateToken, async (req, res) => {
  try {
    await db.query(
      `UPDATE profile_monitors SET is_active = false WHERE contact_id = $1 AND user_id = $2`,
      [req.params.contactId, req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get change history for a contact
router.get('/:contactId/changes', authenticateToken, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, changed_fields, detected_at
      FROM profile_changes
      WHERE contact_id = $1 AND user_id = $2
      ORDER BY detected_at DESC
      LIMIT 50
    `, [req.params.contactId, req.userId]);

    res.json({ success: true, changes: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger an immediate re-check
router.post('/:contactId/check-now', authenticateToken, async (req, res) => {
  try {
    const { rows: [monitor] } = await db.query(
      `SELECT id, linkedin_url FROM profile_monitors
       WHERE contact_id = $1 AND user_id = $2 AND is_active = true
       LIMIT 1`,
      [req.params.contactId, req.userId]
    );

    if (!monitor) {
      return res.status(404).json({ error: 'No active monitor for this contact' });
    }

    await profileMonitorQueue.add('check', {
      monitorId:   monitor.id,
      contactId:   req.params.contactId,
      linkedinUrl: monitor.linkedin_url,
      userId:      req.userId,
    }, {
      // Use a unique jobId so repeated "check-now" doesn't deduplicate
      jobId: `monitor-now:${monitor.id}:${Date.now()}`,
      priority: 1,
    });

    res.json({ success: true, message: 'Check queued — results will appear in a few minutes' });
  } catch (err) {
    logger.error(`[Monitors] check-now failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
