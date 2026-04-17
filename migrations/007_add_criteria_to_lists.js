module.exports = {
  up: async (client) => {
    console.log('Running migration 007: Add criteria to lists...');

    // Add criteria JSONB column to lists for dynamic list functionality
    await client.query(`
      ALTER TABLE lists 
      ADD COLUMN IF NOT EXISTS criteria JSONB DEFAULT NULL
    `);

    console.log('✓ Migration 007 complete');
  },

  down: async (client) => {
    await client.query('ALTER TABLE lists DROP COLUMN IF EXISTS criteria');
  }
};

