module.exports = {
  up: async (client) => {
    console.log('Running migration 006: Add recurrence to reminders and important_dates to contacts...');

    // Add recurrence column to reminders
    await client.query(`
      ALTER TABLE reminders 
      ADD COLUMN IF NOT EXISTS recurrence VARCHAR(20) DEFAULT NULL
    `);
    // Valid values: null, 'weekly', 'monthly', 'quarterly', 'yearly'

    // Add important_dates JSONB column to contacts
    await client.query(`
      ALTER TABLE contacts 
      ADD COLUMN IF NOT EXISTS important_dates JSONB DEFAULT '[]'::jsonb
    `);
    // Format: [{ "label": "Birthday", "date": "1995-06-15" }, { "label": "Anniversary", "date": "2020-03-10" }]

    console.log('✓ Migration 006 complete');
  },

  down: async (client) => {
    await client.query('ALTER TABLE reminders DROP COLUMN IF EXISTS recurrence');
    await client.query('ALTER TABLE contacts DROP COLUMN IF EXISTS important_dates');
  }
};

