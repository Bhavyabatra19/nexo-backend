const up = async (client) => {
  console.log('Running migration 021: Add instagram_url and custom_links to contacts...');
  await client.query(`
    ALTER TABLE contacts
      ADD COLUMN IF NOT EXISTS instagram_url TEXT,
      ADD COLUMN IF NOT EXISTS custom_links JSONB DEFAULT '[]'
  `);
  console.log('Added instagram_url and custom_links columns to contacts table');
};

const down = async (client) => {
  await client.query(`
    ALTER TABLE contacts
      DROP COLUMN IF EXISTS instagram_url,
      DROP COLUMN IF EXISTS custom_links
  `);
};

module.exports = { up, down };
