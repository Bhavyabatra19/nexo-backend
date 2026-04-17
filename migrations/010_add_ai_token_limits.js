/**
 * Migration: Add AI token tracking columns to users table
 * 
 * These columns are used by:
 * - services/aiTokenService.js (Daily limit enforcement)
 * - routes/ai.js (Usage tracking)
 */

module.exports = {
  up: async (client) => {
    console.log('Running migration: Add AI token tracking columns...');

    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS ai_tokens_used_today INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS ai_tokens_last_reset DATE DEFAULT CURRENT_DATE;
    `);
    console.log('✓ Added ai_tokens_used_today and ai_tokens_last_reset to users table');

    console.log('✓ Migration completed successfully');
  },

  down: async (client) => {
    console.log('Rolling back migration...');

    await client.query(`
      ALTER TABLE users 
      DROP COLUMN IF EXISTS ai_tokens_used_today,
      DROP COLUMN IF EXISTS ai_tokens_last_reset;
    `);

    console.log('✓ Rollback completed');
  }
};
