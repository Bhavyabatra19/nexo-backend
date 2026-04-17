/**
 * Migration 019: Add performance indexes for 100 concurrent users
 *
 * These indexes target the most frequent query patterns identified
 * across contacts, AI chat, notes, reminders, tags, and sync routes.
 * All indexes are created CONCURRENTLY where possible to avoid
 * locking production tables during creation.
 */
module.exports = {
  async up(client) {
    const indexes = [
      // ── contacts ──────────────────────────────────────────────────
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_user_created
       ON contacts (user_id, created_at DESC)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_user_last_contacted
       ON contacts (user_id, last_contacted DESC NULLS LAST)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_user_favorite
       ON contacts (user_id) WHERE is_favorite = true`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_user_fullname
       ON contacts (user_id, full_name)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_user_company
       ON contacts (user_id, company)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_user_updated
       ON contacts (user_id, updated_at DESC)`,

      // ── notes ─────────────────────────────────────────────────────
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notes_contact_user
       ON notes (contact_id, user_id)`,

      // ── reminders ─────────────────────────────────────────────────
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reminders_contact_user
       ON reminders (contact_id, user_id)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reminders_pending_notifications
       ON reminders (due_date) WHERE is_completed = false AND is_notified = false`,

      // ── contact_tags ──────────────────────────────────────────────
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_tags_contact
       ON contact_tags (contact_id)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_tags_tag
       ON contact_tags (tag_id)`,

      // ── contact_lists ─────────────────────────────────────────────
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_lists_contact
       ON contact_lists (contact_id)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_lists_list
       ON contact_lists (list_id)`,

      // ── ai_chat_messages ──────────────────────────────────────────
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_chat_user_created
       ON ai_chat_messages (user_id, created_at DESC)`,

      // ── sync_history ──────────────────────────────────────────────
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sync_history_user_type_created
       ON sync_history (user_id, sync_type, created_at DESC)`,

      // ── calendar_events ───────────────────────────────────────────
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_calendar_events_user_start
       ON calendar_events (user_id, start_time DESC)`,
    ];

    // CREATE INDEX CONCURRENTLY cannot run inside a transaction,
    // so we commit the migration-runner's transaction first, run each
    // index, then re-open a transaction for the runner's bookkeeping.
    await client.query('COMMIT');

    for (const sql of indexes) {
      try {
        await client.query(sql);
      } catch (err) {
        // IF NOT EXISTS handles the case where index already exists;
        // log and continue if any individual index fails.
        console.warn(`Index creation warning: ${err.message}`);
      }
    }

    await client.query('BEGIN');
  },
};
