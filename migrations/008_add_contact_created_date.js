module.exports = {
  up: async (client) => {
    console.log('Running migration 008: Add contact_created_date to contacts...');
    await client.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_created_date TIMESTAMP WITH TIME ZONE DEFAULT NULL');
    console.log('✓ Migration 008 complete');
  },

  down: async (client) => {
    await client.query('ALTER TABLE contacts DROP COLUMN IF EXISTS contact_created_date');
  }
};