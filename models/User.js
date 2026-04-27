const db = require('../db');

/**
 * User Model
 * Handles all user-related database operations
 */

class UserModel {
  /**
   * Create a new user
   */
  static async create({ email, fullName, googleId, profilePicture }) {
    const orgDomain = email && email.includes('@')
      ? email.split('@')[1].toLowerCase()
      : null;

    const query = `
      INSERT INTO users (email, full_name, google_id, profile_picture, org_domain, last_login)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      RETURNING *
    `;

    const result = await db.query(query, [email, fullName, googleId, profilePicture, orgDomain]);
    return result.rows[0];
  }

  /**
   * Find user by ID
   */
  static async findById(userId) {
    const query = 'SELECT * FROM users WHERE id = $1';
    const result = await db.query(query, [userId]);
    return result.rows[0];
  }

  /**
   * Find user by email
   */
  static async findByEmail(email) {
    const query = 'SELECT * FROM users WHERE email = $1';
    const result = await db.query(query, [email]);
    return result.rows[0];
  }

  /**
   * Find user by Google ID
   */
  static async findByGoogleId(googleId) {
    const query = 'SELECT * FROM users WHERE google_id = $1';
    const result = await db.query(query, [googleId]);
    return result.rows[0];
  }

  /**
   * Find or create user (used during OAuth)
   */
  static async findOrCreate({ email, fullName, googleId, profilePicture }) {
    let user = await this.findByGoogleId(googleId);
    let isNew = false;

    if (!user) {
      user = await this.findByEmail(email);

      if (user) {
        user = await this.update(user.id, { googleId, profilePicture });
      } else {
        user = await this.create({ email, fullName, googleId, profilePicture });
        isNew = true;
      }
    }

    await this.updateLastLogin(user.id);

    return { user, isNew };
  }

  /**
   * Update user
   */
  static async update(userId, data) {
    const fields = [];
    const values = [];
    let paramCount = 1;

    if (data.email) {
      fields.push(`email = $${paramCount++}`);
      values.push(data.email);
    }
    if (data.fullName) {
      fields.push(`full_name = $${paramCount++}`);
      values.push(data.fullName);
    }
    if (data.googleId) {
      fields.push(`google_id = $${paramCount++}`);
      values.push(data.googleId);
    }
    if (data.profilePicture) {
      fields.push(`profile_picture = $${paramCount++}`);
      values.push(data.profilePicture);
    }
    if (data.notificationEmail !== undefined) {
      fields.push(`notification_email = $${paramCount++}`);
      values.push(data.notificationEmail);
    }
    if (data.notificationWhatsapp !== undefined) {
      fields.push(`notification_whatsapp = $${paramCount++}`);
      values.push(data.notificationWhatsapp);
    }
    if (data.whatsappNumber !== undefined) {
      fields.push(`whatsapp_number = $${paramCount++}`);
      values.push(data.whatsappNumber);
    }

    if (fields.length === 0) {
      return await this.findById(userId);
    }

    values.push(userId);
    const query = `
      UPDATE users 
      SET ${fields.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await db.query(query, values);
    return result.rows[0];
  }

  /**
   * Update last login timestamp
   */
  static async updateLastLogin(userId) {
    const query = `
      UPDATE users 
      SET last_login = CURRENT_TIMESTAMP
      WHERE id = $1
    `;
    await db.query(query, [userId]);
  }

  /**
   * Delete user (cascade will delete all related data)
   */
  static async delete(userId) {
    const query = 'DELETE FROM users WHERE id = $1';
    await db.query(query, [userId]);
  }

  /**
   * Get user statistics
   */
  static async getStats(userId) {
    // Ensure AI tokens are fresh (reset if new day)
    try {
      const AITokenService = require('../services/aiTokenService');
      await AITokenService.checkLimit(userId);
    } catch (e) { console.error("AiTokenService Error in stats:", e); }

    const query = `
      SELECT 
        (SELECT COUNT(*) FROM contacts WHERE user_id = $1) as total_contacts,
        (SELECT COUNT(*) FROM contacts WHERE user_id = $1 AND last_contacted IS NOT NULL) as contacts_with_calendar_data,
        (SELECT COUNT(*) FROM calendar_events WHERE user_id = $1) as total_events,
        (SELECT COUNT(*) FROM tags WHERE user_id = $1) as total_tags,
        (SELECT COUNT(*) FROM lists WHERE user_id = $1) as total_lists,
        (SELECT ai_tokens_used_today FROM users WHERE id = $1) as ai_tokens_used,
        (SELECT ai_tokens_last_reset FROM users WHERE id = $1) as ai_tokens_reset_date
    `;
    
    const result = await db.query(query, [userId]);
    return result.rows[0];
  }

  /**
   * Get all users
   */
  static async getAll() {
    const query = 'SELECT * FROM users';
    const result = await db.query(query);
    return result.rows;
  }
}

module.exports = UserModel;
