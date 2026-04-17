const createActivitiesTable = `
  CREATE TABLE IF NOT EXISTS activities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_activities_contact_id ON activities(contact_id);
  CREATE INDEX IF NOT EXISTS idx_activities_user_id ON activities(user_id);
`;

module.exports = {
  up: async (client) => {
    console.log('Running migration: Create activities table...');
    await client.query(createActivitiesTable);
    console.log('✓ Created activities table');
  },

  down: async (client) => {
    console.log('Rolling back activities migration...');
    await client.query('DROP TABLE IF EXISTS activities CASCADE');
    console.log('✓ Rollback completed');
  }
};
