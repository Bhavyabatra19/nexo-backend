/**
 * One-shot: re-enqueue contacts stuck in enrichment_status='queued' with no
 * active BullMQ job.
 *
 * Context: before the BullMQ-jobId colon fix, `enrichQueue.add('enrich', ...,
 * { jobId: \`enrich:${contactId}\` })` threw "Custom Id cannot contain :" after
 * the INSERT had committed. The contact got stuck in 'queued' forever because
 * the enqueue never happened.
 *
 * Run: node scripts/requeue-orphaned-enrichments.js
 *      node scripts/requeue-orphaned-enrichments.js --dry-run
 */

require('dotenv').config();
const db = require('../db');
const { enrichQueue } = require('../workers/queues');
const logger = require('../logger');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  // Find contacts that look orphaned: queued, from extension, old enough that
  // any legitimately in-flight job would already be done (>10 min).
  const { rows } = await db.query(`
    SELECT id, user_id, linkedin_url, full_name, created_at
    FROM contacts
    WHERE enrichment_status = 'queued'
      AND linkedin_url IS NOT NULL
      AND created_at < NOW() - INTERVAL '10 minutes'
    ORDER BY created_at ASC
  `);

  console.log(`[requeue] Found ${rows.length} orphaned queued contact(s)`);
  if (DRY_RUN) {
    rows.slice(0, 20).forEach(r => {
      console.log(`  ${r.id}  ${r.full_name || '(no name)'}  ${r.linkedin_url}`);
    });
    console.log('[requeue] dry-run — no jobs enqueued');
    process.exit(0);
  }

  let enqueued = 0, skipped = 0;
  for (const r of rows) {
    const jobId = `enrich_${r.id}`;
    // Skip if a job with this id already exists (BullMQ dedupes; double-check).
    const existing = await enrichQueue.getJob(jobId);
    if (existing && ['waiting', 'active', 'delayed'].includes(await existing.getState())) {
      skipped++;
      continue;
    }
    await enrichQueue.add(
      'enrich',
      { contactId: r.id, linkedinUrl: r.linkedin_url, userId: r.user_id },
      { jobId, priority: 5, attempts: 3, backoff: { type: 'exponential', delay: 2000 } }
    );
    enqueued++;
  }

  console.log(`[requeue] Enqueued ${enqueued}, skipped ${skipped} (already pending)`);
  process.exit(0);
}

main().catch((err) => {
  logger.error(`[requeue] failed: ${err.stack || err.message}`);
  console.error(err);
  process.exit(1);
});
