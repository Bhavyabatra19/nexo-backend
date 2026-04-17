/**
 * Migration: Add LinkedIn URL column to contacts table
 */

module.exports = {
  up: async (client) => {
    console.log('Adding linkedin_url column to contacts table...');
    
    await client.query(`
      ALTER TABLE contacts
      ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
    `);
    
    console.log('✓ Added linkedin_url column');
    
    // Create index for faster lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_contacts_linkedin_url 
      ON contacts(linkedin_url);
    `);
    
    console.log('✓ Created index on linkedin_url');
  },

  down: async (client) => {
    console.log('Removing linkedin_url column...');
    
    await client.query(`
      DROP INDEX IF EXISTS idx_contacts_linkedin_url;
    `);
    
    await client.query(`
      ALTER TABLE contacts
      DROP COLUMN IF EXISTS linkedin_url;
    `);
    
    console.log('✓ Rollback completed');
  }
};