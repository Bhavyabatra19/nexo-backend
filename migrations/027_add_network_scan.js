// Migration 027: Network-of-network scan tables
// Tracks cross-member contact overlap for confidence boosting

const up = async (client) => {
  console.log('Running migration 027: Add network scan tables...');

  // Tracks when two members in the same group both know the same real-world person
  // Identified by matching linkedin_url (strongest) or email (fallback)
  await client.query(`
    CREATE TABLE IF NOT EXISTS network_overlaps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
      contact_a_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
      contact_b_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
      match_field VARCHAR(20) NOT NULL CHECK (match_field IN ('linkedin_url','email','name_company')),
      match_value TEXT NOT NULL,
      confidence_contribution FLOAT DEFAULT 0.05,
      detected_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(group_id, contact_a_id, contact_b_id)
    );
    CREATE INDEX IF NOT EXISTS idx_overlaps_group ON network_overlaps(group_id);
    CREATE INDEX IF NOT EXISTS idx_overlaps_match ON network_overlaps(match_value);
  `);

  // Canonical contact record: when multiple members know the same person,
  // we create a group-level "canonical" view (name+title+company only, no PII)
  await client.query(`
    CREATE TABLE IF NOT EXISTS group_contacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
      canonical_name VARCHAR(255),
      canonical_title VARCHAR(255),
      canonical_company VARCHAR(255),
      linkedin_url TEXT,
      member_contact_ids UUID[] DEFAULT '{}',
      known_by_count INT DEFAULT 1,
      aggregate_confidence FLOAT DEFAULT 0.0,
      highest_tier VARCHAR(20) DEFAULT 'social',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_group_contacts_group ON group_contacts(group_id);
    CREATE INDEX IF NOT EXISTS idx_group_contacts_linkedin ON group_contacts(linkedin_url);
    CREATE INDEX IF NOT EXISTS idx_group_contacts_confidence ON group_contacts(aggregate_confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_group_contacts_known_by ON group_contacts(known_by_count DESC);
  `);

  // LinkedIn scrape log: tracks what data came in via Chrome extension
  await client.query(`
    CREATE TABLE IF NOT EXISTS linkedin_scrape_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      linkedin_url TEXT NOT NULL,
      source VARCHAR(30) DEFAULT 'extension'
        CHECK (source IN ('extension','csv','manual')),
      raw_data JSONB DEFAULT '{}',
      processed BOOLEAN DEFAULT false,
      contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
      scraped_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_scrape_log_user ON linkedin_scrape_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_scrape_log_url ON linkedin_scrape_log(linkedin_url);
    CREATE INDEX IF NOT EXISTS idx_scrape_log_processed ON linkedin_scrape_log(processed);
  `);

  console.log('Migration 027 complete');
};

const down = async (client) => {
  await client.query(`
    DROP TABLE IF EXISTS linkedin_scrape_log CASCADE;
    DROP TABLE IF EXISTS group_contacts CASCADE;
    DROP TABLE IF EXISTS network_overlaps CASCADE;
  `);
};

module.exports = { up, down };
