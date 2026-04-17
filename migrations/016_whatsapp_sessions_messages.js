/**
 * Migration: Create whatsapp_sessions and whatsapp_messages tables
 *
 * Used by services/whatsappSessionService.js to support:
 * - Session-based multi-user WhatsApp conversations
 * - Full message history for AI context reconstruction
 * - Idempotency checks (WhatsApp message_id deduplication)
 */

module.exports = {
  up: async (client) => {
    console.log('Running migration: Create WhatsApp sessions and messages tables...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_sessions (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        session_status VARCHAR(20) NOT NULL DEFAULT 'active',
        last_activity  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_user_id
        ON whatsapp_sessions(user_id);

      CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_status
        ON whatsapp_sessions(session_status);

      CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_last_activity
        ON whatsapp_sessions(last_activity);
    `);
    console.log('✓ Created whatsapp_sessions table');

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id   UUID REFERENCES whatsapp_sessions(id) ON DELETE CASCADE NOT NULL,
        user_id      UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        message_id   VARCHAR(255),
        message      TEXT         NOT NULL,
        direction    VARCHAR(20)  NOT NULL,
        message_type VARCHAR(50)  NOT NULL DEFAULT 'text',
        timestamp    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_session_id
        ON whatsapp_messages(session_id);

      CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_user_id
        ON whatsapp_messages(user_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_message_id
        ON whatsapp_messages(message_id)
        WHERE message_id IS NOT NULL;
    `);
    console.log('✓ Created whatsapp_messages table');

    console.log('✓ Migration 016 completed successfully');
  },

  down: async (client) => {
    console.log('Rolling back migration 016: Drop WhatsApp tables...');

    await client.query(`DROP TABLE IF EXISTS whatsapp_messages;`);
    await client.query(`DROP TABLE IF EXISTS whatsapp_sessions;`);

    console.log('✓ Rollback completed');
  },
};
