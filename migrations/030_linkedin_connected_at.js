/**
 * 030: linkedin_connected_at on contacts
 *
 * The Chrome extension parses "Connected MMM YYYY" text from each connection
 * card on /mynetwork/invite-connect/connections and sends it as
 * profileData.connected_at. Persist it so contact detail pages can show
 * "Connected on <date>" and sorting/grouping by recency works.
 *
 * Separate from `first_contacted` (when the USER first messaged/met them)
 * and `contact_created_date` (when the contacts row was created).
 */

const up = async (client) => {
  console.log('Running migration 030: Add linkedin_connected_at to contacts...');

  await client.query(`
    ALTER TABLE contacts
      ADD COLUMN IF NOT EXISTS linkedin_connected_at TIMESTAMPTZ;
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_contacts_linkedin_connected_at
      ON contacts(user_id, linkedin_connected_at DESC NULLS LAST);
  `);

  console.log('Migration 030 complete.');
};

const down = async (client) => {
  await client.query(`
    DROP INDEX IF EXISTS idx_contacts_linkedin_connected_at;
    ALTER TABLE contacts DROP COLUMN IF EXISTS linkedin_connected_at;
  `);
};

module.exports = { up, down };
