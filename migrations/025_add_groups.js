const up = async (client) => {
  console.log('Running migration 025: Add community groups...');

  await client.query(`
    CREATE TABLE IF NOT EXISTS groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      description TEXT,
      admin_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      invite_code VARCHAR(80) UNIQUE NOT NULL,
      logo_url TEXT,
      is_active BOOLEAN DEFAULT true,
      plan VARCHAR(20) DEFAULT 'community_pro',
      settings JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_groups_invite_code ON groups(invite_code);
    CREATE INDEX IF NOT EXISTS idx_groups_admin ON groups(admin_user_id);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS group_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('admin','member')),
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      linkedin_uploaded BOOLEAN DEFAULT false,
      google_synced BOOLEAN DEFAULT false,
      enrichment_coverage FLOAT DEFAULT 0,
      consent_given_at TIMESTAMPTZ,
      UNIQUE(group_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
    CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS group_search_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      query TEXT,
      result_count INT,
      scope VARCHAR(20),
      searched_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_group_search_events_group ON group_search_events(group_id);
  `);

  console.log('Migration 025 complete');
};

const down = async (client) => {
  await client.query(`
    DROP TABLE IF EXISTS group_search_events CASCADE;
    DROP TABLE IF EXISTS group_members CASCADE;
    DROP TABLE IF EXISTS groups CASCADE;
  `);
};

module.exports = { up, down };
