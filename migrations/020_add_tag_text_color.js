const addTextColor = `
  ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS text_color VARCHAR(7) DEFAULT '#FFFFFF';
`;

async function up(client) {
  console.log('Running migration 020: Add text_color to tags...');
  await client.query(addTextColor);
  console.log('Added text_color column to tags table');
  console.log('Migration 020 completed successfully');
}

async function down(client) {
  await client.query('ALTER TABLE tags DROP COLUMN IF EXISTS text_color;');
}

module.exports = { up, down };
