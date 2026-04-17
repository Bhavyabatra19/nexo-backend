/**
 * Migration: Create user_jobs table
 *
 * Persists background job state (LinkedIn import, dedup) across:
 * - Page reloads and tab closes
 * - Server restarts (processing state detected, gracefully reset to idle)
 *
 * Job lifecycle:
 *   processing     → job is running in-memory; job_id references in-memory Map
 *   pending_review → job completed; result stored in DB awaiting user action
 *   (deleted)      → user took action (imported / applied merges / cancelled)
 *
 * Only one active (processing | pending_review) job per user per job_type
 * is enforced by the partial unique index.
 */

module.exports = {
  up: async (client) => {
    console.log('Running migration 018: Create user_jobs table...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_jobs (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
        job_type    VARCHAR(50)  NOT NULL,
        status      VARCHAR(30)  NOT NULL,
        job_id      VARCHAR(255),
        result      JSONB,
        metadata    JSONB,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_user_jobs_user_type
        ON user_jobs(user_id, job_type);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_jobs_active
        ON user_jobs(user_id, job_type)
        WHERE status IN ('processing', 'pending_review');
    `);

    console.log('✓ Created user_jobs table');
    console.log('✓ Migration 018 completed successfully');
  },

  down: async (client) => {
    console.log('Rolling back migration 018: Drop user_jobs table...');
    await client.query(`DROP TABLE IF EXISTS user_jobs;`);
    console.log('✓ Rollback completed');
  },
};
