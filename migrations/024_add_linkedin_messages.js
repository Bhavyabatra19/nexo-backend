const up = async (client) => {
  console.log('Running migration 024: Add LinkedIn messages table...');

  await client.query(`
    CREATE TABLE IF NOT EXISTS linkedin_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
      message_count INT DEFAULT 0,
      last_message_at TIMESTAMPTZ,
      parsed_at TIMESTAMPTZ DEFAULT NOW(),
      conversation_summary TEXT,
      topics_discussed TEXT[] DEFAULT '{}',
      sentiment VARCHAR(20) DEFAULT 'neutral'
        CHECK (sentiment IN ('warm','neutral','cold')),
      raw_hash VARCHAR(64),
      UNIQUE(user_id, contact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_linkedin_messages_user ON linkedin_messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_linkedin_messages_contact ON linkedin_messages(contact_id);
  `);

  console.log('Migration 024 complete');
};

const down = async (client) => {
  await client.query(`DROP TABLE IF EXISTS linkedin_messages CASCADE;`);
};

module.exports = { up, down };
