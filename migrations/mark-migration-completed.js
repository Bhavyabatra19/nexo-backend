require('dotenv').config();
const db = require('../db');

/**
 * Mark Migration as Completed
 * Use this if you've already run a migration manually or have existing tables
 */

async function markMigrationCompleted(migrationName) {
  try {
    // Create migrations table if it doesn't exist
    await db.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Mark migration as completed
    await db.query(`
      INSERT INTO migrations (name, executed_at)
      VALUES ($1, CURRENT_TIMESTAMP)
      ON CONFLICT (name) DO NOTHING
    `, [migrationName]);

    console.log(`✅ Marked migration "${migrationName}" as completed`);

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await db.pool.end();
  }
}

// Get migration name from command line
const migrationName = process.argv[2];

if (!migrationName) {
  console.log('Usage: node mark-migration-completed.js <migration-name>');
  console.log('Example: node mark-migration-completed.js 001_create_tables.js');
  process.exit(1);
}

markMigrationCompleted(migrationName);