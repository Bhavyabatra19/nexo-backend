const db = require('../db');

async function up() {
  console.log('Adding ai_summary column to contacts table...');
  await db.query(`
    ALTER TABLE contacts 
    ADD COLUMN IF NOT EXISTS ai_summary TEXT;
  `);
  console.log('Successfully added ai_summary column.');
}

async function down() {
  console.log('Removing ai_summary column from contacts table...');
  await db.query(`
    ALTER TABLE contacts 
    DROP COLUMN IF EXISTS ai_summary;
  `);
  console.log('Successfully removed ai_summary column.');
}

module.exports = {
  up,
  down
};
