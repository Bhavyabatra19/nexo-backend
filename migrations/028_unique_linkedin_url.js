const up = async (client) => {
  console.log('Running migration 028: Add unique index on (user_id, linkedin_url)...');

  // Remove duplicate (user_id, linkedin_url) rows, keeping the most recently enriched one
  await client.query(`
    DELETE FROM contacts
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY user_id, linkedin_url
                 ORDER BY COALESCE(enriched_at, created_at) DESC
               ) AS rn
        FROM contacts
        WHERE linkedin_url IS NOT NULL
      ) t
      WHERE rn > 1
    )
  `);

  // Drop old non-unique index if it exists, then create unique partial index
  await client.query(`
    DROP INDEX IF EXISTS idx_contacts_linkedin_url;
  `);

  await client.query(`
    CREATE UNIQUE INDEX idx_contacts_linkedin_url_unique
      ON contacts (user_id, linkedin_url)
      WHERE linkedin_url IS NOT NULL;
  `);

  console.log('Migration 028 complete');
};

const down = async (client) => {
  await client.query(`DROP INDEX IF EXISTS idx_contacts_linkedin_url_unique;`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_contacts_linkedin_url ON contacts(linkedin_url);
  `);
};

module.exports = { up, down };
