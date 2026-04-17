const cron = require('node-cron');
const db = require('../db');
const TokenModel = require('../models/Token');
const { getAuthenticatedClient } = require('../config/oauth');
const GoogleIntegrationService = require('../services/integrationService');
const ContactModel = require('../models/Contact');
const CalendarEventModel = require('../models/CalendarEvent');

async function runScheduledNightlySync() {
  console.log('[Cron] Starting nightly sync job...', new Date().toISOString());
  try {
    const result = await db.query('SELECT DISTINCT user_id FROM google_tokens WHERE expires_at > CURRENT_TIMESTAMP OR refresh_token IS NOT NULL');
    const users = result.rows.map(r => r.user_id);
    
    for (const userId of users) {
      try {
        console.log(`[Cron] Syncing user ${userId}...`);
        
        const lastSyncRes = await db.query('SELECT completed_at FROM sync_history WHERE user_id = $1 AND status = $2 ORDER BY completed_at DESC LIMIT 1', [userId, 'success']);
        const lastSyncTime = lastSyncRes.rows.length > 0 ? new Date(lastSyncRes.rows[0].completed_at) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

        const tokens = await TokenModel.getTokensForGoogle(userId);
        if (!tokens) continue;

        const authClient = getAuthenticatedClient(tokens);
        const integrationService = new GoogleIntegrationService(authClient);
        
        const startTime = Date.now();
        
        // Fetch contacts
        const contacts = await integrationService.contactsService.fetchContacts();
        
        // Proper filtering to pull ONLY updated data from google contacts
        const updatedContacts = contacts.filter(c => c.lastUpdated && new Date(c.lastUpdated) > lastSyncTime);
        console.log(`[Cron] Found ${updatedContacts.length} updated contacts since ${lastSyncTime.toISOString()}`);

        const events = await integrationService.calendarService.fetchEvents({
          timeMin: lastSyncTime,
          timeMax: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
        });

        // Merge contacts with calendar
        const enrichedContacts = integrationService.calendarService.mergeContactsWithCalendar(updatedContacts.length > 0 ? updatedContacts : [], events);
        
        if (enrichedContacts.length > 0) {
            await ContactModel.bulkUpsert(userId, enrichedContacts);
        }

        if (events.length > 0) {
            await CalendarEventModel.bulkUpsert(userId, events);
        }

        const duration = Date.now() - startTime;
        
        await db.query(`
          INSERT INTO sync_history (
            user_id, sync_type, status, contacts_synced, events_synced,
            started_at, completed_at, duration_ms
          )
          VALUES ($1, 'scheduled', 'success', $2, $3, $4, CURRENT_TIMESTAMP, $5)
        `, [
          userId,
          updatedContacts.length,
          events.length,
          new Date(startTime),
          duration
        ]);
        
        // Keep ONLY last 5 sync histories per user
        await db.query(`
          DELETE FROM sync_history 
          WHERE id NOT IN (
            SELECT id FROM sync_history 
            WHERE user_id = $1 
            ORDER BY completed_at DESC 
            LIMIT 5
          ) AND user_id = $1
        `, [userId]);
        
      } catch (err) {
        console.error(`[Cron] Failed to sync for user ${userId}:`, err);
      }
    }
  } catch (error) {
    console.error('[Cron] Nightly sync job failed entirely:', error);
  }
}

// Scheduled to run every night at midnight (00:00)
cron.schedule('0 0 * * *', runScheduledNightlySync);

module.exports = runScheduledNightlySync;
