/**
 * 033: contacts.imported_for_group_id
 *
 * Lets a community owner bulk-upload contacts via CSV and tag each row with
 * the community it was imported for. The contact still belongs to the
 * uploader (user_id) — this column is purely provenance / filtering so the
 * UI can show "contacts I added on behalf of community X".
 *
 * Nullable because the vast majority of contacts come from Google sync /
 * LinkedIn import / manual add, none of which are scoped to a community.
 */

const up = async (client) => {
  console.log('Running migration 033: contacts.imported_for_group_id...');

  await client.query(`
    ALTER TABLE contacts
      ADD COLUMN IF NOT EXISTS imported_for_group_id UUID
        REFERENCES groups(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_contacts_imported_for_group
      ON contacts(imported_for_group_id) WHERE imported_for_group_id IS NOT NULL;
  `);

  console.log('Migration 033 complete.');
};

const down = async (client) => {
  await client.query(`
    DROP INDEX IF EXISTS idx_contacts_imported_for_group;
    ALTER TABLE contacts DROP COLUMN IF EXISTS imported_for_group_id;
  `);
};

module.exports = { up, down };
