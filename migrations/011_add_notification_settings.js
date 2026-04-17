const updateUsersTable = `
  ALTER TABLE users 
  ADD COLUMN IF NOT EXISTS notification_email BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS notification_whatsapp BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_number VARCHAR(50);
`;

module.exports = {
  up: async (client) => {
    console.log('Running migration: Add notification settings to users table...');
    
    await client.query(updateUsersTable);
    console.log('✓ Added notification_email, notification_whatsapp, and whatsapp_number to users table');
    
    console.log('✓ Migration completed successfully');
  },

  down: async (client) => {
    console.log('Rolling back migration...');
    
    await client.query(`
      ALTER TABLE users 
      DROP COLUMN IF EXISTS notification_email,
      DROP COLUMN IF EXISTS notification_whatsapp,
      DROP COLUMN IF EXISTS whatsapp_number;
    `);
    
    console.log('✓ Rollback completed');
  }
};
