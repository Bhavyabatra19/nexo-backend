/**
 * Profile Monitor Cron — runs every hour.
 * Finds monitors where next_check_at <= NOW() and enqueues a profile-monitor job.
 * The worker resets next_check_at when done; we set it far-future here to prevent
 * double-scheduling if the worker is slow.
 */

const cron = require('node-cron');
const db = require('../db');
const { profileMonitorQueue } = require('../workers/queues');
const logger = require('../logger');

async function scheduleMonitorJobs() {
  try {
    const { rows } = await db.query(`
      SELECT id, contact_id, linkedin_url, user_id
      FROM profile_monitors
      WHERE is_active = true
        AND next_check_at <= NOW()
      LIMIT 200
    `);

    if (!rows.length) return;

    for (const m of rows) {
      // Claim the slot — push next_check_at forward so we don't double-queue
      await db.query(
        `UPDATE profile_monitors SET next_check_at = NOW() + INTERVAL '1 year' WHERE id = $1`,
        [m.id]
      );

      await profileMonitorQueue.add('check', {
        monitorId:   m.id,
        contactId:   m.contact_id,
        linkedinUrl: m.linkedin_url,
        userId:      m.user_id,
      }, {
        jobId: `monitor_${m.id}`, // deduplicate; BullMQ rejects ":" in custom jobIds
      });
    }

    logger.info(`[MonitorCron] Scheduled ${rows.length} profile monitor checks`);
  } catch (err) {
    logger.error(`[MonitorCron] Failed: ${err.message}`);
  }
}

// Run at the top of every hour
cron.schedule('0 * * * *', scheduleMonitorJobs);

// Also run once on startup to catch any overdue monitors
scheduleMonitorJobs();

module.exports = { scheduleMonitorJobs };
