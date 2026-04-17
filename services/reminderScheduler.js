/**
 * In-memory Reminder Scheduler
 *
 * Schedules exact-time setTimeout for each upcoming reminder so notifications
 * fire at the precise due time rather than relying solely on polling.
 *
 * Usage:
 *   - On server start: loadUpcomingReminders() loads all un-notified reminders
 *   - On reminder create/update: scheduleReminder(reminder) sets/resets the timer
 *   - On reminder delete/complete: cancelReminder(reminderId) clears the timer
 *
 * A 1-minute cron in notificationJob.js acts as a safety net for anything
 * missed during a restart or if setTimeout drifts.
 */

const db = require('../db');
const notificationService = require('./notificationService');

// Map<reminderId, timeoutHandle>
const scheduledTimers = new Map();

// Maximum setTimeout delay — ~24.8 days (2^31 - 1 ms).
// Reminders further out are ignored here; the cron picks them up when they're closer.
const MAX_TIMEOUT = 2_147_483_647;

/**
 * Schedule a single reminder for exact-time notification.
 *
 * @param {object} reminder - Must include: id, due_date, title, user_id, contact_id
 */
function scheduleReminder(reminder) {
  // Cancel any existing timer for this reminder
  cancelReminder(reminder.id);

  const dueTime = new Date(reminder.due_date || reminder.dueDate).getTime();
  const delay = dueTime - Date.now();

  // Already past or too far in the future — skip (cron will handle it)
  if (delay <= 0 || delay > MAX_TIMEOUT) return;

  const handle = setTimeout(() => {
    scheduledTimers.delete(reminder.id);
    fireReminder(reminder.id).catch(err =>
      console.error(`[Scheduler] Failed to fire reminder ${reminder.id}:`, err.message)
    );
  }, delay);

  // Prevent the timer from keeping the process alive during graceful shutdown
  if (handle.unref) handle.unref();

  scheduledTimers.set(reminder.id, handle);
}

/**
 * Cancel a scheduled reminder timer.
 */
function cancelReminder(reminderId) {
  const handle = scheduledTimers.get(reminderId);
  if (handle) {
    clearTimeout(handle);
    scheduledTimers.delete(reminderId);
  }
}

/**
 * Fire a single reminder notification — fetches fresh data from DB to avoid stale state.
 */
async function fireReminder(reminderId) {
  let client;
  try {
    client = await db.getClient();
    await client.query('BEGIN');

    // Lock the row to prevent double-send with the cron safety net
    const res = await client.query(`
      SELECT
        r.id AS reminder_id, r.title, r.due_date, r.contact_id,
        u.id AS user_id, u.email, u.full_name AS user_name,
        u.notification_email, u.notification_whatsapp, u.whatsapp_number,
        c.full_name AS contact_name
      FROM reminders r
      JOIN users u ON r.user_id = u.id
      LEFT JOIN contacts c ON r.contact_id = c.id
      WHERE r.id = $1
        AND r.is_completed = false
        AND r.is_notified = false
      FOR UPDATE OF r SKIP LOCKED
    `, [reminderId]);

    if (res.rows.length === 0) {
      // Already notified, completed, or deleted — nothing to do
      await client.query('COMMIT');
      return;
    }

    const data = res.rows[0];

    const subject = `Reminder: ${data.title}`;
    const textMessage = `Hi ${data.user_name || 'there'},\n\nThis is a reminder for: "${data.title}".\nDue: ${new Date(data.due_date).toLocaleString()}${data.contact_name ? `\nRelated Contact: ${data.contact_name}` : ''}`;
    const htmlMessage = `
      <h3>Hi ${data.user_name || 'there'},</h3>
      <p>This is a reminder for: <strong>${data.title}</strong>.</p>
      <p>Due: ${new Date(data.due_date).toLocaleString()}</p>
      ${data.contact_name ? `<p>Related Contact: ${data.contact_name}</p>` : ''}
    `;
    const dueLine = data.contact_name
      ? `${new Date(data.due_date).toLocaleString()} · ${data.contact_name}`
      : new Date(data.due_date).toLocaleString();
    const whatsappParams = {
      userName: data.user_name || 'there',
      reminderTitle: data.title,
      dueLine,
    };

    const notifyResult = await notificationService.notifyUser(data, {
      subject, textMessage, htmlMessage, whatsappParams,
    });

    await client.query('UPDATE reminders SET is_notified = true WHERE id = $1', [reminderId]);
    await client.query('COMMIT');

    console.log(`[Scheduler] Notification sent for Reminder ${reminderId} (Email: ${notifyResult.emailSent}, WP: ${notifyResult.whatsappSent})`);
  } catch (err) {
    console.error(`[Scheduler] Error firing reminder ${reminderId}:`, err.message);
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
  } finally {
    if (client) client.release();
  }
}

/**
 * Load all upcoming un-notified reminders and schedule them.
 * Called once on server startup.
 */
async function loadUpcomingReminders() {
  try {
    const res = await db.query(`
      SELECT id, title, due_date, user_id, contact_id
      FROM reminders
      WHERE is_completed = false
        AND is_notified = false
        AND due_date > NOW()
        AND due_date < NOW() + INTERVAL '25 days'
    `);

    for (const row of res.rows) {
      scheduleReminder(row);
    }

    console.log(`[Scheduler] Loaded ${res.rows.length} upcoming reminder(s) into in-memory scheduler`);
  } catch (err) {
    console.error('[Scheduler] Failed to load upcoming reminders:', err.message);
  }
}

module.exports = {
  scheduleReminder,
  cancelReminder,
  loadUpcomingReminders,
};
