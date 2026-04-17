// Migration 022: Add pinecone_namespace to contacts and re-index flag
// Switches architecture from flat index+filter to per-user namespaces
// enabling cross-user group search

const up = async (client) => {
  console.log('Running migration 022: Add Pinecone namespace support...');
  await client.query(`
    ALTER TABLE contacts
      ADD COLUMN IF NOT EXISTS pinecone_namespace VARCHAR(100),
      ADD COLUMN IF NOT EXISTS pinecone_indexed BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS pinecone_indexed_at TIMESTAMPTZ;
  `);

  // Backfill namespace for existing contacts (user_userId pattern)
  await client.query(`
    UPDATE contacts
    SET pinecone_namespace = 'user_' || user_id::text
    WHERE pinecone_namespace IS NULL;
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_contacts_pinecone_ns ON contacts(pinecone_namespace);
    CREATE INDEX IF NOT EXISTS idx_contacts_pinecone_indexed ON contacts(pinecone_indexed);
  `);

  console.log('Migration 022 complete');
};

const down = async (client) => {
  await client.query(`
    ALTER TABLE contacts
      DROP COLUMN IF EXISTS pinecone_namespace,
      DROP COLUMN IF EXISTS pinecone_indexed,
      DROP COLUMN IF EXISTS pinecone_indexed_at;
  `);
};

module.exports = { up, down };
