const db = require('../db');

/**
 * Contact Model
 * Manages contacts in database
 */

class ContactModel {
  /**
   * Bulk upsert contacts from Google sync
   */
  static async bulkUpsert(userId, contacts) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      const upsertedContacts = [];
      
      for (const contact of contacts) {
        const query = `
          INSERT INTO contacts (
            user_id, google_contact_id, full_name, first_name, last_name,
            email, phone, company, job_title, photo_url, address, birthday,
            last_contacted, first_contacted, total_meetings, upcoming_meetings,
            past_meetings, days_since_last_contact, linkedin_url, last_synced, contact_created_date
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, CURRENT_TIMESTAMP, $20)
          ON CONFLICT (user_id, google_contact_id)
          DO UPDATE SET
            full_name = EXCLUDED.full_name,
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            email = EXCLUDED.email,
            phone = EXCLUDED.phone,
            company = EXCLUDED.company,
            job_title = EXCLUDED.job_title,
            photo_url = EXCLUDED.photo_url,
            address = EXCLUDED.address,
            birthday = EXCLUDED.birthday,
            last_contacted = EXCLUDED.last_contacted,
            first_contacted = EXCLUDED.first_contacted,
            total_meetings = EXCLUDED.total_meetings,
            upcoming_meetings = EXCLUDED.upcoming_meetings,
            past_meetings = EXCLUDED.past_meetings,
            days_since_last_contact = EXCLUDED.days_since_last_contact,
            linkedin_url = COALESCE(EXCLUDED.linkedin_url, contacts.linkedin_url),
            last_synced = CURRENT_TIMESTAMP
          RETURNING *
        `;

        const calendarData = contact.calendarData || {};
        
        const result = await client.query(query, [
          userId,
          contact.id,
          contact.name,
          contact.firstName,
          contact.lastName,
          contact.email,
          contact.phone,
          contact.company,
          contact.jobTitle,
          contact.photoUrl,
          contact.address,
          contact.birthday ? this.formatBirthday(contact.birthday) : null,
          calendarData.lastContacted || null,
          calendarData.firstContacted || null,
          calendarData.totalMeetings || 0,
          calendarData.upcomingMeetings || 0,
          calendarData.pastMeetings || 0,
          calendarData.daysSinceLastContact || null,
          contact.linkedinUrl || null,
          null // no created date from Google sync yet
        ]);

        upsertedContacts.push(result.rows[0]);
      }

      await client.query('COMMIT');
      return upsertedContacts;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get all contacts for a user
   */
  static async getAll(userId, options = {}) {
    const { limit = 100, offset = 0, sortBy = 'created_at', sortOrder = 'DESC' } = options;
    
    const query = `
      SELECT * FROM contacts 
      WHERE user_id = $1
      ORDER BY ${sortBy} ${sortOrder}
      LIMIT $2 OFFSET $3
    `;

    const result = await db.query(query, [userId, limit, offset]);
    return result.rows;
  }

  /**
   * Get contacts needing re-engagement
   */
  static async getStaleContacts(userId, daysThreshold = 30) {
    const query = `
      SELECT * FROM contacts 
      WHERE user_id = $1 
        AND last_contacted IS NOT NULL
        AND last_contacted < CURRENT_TIMESTAMP - make_interval(days => $2)
      ORDER BY last_contacted ASC
    `;

    const result = await db.query(query, [userId, parseInt(daysThreshold)]);
    return result.rows;
  }

  /**
   * Search contacts
   */
  static async search(userId, searchTerm) {
    const query = `
      SELECT DISTINCT c.* FROM contacts c
      LEFT JOIN notes n ON c.id = n.contact_id AND n.user_id = $1
      WHERE c.user_id = $1 
        AND (
          c.full_name ILIKE $2 
          OR c.email ILIKE $2 
          OR c.company ILIKE $2
          OR c.notes ILIKE $2
          OR n.content ILIKE $2
        )
      ORDER BY c.last_contacted DESC NULLS LAST
      LIMIT 50
    `;

    const result = await db.query(query, [userId, `%${searchTerm}%`]);
    return result.rows;
  }

  /**
   * Get contact by ID
   */
  static async getById(contactId, userId) {
    const query = 'SELECT * FROM contacts WHERE id = $1 AND user_id = $2';
    const result = await db.query(query, [contactId, userId]);
    return result.rows[0];
  }

  /**
   * Update contact notes
   */
  static async updateNotes(contactId, userId, notes) {
    const query = `
      UPDATE contacts 
      SET notes = $1
      WHERE id = $2 AND user_id = $3
      RETURNING *
    `;

    const result = await db.query(query, [notes, contactId, userId]);
    return result.rows[0];
  }

  /**
   * Toggle favorite status
   */
  static async toggleFavorite(contactId, userId) {
    const query = `
      UPDATE contacts 
      SET is_favorite = NOT is_favorite
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `;

    const result = await db.query(query, [contactId, userId]);
    return result.rows[0];
  }

  /**
   * Get contacts by tag
   */
  static async getByTag(userId, tagId) {
    const query = `
      SELECT c.* FROM contacts c
      INNER JOIN contact_tags ct ON c.id = ct.contact_id
      WHERE c.user_id = $1 AND ct.tag_id = $2
      ORDER BY c.full_name ASC
    `;

    const result = await db.query(query, [userId, tagId]);
    return result.rows;
  }

  /**
   * Get contacts by list
   */
  static async getByList(userId, listId) {
    const query = `
      SELECT c.* FROM contacts c
      INNER JOIN contact_lists cl ON c.id = cl.contact_id
      WHERE c.user_id = $1 AND cl.list_id = $2
      ORDER BY c.full_name ASC
    `;

    const result = await db.query(query, [userId, listId]);
    return result.rows;
  }

  /**
   * Delete contact
   */
  static async delete(contactId, userId) {
    const query = 'DELETE FROM contacts WHERE id = $1 AND user_id = $2';
    await db.query(query, [contactId, userId]);
  }

  /**
   * Create new manual contact
   */
  static async create(userId, contactData) {
    const query = `
      INSERT INTO contacts (
        user_id, full_name, first_name, last_name, email, phone, company, job_title,
        linkedin_url, bio, notes, source, contact_created_date
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'manual', CURRENT_TIMESTAMP)
      RETURNING *
    `;

    // Process names
    let firstName = '';
    let lastName = '';
    if (contactData.name) {
      const parts = contactData.name.trim().split(' ');
      firstName = parts[0];
      lastName = parts.length > 1 ? parts.slice(1).join(' ') : '';
    }

    const { rows } = await db.query(query, [
      userId,
      contactData.name || null,
      firstName || null,
      lastName || null,
      contactData.email || null,
      contactData.phone || null,
      contactData.company || null,
      contactData.title || null,
      contactData.linkedinUrl || null,
      contactData.bio || null,
      contactData.notes || null
    ]);

    return rows[0];
  }

  /**
   * Get contact statistics for user
   */
  static async getStats(userId) {
    const query = `
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE last_contacted IS NOT NULL) as with_calendar_data,
        COUNT(*) FILTER (WHERE email IS NOT NULL) as with_email,
        COUNT(*) FILTER (WHERE phone IS NOT NULL) as with_phone,
        COUNT(*) FILTER (WHERE company IS NOT NULL) as with_company,
        COUNT(*) FILTER (WHERE is_favorite = true) as favorites,
        AVG(total_meetings) FILTER (WHERE total_meetings > 0) as avg_meetings
      FROM contacts
      WHERE user_id = $1
    `;

    const result = await db.query(query, [userId]);
    return result.rows[0];
  }

  /**
   * Helper to format birthday
   */
  static formatBirthday(birthday) {
    if (!birthday) return null;
    
    // If already a date string
    if (typeof birthday === 'string') return birthday;
    
    // If object with year, month, day
    if (birthday.year && birthday.month && birthday.day) {
      return `${birthday.year}-${String(birthday.month).padStart(2, '0')}-${String(birthday.day).padStart(2, '0')}`;
    }
    
    return null;
  }
}

module.exports = ContactModel;