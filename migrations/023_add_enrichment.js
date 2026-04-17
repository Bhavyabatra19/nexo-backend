const up = async (client) => {
  console.log('Running migration 023: Add enrichment + confidence score...');

  await client.query(`
    ALTER TABLE contacts
      ADD COLUMN IF NOT EXISTS enrichment_status VARCHAR(20) DEFAULT 'pending'
        CHECK (enrichment_status IN ('pending','queued','enriching','enriched','failed','skipped')),
      ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS enrichment_provider VARCHAR(50),
      ADD COLUMN IF NOT EXISTS linkedin_url TEXT,
      ADD COLUMN IF NOT EXISTS bio TEXT,
      ADD COLUMN IF NOT EXISTS skills JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS experience JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS education JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS ai_summary TEXT,
      ADD COLUMN IF NOT EXISTS confidence_score FLOAT DEFAULT 0.0
        CHECK (confidence_score >= 0 AND confidence_score <= 1),
      ADD COLUMN IF NOT EXISTS confidence_breakdown JSONB DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS connection_tier VARCHAR(20) DEFAULT 'social'
        CHECK (connection_tier IN ('social','acquaintance','close')),
      ADD COLUMN IF NOT EXISTS tier_set_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS tier_set_by VARCHAR(20) DEFAULT 'system'
        CHECK (tier_set_by IN ('system','manual')),
      ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS private_sources TEXT[] DEFAULT '{}';
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS enrichment_usage (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
      provider VARCHAR(50),
      credits_used INT DEFAULT 1,
      enriched_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_enrichment_usage_user ON enrichment_usage(user_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_enrichment_status ON contacts(enrichment_status);
    CREATE INDEX IF NOT EXISTS idx_contacts_connection_tier ON contacts(connection_tier);
    CREATE INDEX IF NOT EXISTS idx_contacts_confidence ON contacts(confidence_score DESC);
    CREATE INDEX IF NOT EXISTS idx_contacts_linkedin_url ON contacts(linkedin_url);
  `);

  console.log('Migration 023 complete');
};

const down = async (client) => {
  await client.query(`DROP TABLE IF EXISTS enrichment_usage CASCADE;`);
  await client.query(`
    ALTER TABLE contacts
      DROP COLUMN IF EXISTS enrichment_status,
      DROP COLUMN IF EXISTS enriched_at,
      DROP COLUMN IF EXISTS enrichment_provider,
      DROP COLUMN IF EXISTS linkedin_url,
      DROP COLUMN IF EXISTS bio,
      DROP COLUMN IF EXISTS skills,
      DROP COLUMN IF EXISTS experience,
      DROP COLUMN IF EXISTS education,
      DROP COLUMN IF EXISTS ai_summary,
      DROP COLUMN IF EXISTS confidence_score,
      DROP COLUMN IF EXISTS confidence_breakdown,
      DROP COLUMN IF EXISTS connection_tier,
      DROP COLUMN IF EXISTS tier_set_at,
      DROP COLUMN IF EXISTS tier_set_by,
      DROP COLUMN IF EXISTS is_private,
      DROP COLUMN IF EXISTS private_sources;
  `);
};

module.exports = { up, down };
