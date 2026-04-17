const up = async (client) => {
  // Add bio (text), phones (JSONB array), emails (JSONB array) to contacts
  // The existing 'phone' and 'email' columns remain as the primary/display values
  await client.query(`
    ALTER TABLE contacts 
      ADD COLUMN IF NOT EXISTS bio TEXT,
      ADD COLUMN IF NOT EXISTS phones JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS emails JSONB DEFAULT '[]'
  `);
};

const down = async (client) => {
  await client.query(`
    ALTER TABLE contacts 
      DROP COLUMN IF EXISTS bio,
      DROP COLUMN IF EXISTS phones,
      DROP COLUMN IF EXISTS emails
  `);
};

module.exports = { up, down };
