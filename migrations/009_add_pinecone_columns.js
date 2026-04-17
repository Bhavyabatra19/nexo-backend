/**
 * Migration: Add sync-lock and Pinecone-related columns to users and contacts tables
 * 
 * These columns are used by:
 * - routes/ai.js (Pinecone sync): last_pinecone_sync, is_pinecone_syncing
 * - routes/sync.js (Google sync): is_google_syncing
 * - routes/ai.js (embedding tracking): last_embedded on contacts
 */

module.exports = {
  up: async (client) => {
    console.log('Running migration: Add sync-lock and Pinecone columns...');

    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS last_pinecone_sync TIMESTAMP,
      ADD COLUMN IF NOT EXISTS is_pinecone_syncing BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS is_google_syncing BOOLEAN DEFAULT false;
    `);
    console.log('✓ Added last_pinecone_sync, is_pinecone_syncing, and is_google_syncing to users table');

    await client.query(`
      ALTER TABLE contacts 
      ADD COLUMN IF NOT EXISTS last_embedded TIMESTAMP;
    `);
    console.log('✓ Added last_embedded to contacts table');

    console.log('✓ Migration completed successfully');
  },

  down: async (client) => {
    console.log('Rolling back migration...');

    await client.query(`
      ALTER TABLE users 
      DROP COLUMN IF EXISTS last_pinecone_sync,
      DROP COLUMN IF EXISTS is_pinecone_syncing,
      DROP COLUMN IF EXISTS is_google_syncing;
    `);

    await client.query(`
      ALTER TABLE contacts 
      DROP COLUMN IF EXISTS last_embedded;
    `);

    console.log('✓ Rollback completed');
  }
};
