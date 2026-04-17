const db = require('../db');

class ActivityModel {
  static async create(contactId, userId, type, description) {
    const query = `
      INSERT INTO activities (contact_id, user_id, type, description)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    const result = await db.query(query, [contactId, userId, type, description]);
    return result.rows[0];
  }

  static async getByContactId(contactId, userId, limit = 50, offset = 0) {
    const query = `
      SELECT * FROM activities
      WHERE contact_id = $1 AND user_id = $2
      ORDER BY timestamp DESC
      LIMIT $3 OFFSET $4
    `;
    const result = await db.query(query, [contactId, userId, limit, offset]);
    
    // Also get total count
    const countQuery = `SELECT COUNT(*) FROM activities WHERE contact_id = $1 AND user_id = $2`;
    const countResult = await db.query(countQuery, [contactId, userId]);
    
    return {
      activities: result.rows,
      total: parseInt(countResult.rows[0].count)
    };
  }
}

module.exports = ActivityModel;
