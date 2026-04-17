const db = require('../db');

/**
 * Calendar Event Model
 * Manages calendar events in database
 */

class CalendarEventModel {
  /**
   * Bulk upsert calendar events from Google sync
   */
  static async bulkUpsert(userId, events) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      const upsertedEvents = [];
      
      for (const event of events) {
        const query = `
          INSERT INTO calendar_events (
            user_id, google_event_id, summary, description, location,
            status, start_time, end_time, is_all_day, meeting_link,
            is_recurring, attendees, last_synced
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id, google_event_id)
          DO UPDATE SET
            summary = EXCLUDED.summary,
            description = EXCLUDED.description,
            location = EXCLUDED.location,
            status = EXCLUDED.status,
            start_time = EXCLUDED.start_time,
            end_time = EXCLUDED.end_time,
            is_all_day = EXCLUDED.is_all_day,
            meeting_link = EXCLUDED.meeting_link,
            is_recurring = EXCLUDED.is_recurring,
            attendees = EXCLUDED.attendees,
            last_synced = CURRENT_TIMESTAMP
          RETURNING *
        `;

        const result = await client.query(query, [
          userId,
          event.id,
          event.summary,
          event.description || null,
          event.location || null,
          event.status,
          new Date(event.start),
          new Date(event.end),
          event.isAllDay,
          event.meetingLink || null,
          event.recurring,
          JSON.stringify(event.attendees || []),
        ]);

        upsertedEvents.push(result.rows[0]);
      }

      await client.query('COMMIT');
      return upsertedEvents;

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error upserting calendar events:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get all events for a user
   */
  static async getAll(userId, options = {}) {
    const { 
      limit = 100, 
      offset = 0, 
      startDate = null,
      endDate = null,
      sortBy = 'start_time',
      sortOrder = 'DESC' 
    } = options;
    
    let query = 'SELECT * FROM calendar_events WHERE user_id = $1';
    const params = [userId];
    let paramCount = 2;

    if (startDate) {
      query += ` AND start_time >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
    }

    if (endDate) {
      query += ` AND start_time <= $${paramCount}`;
      params.push(endDate);
      paramCount++;
    }

    query += ` ORDER BY ${sortBy} ${sortOrder} LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Get upcoming events
   */
  static async getUpcoming(userId, daysAhead = 7) {
    const now = new Date();
    const futureDate = new Date(now.getTime() + (daysAhead * 24 * 60 * 60 * 1000));

    const query = `
      SELECT * FROM calendar_events 
      WHERE user_id = $1 
        AND start_time >= $2 
        AND start_time <= $3
        AND status != 'cancelled'
      ORDER BY start_time ASC
    `;

    const result = await db.query(query, [userId, now, futureDate]);
    return result.rows;
  }

  /**
   * Get past events
   */
  static async getPast(userId, daysBack = 90) {
    const now = new Date();
    const pastDate = new Date(now.getTime() - (daysBack * 24 * 60 * 60 * 1000));

    const query = `
      SELECT * FROM calendar_events 
      WHERE user_id = $1 
        AND start_time >= $2 
        AND start_time < $3
      ORDER BY start_time DESC
    `;

    const result = await db.query(query, [userId, pastDate, now]);
    return result.rows;
  }

  /**
   * Get events with a specific attendee
   */
  static async getByAttendee(userId, attendeeEmail) {
    const query = `
      SELECT * FROM calendar_events 
      WHERE user_id = $1 
        AND attendees @> $2::jsonb
      ORDER BY start_time DESC
    `;

    const result = await db.query(query, [
      userId,
      JSON.stringify([{ email: attendeeEmail }])
    ]);
    
    return result.rows;
  }

  /**
   * Get event statistics
   */
  static async getStats(userId) {
    const now = new Date();
    
    const query = `
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE start_time > $2) as upcoming,
        COUNT(*) FILTER (WHERE start_time <= $2) as past,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COUNT(*) FILTER (WHERE is_recurring = true) as recurring,
        COUNT(DISTINCT jsonb_array_elements(attendees)->>'email') as unique_attendees
      FROM calendar_events
      WHERE user_id = $1
    `;

    const result = await db.query(query, [userId, now]);
    return result.rows[0];
  }

  /**
   * Delete old events (cleanup)
   */
  static async deleteOlderThan(userId, daysOld = 365) {
    const cutoffDate = new Date(Date.now() - (daysOld * 24 * 60 * 60 * 1000));

    const query = `
      DELETE FROM calendar_events 
      WHERE user_id = $1 AND start_time < $2
    `;

    const result = await db.query(query, [userId, cutoffDate]);
    return result.rowCount;
  }
}

module.exports = CalendarEventModel;