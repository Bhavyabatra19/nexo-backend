const db = require('../db');

class ReminderModel {
  static async getByContactId(contactId, userId, limit = 50, offset = 0) {
    const query = `
      SELECT id, title, due_date as "dueDate", is_completed as "isCompleted", recurrence
      FROM reminders 
      WHERE contact_id = $1 AND user_id = $2
      ORDER BY due_date ASC
      LIMIT $3 OFFSET $4
    `;
    const result = await db.query(query, [contactId, userId, limit, offset]);

    const countQuery = `SELECT COUNT(*) FROM reminders WHERE contact_id = $1 AND user_id = $2`;
    const countResult = await db.query(countQuery, [contactId, userId]);

    return {
      reminders: result.rows,
      total: parseInt(countResult.rows[0].count)
    };
  }

  static async getAllByUserId(userId, limit = 50, offset = 0) {
    const query = `
      SELECT r.id, r.title, r.due_date as "dueDate", r.is_completed as "isCompleted", r.contact_id as "contactId", r.recurrence, COALESCE(c.full_name, c.email) as "contactName"
      FROM reminders r
      LEFT JOIN contacts c ON r.contact_id = c.id
      WHERE r.user_id = $1
      ORDER BY r.due_date DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await db.query(query, [userId, limit, offset]);

    const countQuery = `SELECT COUNT(*) FROM reminders WHERE user_id = $1`;
    const countResult = await db.query(countQuery, [userId]);

    return {
      reminders: result.rows,
      total: parseInt(countResult.rows[0].count)
    };
  }

  static async create(contactId, userId, title, dueDate, recurrence) {
    const query = `
      INSERT INTO reminders (contact_id, user_id, title, due_date, recurrence) 
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, title, due_date as "dueDate", is_completed as "isCompleted", recurrence
    `;
    const result = await db.query(query, [contactId, userId, title, dueDate, recurrence || null]);
    return result.rows[0];
  }

  static async update(reminderId, userId, contactId, title, dueDate, isCompleted, recurrence) {
    const query = `
      UPDATE reminders 
      SET contact_id = COALESCE($1, contact_id),
          title = COALESCE($2, title),
          due_date = COALESCE($3, due_date),
          is_completed = COALESCE($4, is_completed),
          recurrence = COALESCE($5, recurrence),
          is_notified = CASE WHEN $3::timestamp IS NOT NULL THEN false ELSE is_notified END
      WHERE id = $6 AND user_id = $7
      RETURNING id, title, due_date as "dueDate", is_completed as "isCompleted", contact_id as "contactId", recurrence
    `;
    const result = await db.query(query, [contactId, title, dueDate, isCompleted, recurrence, reminderId, userId]);
    return result.rows[0];
  }

  static async delete(reminderId, userId) {
    const query = 'DELETE FROM reminders WHERE id = $1 AND user_id = $2';
    await db.query(query, [reminderId, userId]);
  }
}

module.exports = ReminderModel;
