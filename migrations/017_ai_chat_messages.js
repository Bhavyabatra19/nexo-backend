module.exports = {
  up: async (client) => {
    console.log('Running migration 017: Create ai_chat_messages table...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_chat_messages (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        role       VARCHAR(20) NOT NULL,
        content    TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_user_created
        ON ai_chat_messages(user_id, created_at DESC);
    `);

    console.log('✓ Migration 017 completed successfully');
  },

  down: async (client) => {
    console.log('Rolling back migration 017...');
    await client.query(`DROP TABLE IF EXISTS ai_chat_messages;`);
    console.log('✓ Rollback completed');
  },
};
