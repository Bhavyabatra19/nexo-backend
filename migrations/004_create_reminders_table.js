const createRemindersTable = `
  CREATE TABLE IF NOT EXISTS reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    due_date TIMESTAMP NOT NULL,
    is_completed BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX idx_reminders_user_id ON reminders(user_id);
  CREATE INDEX idx_reminders_contact_id ON reminders(contact_id);

  -- Apply trigger to tables
  DROP TRIGGER IF EXISTS update_reminders_updated_at ON reminders;
  CREATE TRIGGER update_reminders_updated_at 
    BEFORE UPDATE ON reminders 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
`;

module.exports = {
  up: async (client) => {
    console.log('Running migration: Create reminders table...');
    await client.query(createRemindersTable);
    console.log('✓ Created reminders table');
  },

  down: async (client) => {
    console.log('Rolling back reminders migration...');
    await client.query('DROP TABLE IF EXISTS reminders CASCADE');
    console.log('✓ Rollback completed');
  }
};
