const up = async (client) => {
  // Add title column to notes table
  await client.query(`
    ALTER TABLE notes 
      ADD COLUMN IF NOT EXISTS title VARCHAR(255)
  `);
};

const down = async (client) => {
  await client.query(`
    ALTER TABLE notes 
      DROP COLUMN IF EXISTS title
  `);
};

module.exports = { up, down };
