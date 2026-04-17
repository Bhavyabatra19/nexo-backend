const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { getAuthenticatedClient } = require('../config/oauth');
const GoogleIntegrationService = require('../services/integrationService');
const TokenModel = require('../models/Token');
const ContactModel = require('../models/Contact');
const CalendarEventModel = require('../models/CalendarEvent');
const db = require('../db');

/**
 * Sync Routes with Database Integration
 * All routes require authentication
 */

/**
 * POST /api/sync/complete
 * Perform complete sync and save to database
 */
router.post('/complete', authenticateToken, async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Get Google tokens from database
    const tokens = await TokenModel.getTokensForGoogle(req.userId);

    if (!tokens) {
      return res.status(401).json({
        success: false,
        error: 'Google account not connected. Please authenticate first.'
      });
    }

    // Check if already syncing
    const userResult = await db.query('SELECT is_google_syncing FROM users WHERE id = $1', [req.userId]);
    if (userResult.rows[0]?.is_google_syncing) {
      return res.status(409).json({ success: false, error: 'Google sync is already in progress. Please wait.' });
    }
    
    // Set syncing lock
    await db.query(`UPDATE users SET is_google_syncing = TRUE WHERE id = $1`, [req.userId]);

    // Create authenticated client
    const authClient = getAuthenticatedClient(tokens);
    const integrationService = new GoogleIntegrationService(authClient);

    // Get sync options from request body
    const {
      calendarDaysBack = 90,
      calendarDaysAhead = 90
    } = req.body;

    // Perform sync
    console.log(`Starting sync for user ${req.userId}`);
    const syncResult = await integrationService.performCompleteSync({
      calendarDaysBack,
      calendarDaysAhead
    });

    // Debug: Log enrichment statistics
    const contactsWithCalendar = syncResult.data.contacts.filter(
      c => c.calendarData && c.calendarData.lastContacted
    );
    const contactsWithEmail = syncResult.data.contacts.filter(c => c.email);
    const eventsWithAttendees = syncResult.data.events.filter(
      e => e.attendees && e.attendees.length > 0
    );
    
    console.log('=== Sync Debug Info ===');
    console.log(`Total contacts: ${syncResult.data.contacts.length}`);
    console.log(`Contacts with email: ${contactsWithEmail.length}`);
    console.log(`Contacts with calendar data: ${contactsWithCalendar.length}`);
    console.log(`Total events: ${syncResult.data.events.length}`);
    console.log(`Events with attendees: ${eventsWithAttendees.length}`);
    console.log(`Unique attendee emails: ${Object.keys(syncResult.data.interactions).length}`);

    // Save contacts to database
    console.log('Saving contacts to database...');
    const savedContacts = await ContactModel.bulkUpsert(
      req.userId,
      syncResult.data.contacts
    );

    // Save calendar events to database
    console.log('Saving calendar events to database...');
    const savedEvents = await CalendarEventModel.bulkUpsert(
      req.userId,
      syncResult.data.events
    );

    // Record sync history
    const duration = Date.now() - startTime;
    await db.query(`
      INSERT INTO sync_history (
        user_id, sync_type, status, contacts_synced, events_synced,
        started_at, completed_at, duration_ms
      )
      VALUES ($1, 'Google Contacts Sync', 'success', $2, $3, $4, CURRENT_TIMESTAMP, $5)
    `, [
      req.userId,
      savedContacts.length,
      savedEvents.length,
      new Date(startTime),
      duration
    ]);

    res.json({
      success: true,
      syncedAt: new Date().toISOString(),
      executionTimeMs: duration,
      summary: {
        contactsSynced: savedContacts.length,
        eventsSynced: savedEvents.length,
        uniqueInteractions: Object.keys(syncResult.data.interactions).length
      },
      enrichmentDetails: {
        contactsWithEmail: contactsWithEmail.length,
        contactsWithCalendarData: contactsWithCalendar.length,
        eventsWithAttendees: eventsWithAttendees.length,
        matchRate: contactsWithEmail.length > 0 
          ? `${Math.round((contactsWithCalendar.length / contactsWithEmail.length) * 100)}%`
          : '0%'
      },
      statistics: syncResult.statistics
    });

  } catch (error) {
    console.error('Sync error:', error);
    
    // Record failed sync
    await db.query(`
      INSERT INTO sync_history (
        user_id, sync_type, status, started_at, completed_at,
        duration_ms, error_message
      )
      VALUES ($1, 'Google Contacts Sync', 'failed', $2, CURRENT_TIMESTAMP, $3, $4)
    `, [
      req.userId,
      new Date(startTime),
      Date.now() - startTime,
      error.message
    ]).catch(err => console.error('Failed to record sync error:', err));

    res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    // Release the Google sync lock
    await db.query(`UPDATE users SET is_google_syncing = FALSE WHERE id = $1`, [req.userId]).catch(console.error);
  }
});

/**
 * GET /api/sync/status
 * Get last sync status and history
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    // Get last 5 Google syncs
    const googleResult = await db.query(`
      SELECT 
        id, sync_type, status, contacts_synced, events_synced,
        started_at, completed_at, duration_ms, error_message
      FROM sync_history
      WHERE user_id = $1 AND sync_type = 'Google Contacts Sync'
      ORDER BY created_at DESC
      LIMIT 5
    `, [req.userId]);

    // Get last 5 Pinecone syncs
    const pineconeResult = await db.query(`
      SELECT 
        id, sync_type, status, contacts_synced, events_synced,
        started_at, completed_at, duration_ms, error_message
      FROM sync_history
      WHERE user_id = $1 AND sync_type = 'Pinecone Embedding Sync'
      ORDER BY created_at DESC
      LIMIT 5
    `, [req.userId]);

    const lastSync = googleResult.rows[0] || null;
    
    // Check if Google tokens are valid
    const hasValidTokens = await TokenModel.isValid(req.userId);
    
    // Get syncing status
    const statusResult = await db.query('SELECT is_google_syncing as "isSyncing" FROM users WHERE id = $1', [req.userId]);

    res.json({
      success: true,
      lastSync: lastSync,
      history: googleResult.rows,
      pineconeHistory: pineconeResult.rows,
      googleConnected: hasValidTokens,
      isSyncing: statusResult.rows[0]?.isSyncing || false
    });

  } catch (error) {
    console.error('Error fetching sync status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/sync/contacts-only
 * Sync only contacts (faster)
 */
router.post('/contacts-only', authenticateToken, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const tokens = await TokenModel.getTokensForGoogle(req.userId);

    if (!tokens) {
      return res.status(401).json({
        success: false,
        error: 'Google account not connected'
      });
    }

    const authClient = getAuthenticatedClient(tokens);
    const integrationService = new GoogleIntegrationService(authClient);

    // Fetch contacts only
    const contacts = await integrationService.contactsService.fetchContacts();

    // Save to database
    const savedContacts = await ContactModel.bulkUpsert(req.userId, contacts);

    const duration = Date.now() - startTime;

    res.json({
      success: true,
      contactsSynced: savedContacts.length,
      executionTimeMs: duration
    });

  } catch (error) {
    console.error('Contacts sync error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/sync/debug/calendar-matching
 * Debug endpoint to check why contacts aren't matching with calendar
 */
router.get('/debug/calendar-matching', authenticateToken, async (req, res) => {
  try {
    const tokens = await TokenModel.getTokensForGoogle(req.userId);

    if (!tokens) {
      return res.status(401).json({
        success: false,
        error: 'Google account not connected'
      });
    }

    const authClient = getAuthenticatedClient(tokens);
    const integrationService = new GoogleIntegrationService(authClient);

    // Fetch contacts and events
    const contacts = await integrationService.contactsService.fetchContacts();
    const events = await integrationService.calendarService.fetchEvents({
      timeMin: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      timeMax: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    });

    // Extract interactions
    const interactions = integrationService.calendarService.extractAttendeeInteractions(events);

    // Find matching and non-matching contacts
    const contactsWithEmail = contacts.filter(c => c.email);
    const matchedContacts = contactsWithEmail.filter(
      c => interactions[c.email.toLowerCase()]
    );
    const unmatchedContacts = contactsWithEmail.filter(
      c => !interactions[c.email.toLowerCase()]
    );

    // Get sample attendee emails from calendar
    const attendeeEmails = Object.keys(interactions).slice(0, 10);

    // Get sample contact emails
    const sampleContactEmails = contactsWithEmail.slice(0, 10).map(c => c.email);

    res.json({
      success: true,
      debug: {
        totalContacts: contacts.length,
        contactsWithEmail: contactsWithEmail.length,
        contactsWithoutEmail: contacts.length - contactsWithEmail.length,
        
        totalEvents: events.length,
        eventsWithAttendees: events.filter(e => e.attendees && e.attendees.length).length,
        uniqueAttendeeEmails: Object.keys(interactions).length,
        
        matched: matchedContacts.length,
        unmatched: unmatchedContacts.length,
        matchRate: `${Math.round((matchedContacts.length / contactsWithEmail.length) * 100)}%`,
        
        sampleAttendeeEmails: attendeeEmails,
        sampleContactEmails: sampleContactEmails,
        
        // Sample of matched contacts
        sampleMatched: matchedContacts.slice(0, 3).map(c => ({
          name: c.name,
          email: c.email,
          lastContacted: interactions[c.email.toLowerCase()].lastInteraction,
          totalMeetings: interactions[c.email.toLowerCase()].totalMeetings
        })),
        
        // Sample of unmatched contacts
        sampleUnmatched: unmatchedContacts.slice(0, 5).map(c => ({
          name: c.name,
          email: c.email,
          reason: 'Email not found in any calendar event attendees'
        }))
      }
    });

  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;