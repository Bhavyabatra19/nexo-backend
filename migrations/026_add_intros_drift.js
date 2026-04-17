const up = async (client) => {
  console.log('Running migration 026: Add introductions and drift check-ins...');

  await client.query(`
    CREATE TABLE IF NOT EXISTS introduction_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
      requester_id UUID REFERENCES users(id) ON DELETE CASCADE,
      connector_id UUID REFERENCES users(id) ON DELETE CASCADE,
      target_contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
      context TEXT NOT NULL,
      preferred_method VARCHAR(20) DEFAULT 'email'
        CHECK (preferred_method IN ('email','whatsapp','linkedin')),
      status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending','approved','denied','expired','sent')),
      connector_note TEXT,
      ai_draft TEXT,
      requested_at TIMESTAMPTZ DEFAULT NOW(),
      responded_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')
    );
    CREATE INDEX IF NOT EXISTS idx_intros_requester ON introduction_requests(requester_id);
    CREATE INDEX IF NOT EXISTS idx_intros_connector ON introduction_requests(connector_id);
    CREATE INDEX IF NOT EXISTS idx_intros_status ON introduction_requests(status);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS drift_checkins (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      response VARCHAR(30)
        CHECK (response IN ('still_close','reconnect','snooze','downgrade',NULL)),
      snoozed_until TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_drift_checkins_user ON drift_checkins(user_id);
  `);

  await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS checkin_days_threshold INT DEFAULT 90,
      ADD COLUMN IF NOT EXISTS whatsapp_phone VARCHAR(30),
      ADD COLUMN IF NOT EXISTS nexo_username VARCHAR(100);
  `);

  console.log('Migration 026 complete');
};

const down = async (client) => {
  await client.query(`
    DROP TABLE IF EXISTS drift_checkins CASCADE;
    DROP TABLE IF EXISTS introduction_requests CASCADE;
    ALTER TABLE users
      DROP COLUMN IF EXISTS checkin_days_threshold,
      DROP COLUMN IF EXISTS whatsapp_phone,
      DROP COLUMN IF EXISTS nexo_username;
  `);
};

module.exports = { up, down };
