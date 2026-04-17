const createNotesTable = `
  CREATE TABLE IF NOT EXISTS notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX idx_notes_user_id ON notes(user_id);
  CREATE INDEX idx_notes_contact_id ON notes(contact_id);

  -- Apply trigger to tables
  DROP TRIGGER IF EXISTS update_notes_updated_at ON notes;
  CREATE TRIGGER update_notes_updated_at 
    BEFORE UPDATE ON notes 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
`;

module.exports = {
  up: async (client) => {
    console.log('Running migration: Create notes table...');
    await client.query(createNotesTable);

    // Migrate existing notes from contacts table
    console.log('Migrating existing notes...');
    await client.query(`
      INSERT INTO notes (user_id, contact_id, content)
      SELECT user_id, id, notes 
      FROM contacts 
      WHERE notes IS NOT NULL AND notes != '';
    `);

    console.log('✓ Created notes table and migrated data');
  },

  down: async (client) => {
    console.log('Rolling back notes migration...');
    await client.query('DROP TABLE IF EXISTS notes CASCADE');
    console.log('✓ Rollback completed');
  }
};
