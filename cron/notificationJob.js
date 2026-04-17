const cron = require('node-cron');
const db = require('../db');
const notificationService = require('../services/notificationService');

async function processDailyReminders() {
  console.log('[Cron] Sending today\'s reminder notifications...', new Date().toISOString());
  let client;
  try {
    client = await db.getClient();
    await client.query('BEGIN');
    const query = `
      SELECT 
        r.id as reminder_id, 
        r.title, 
        r.due_date, 
        r.contact_id,
        u.id as user_id, 
        u.email, 
        u.full_name as user_name,
        u.notification_email, 
        u.notification_whatsapp, 
        u.whatsapp_number,
        c.full_name as contact_name
      FROM reminders r
      JOIN users u ON r.user_id = u.id
      LEFT JOIN contacts c ON r.contact_id = c.id
      WHERE r.is_completed = false
        AND r.is_notified = false
        AND r.due_date <= NOW()
      FOR UPDATE OF r SKIP LOCKED
    `;
    
    const result = await client.query(query);
    const pendingReminders = result.rows;

    if (pendingReminders.length === 0) {
      await client.query('COMMIT');
      return;
    }

    console.log(`[Cron] Found ${pendingReminders.length} reminder(s) due today.`);

    // Process notifications in parallel (batches of 10 to avoid overwhelming external APIs)
    const BATCH_SIZE = 10;
    for (let i = 0; i < pendingReminders.length; i += BATCH_SIZE) {
      const batch = pendingReminders.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (data) => {
        const subject = `Reminder: ${data.title}`;
        let textMessage = `Hi ${data.user_name || 'there'},\n\nThis is a reminder for: "${data.title}".\nDue Date: ${new Date(data.due_date).toLocaleString()}`;

        if (data.contact_name) {
          textMessage += `\nRelated Contact: ${data.contact_name}`;
        }

        const htmlMessage = `
          <h3>Hi ${data.user_name || 'there'},</h3>
          <p>This is a reminder for: <strong>${data.title}</strong>.</p>
          <p>Due Date: ${new Date(data.due_date).toLocaleString()}</p>
          ${data.contact_name ? `<p>Related Contact: ${data.contact_name}</p>` : ''}
          <p>Have a great day!</p>
        `;

        const dueLine = data.contact_name
          ? `${new Date(data.due_date).toLocaleString()} · ${data.contact_name}`
          : new Date(data.due_date).toLocaleString();
        const whatsappParams = {
          userName: data.user_name || 'there',
          reminderTitle: data.title,
          dueLine,
        };

        try {
          const notifyResult = await notificationService.notifyUser(data, {
            subject, textMessage, htmlMessage, whatsappParams,
          });

          // Mark as notified regardless of channel success to prevent infinite loops
          await client.query(`UPDATE reminders SET is_notified = true WHERE id = $1`, [data.reminder_id]);
          if (notifyResult.emailSent || notifyResult.whatsappSent) {
            console.log(`[Cron] Notification sent for Reminder ${data.reminder_id} (Email: ${notifyResult.emailSent}, WP: ${notifyResult.whatsappSent})`);
          }
        } catch (notifyErr) {
          console.error(`[Cron] Failed to notify Reminder ${data.reminder_id}:`, notifyErr.message);
          // Still mark as notified to avoid retrying on every cron tick
          await client.query(`UPDATE reminders SET is_notified = true WHERE id = $1`, [data.reminder_id]);
        }
      }));
    }
    await client.query('COMMIT');
  } catch (error) {
    console.error('[Cron] Notification job failed:', error);
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (e) {}
    }
  } finally {
    if (client) {
      client.release();
    }
  }
}

// Safety-net cron: runs every minute to catch reminders the in-memory scheduler
// may have missed (e.g., after a server restart or setTimeout drift).
// The primary delivery mechanism is the exact-time scheduler in services/reminderScheduler.js.
cron.schedule('* * * * *', processDailyReminders);

module.exports = processDailyReminders;
