const updateRemindersTable = `
  ALTER TABLE reminders 
  ADD COLUMN IF NOT EXISTS is_notified BOOLEAN DEFAULT false;
`;

module.exports = {
  up: async (client) => {
    console.log('Running migration: Add is_notified to reminders table...');
    await client.query(updateRemindersTable);
    console.log('✓ Added is_notified to reminders table');
  },

  down: async (client) => {
    console.log('Rolling back migration...');
    await client.query('ALTER TABLE reminders DROP COLUMN IF EXISTS is_notified;');
    console.log('✓ Rollback completed');
  }
};
