/**
 * 034: contacts social metrics + last-post snapshot
 *
 * Bright Data's LinkedIn profile dataset returns these fields but we had no
 * place to store them. Adding them here so the community-contact bulk
 * enrichment (Sprint 1 follow-up) can persist what the admin asked for:
 *   - connections_count / followers_count for network reach
 *   - last_post / last_post_at for recency-of-activity signal in the UI
 *
 * last_post is JSONB so we keep the full object (text, url, posted_at,
 * likes, comments) without forcing a separate posts table for what is, by
 * definition, just one row per contact.
 */

const up = async (client) => {
  console.log('Running migration 034: contacts social metrics + last_post...');

  await client.query(`
    ALTER TABLE contacts
      ADD COLUMN IF NOT EXISTS connections_count INT,
      ADD COLUMN IF NOT EXISTS followers_count   INT,
      ADD COLUMN IF NOT EXISTS last_post         JSONB,
      ADD COLUMN IF NOT EXISTS last_post_at      TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_contacts_followers
      ON contacts(followers_count DESC NULLS LAST);
    CREATE INDEX IF NOT EXISTS idx_contacts_last_post_at
      ON contacts(last_post_at DESC NULLS LAST);
  `);

  console.log('Migration 034 complete.');
};

const down = async (client) => {
  await client.query(`
    DROP INDEX IF EXISTS idx_contacts_last_post_at;
    DROP INDEX IF EXISTS idx_contacts_followers;
    ALTER TABLE contacts
      DROP COLUMN IF EXISTS last_post_at,
      DROP COLUMN IF EXISTS last_post,
      DROP COLUMN IF EXISTS followers_count,
      DROP COLUMN IF EXISTS connections_count;
  `);
};

module.exports = { up, down };
