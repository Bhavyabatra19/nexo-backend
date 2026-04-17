const db = require('../db');

class NoteModel {
  static async getByContactId(contactId, userId, limit = 50, offset = 0) {
    const query = `
      SELECT id, title, content, created_at as "createdAt"
      FROM notes 
      WHERE contact_id = $1 AND user_id = $2
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4
    `;
    const result = await db.query(query, [contactId, userId, limit, offset]);

    const countQuery = `SELECT COUNT(*) FROM notes WHERE contact_id = $1 AND user_id = $2`;
    const countResult = await db.query(countQuery, [contactId, userId]);

    return {
      notes: result.rows,
      total: parseInt(countResult.rows[0].count)
    };
  }

  static async create(contactId, userId, content, title) {
    const query = `
      INSERT INTO notes (contact_id, user_id, content, title) 
      VALUES ($1, $2, $3, $4)
      RETURNING id, title, content, created_at as "createdAt"
    `;
    const result = await db.query(query, [contactId, userId, content, title || null]);
    return result.rows[0];
  }

  static async update(noteId, userId, content, title) {
    const query = `
      UPDATE notes 
      SET content = $1, title = $2
      WHERE id = $3 AND user_id = $4
      RETURNING id, title, content, created_at as "createdAt"
    `;
    const result = await db.query(query, [content, title || null, noteId, userId]);
    return result.rows[0];
  }

  static async delete(noteId, userId) {
    const query = 'DELETE FROM notes WHERE id = $1 AND user_id = $2';
    await db.query(query, [noteId, userId]);
  }
}

module.exports = NoteModel;
