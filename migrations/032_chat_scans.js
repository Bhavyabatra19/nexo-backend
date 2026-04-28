/**
 * 032: Chat-based network scans
 *
 * Sprint 1 P0. Persists each natural-language network scan a user runs from
 * the chat surface so the worker can run it async, the API can poll status,
 * and we can replay/cache identical queries.
 *
 *   query        — raw text the user typed
 *   parsed       — { role, industry, geo, stage, keywords[], ... } from the LLM
 *   scope        — { include_own: bool, group_ids: uuid[] } — what was searched
 *   status       — queued | running | completed | failed
 *   results      — top-N ranked rows (denormalized so polling is one row read)
 *   error        — failure message
 *
 * Distinct from the older mig-027 `network_overlaps` / `group_contacts`
 * machinery — those are the data the scan READS over.
 */

const up = async (client) => {
  console.log('Running migration 032: chat-based network scans...');

  await client.query(`
    CREATE TABLE IF NOT EXISTS scans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      query TEXT NOT NULL,
      parsed JSONB NOT NULL DEFAULT '{}',
      scope JSONB NOT NULL DEFAULT '{}',
      status VARCHAR(20) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','completed','failed')),
      result_count INT NOT NULL DEFAULT 0,
      results JSONB NOT NULL DEFAULT '[]',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      duration_ms INT
    );
    CREATE INDEX IF NOT EXISTS idx_scans_user_created
      ON scans(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scans_status
      ON scans(status) WHERE status IN ('queued','running');
  `);

  console.log('Migration 032 complete.');
};

const down = async (client) => {
  await client.query(`DROP TABLE IF EXISTS scans CASCADE;`);
};

module.exports = { up, down };
