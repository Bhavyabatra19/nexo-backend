const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const db = require('../db');

/**
 * Debug Routes
 * Helper endpoints to troubleshoot issues
 */

/**
 * GET /api/debug/database-state
 * Check what's actually in the database
 */
router.get('/database-state', authenticateToken, async (req, res) => {
  try {
    // Check contacts with calendar data
    const contactsQuery = await db.query(`
      SELECT 
        COUNT(*) as total_contacts,
        COUNT(*) FILTER (WHERE email IS NOT NULL) as with_email,
        COUNT(*) FILTER (WHERE last_contacted IS NOT NULL) as with_last_contacted,
        COUNT(*) FILTER (WHERE total_meetings > 0) as with_meetings,
        AVG(total_meetings) FILTER (WHERE total_meetings > 0) as avg_meetings
      FROM contacts
      WHERE user_id = $1
    `, [req.userId]);

    // Get sample contacts with calendar data
    const sampleWithCalendar = await db.query(`
      SELECT 
        full_name, email, last_contacted, total_meetings, 
        days_since_last_contact
      FROM contacts
      WHERE user_id = $1 
        AND last_contacted IS NOT NULL
      ORDER BY last_contacted DESC
      LIMIT 5
    `, [req.userId]);

    // Get sample contacts without calendar data
    const sampleWithoutCalendar = await db.query(`
      SELECT full_name, email
      FROM contacts
      WHERE user_id = $1 
        AND email IS NOT NULL
        AND last_contacted IS NULL
      LIMIT 5
    `, [req.userId]);

    // Check calendar events
    const eventsQuery = await db.query(`
      SELECT 
        COUNT(*) as total_events,
        COUNT(*) FILTER (WHERE jsonb_array_length(attendees) > 0) as with_attendees,
        COUNT(DISTINCT jsonb_array_elements(attendees)->>'email') as unique_attendees
      FROM calendar_events
      WHERE user_id = $1
    `, [req.userId]);

    // Get sample attendee emails from events
    const attendeeEmails = await db.query(`
      SELECT DISTINCT jsonb_array_elements(attendees)->>'email' as email
      FROM calendar_events
      WHERE user_id = $1
      LIMIT 10
    `, [req.userId]);

    res.json({
      success: true,
      database: {
        contacts: contactsQuery.rows[0],
        events: eventsQuery.rows[0],
        
        sampleContactsWithCalendar: sampleWithCalendar.rows,
        sampleContactsWithoutCalendar: sampleWithoutCalendar.rows,
        sampleAttendeeEmailsFromEvents: attendeeEmails.rows.map(r => r.email),
        
        diagnosis: {
          contactsNeedEmail: contactsQuery.rows[0].total_contacts - contactsQuery.rows[0].with_email,
          contactsNeedMatching: contactsQuery.rows[0].with_email - contactsQuery.rows[0].with_last_contacted,
          matchRate: contactsQuery.rows[0].with_email > 0
            ? `${Math.round((contactsQuery.rows[0].with_last_contacted / contactsQuery.rows[0].with_email) * 100)}%`
            : '0%'
        }
      }
    });

  } catch (error) {
    console.error('Debug database state error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/debug/contact-calendar-match
 * Check if a specific contact email matches any calendar attendee
 */
router.get('/contact-calendar-match', authenticateToken, async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email parameter required'
      });
    }

    // Find contact
    const contact = await db.query(`
      SELECT * FROM contacts 
      WHERE user_id = $1 AND email ILIKE $2
    `, [req.userId, email]);

    // Find events with this attendee
    const events = await db.query(`
      SELECT 
        id, summary, start_time, end_time, status, attendees
      FROM calendar_events
      WHERE user_id = $1
        AND attendees @> $2::jsonb
      ORDER BY start_time DESC
      LIMIT 10
    `, [req.userId, JSON.stringify([{ email: email }])]);

    res.json({
      success: true,
      contact: contact.rows[0] || null,
      eventsFound: events.rows.length,
      events: events.rows,
      diagnosis: contact.rows[0]
        ? {
            hasEmail: !!contact.rows[0].email,
            hasLastContacted: !!contact.rows[0].last_contacted,
            totalMeetings: contact.rows[0].total_meetings,
            eventsInDatabase: events.rows.length,
            issue: events.rows.length > 0 && !contact.rows[0].last_contacted
              ? 'Events exist but contact not enriched - sync issue'
              : events.rows.length === 0
              ? 'No events found with this email'
              : 'Everything looks correct'
          }
        : { issue: 'Contact not found in database' }
    });

  } catch (error) {
    console.error('Debug contact match error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;