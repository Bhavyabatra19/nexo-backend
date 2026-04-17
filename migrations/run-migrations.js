require('dotenv').config();
const db = require('../db');
const fs = require('fs');
const path = require('path');

/**
 * Migration Runner with Tracking
 * Keeps track of which migrations have been run
 */

async function createMigrationsTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  
  await db.query(query);
  console.log('✓ Migrations tracking table ready\n');
}

async function getExecutedMigrations() {
  const result = await db.query(`
    SELECT name FROM migrations ORDER BY id ASC
  `);
  
  return result.rows.map(row => row.name);
}

async function runMigrations() {
  console.log('🚀 Starting database migrations...\n');

  try {
    // Create migrations tracking table
    await createMigrationsTable();
    
    // Get list of executed migrations
    const executedMigrations = await getExecutedMigrations();
    console.log(`Already executed: ${executedMigrations.length} migration(s)`);
    if (executedMigrations.length > 0) {
      executedMigrations.forEach(name => console.log(`  ✓ ${name}`));
      console.log('');
    }

    // Get all migration files
    const migrationsDir = __dirname;
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(file => /^\d{3}_.*\.js$/.test(file))
      .sort();

    console.log(`Found ${migrationFiles.length} total migration file(s)\n`);

    // Filter out already executed migrations
    const pendingMigrations = migrationFiles.filter(
      file => !executedMigrations.includes(file)
    );

    if (pendingMigrations.length === 0) {
      console.log('✅ No pending migrations - database is up to date!\n');
      return;
    }

    console.log(`Pending: ${pendingMigrations.length} migration(s) to run\n`);

    // Run each pending migration
    for (const file of pendingMigrations) {
      console.log(`📄 Running migration: ${file}`);
      
      const client = await db.getClient();
      
      try {
        await client.query('BEGIN');

        const migration = require(path.join(migrationsDir, file));
        
        if (typeof migration.up === 'function') {
          await migration.up(client);
          
          // Mark as executed
          await client.query(`
            INSERT INTO migrations (name) VALUES ($1)
          `, [file]);
          
          await client.query('COMMIT');
          console.log(`✅ Migration ${file} completed successfully\n`);
        } else {
          await client.query('ROLLBACK');
          console.log(`⚠️  Migration ${file} does not have an 'up' function, skipping\n`);
        }

      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`❌ Migration ${file} failed:`, error.message);
        console.error('\nRolling back this migration...\n');
        throw error;
      } finally {
        client.release();
      }
    }

    console.log('✅ All pending migrations completed successfully!\n');

  } catch (error) {
    console.error('❌ Migration process failed:', error.message);
    process.exit(1);
  } finally {
    await db.pool.end();
  }
}

// Run migrations if called directly
if (require.main === module) {
  runMigrations();
}

module.exports = runMigrations;