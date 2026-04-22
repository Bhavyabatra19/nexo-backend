const up = async (client) => {
  console.log('Running migration 029: Add profile monitors + change history...');

  await client.query(`
    CREATE TABLE IF NOT EXISTS profile_monitors (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      linkedin_url    TEXT NOT NULL,
      frequency       VARCHAR(20) NOT NULL DEFAULT 'weekly'
                        CHECK (frequency IN ('daily','weekly','monthly')),
      last_checked_at TIMESTAMPTZ,
      next_check_at   TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days',
      last_snapshot   JSONB DEFAULT '{}',
      changes_detected INT NOT NULL DEFAULT 0,
      is_active       BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, contact_id)
    );

    CREATE INDEX IF NOT EXISTS idx_monitors_due
      ON profile_monitors(next_check_at)
      WHERE is_active = true;

    CREATE INDEX IF NOT EXISTS idx_monitors_user
      ON profile_monitors(user_id);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS profile_changes (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id     UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      changed_fields JSONB NOT NULL DEFAULT '{}',
      detected_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_profile_changes_contact
      ON profile_changes(contact_id, detected_at DESC);

    CREATE INDEX IF NOT EXISTS idx_profile_changes_user
      ON profile_changes(user_id, detected_at DESC);
  `);

  console.log('Migration 029 complete');
};

const down = async (client) => {
  await client.query(`
    DROP TABLE IF EXISTS profile_changes CASCADE;
    DROP TABLE IF EXISTS profile_monitors CASCADE;
  `);
};

module.exports = { up, down };
