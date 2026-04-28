/**
 * Worker process — run separately with: npm run worker
 * Processes all BullMQ queues.
 */

require('dotenv').config();
const { Worker } = require('bullmq');
const { getRedisConnection } = require('./queues');
const logger = require('../logger');

const { enrichContact, enrichBulkViaBrightData } = require('../services/enrichment/adapter');
const { recomputeConfidence, recomputeUserConfidence } = require('../services/confidence');
const { processMessagesForUser } = require('../services/messageParser');
const { runNetworkScan } = require('../services/networkScan');
const { runScan: runScanQuery } = require('../services/scanOrchestrator');
const pineconeService = require('../services/pineconeService');
const db = require('../db');

const conn = getRedisConnection();

// ─── Enrichment Worker ─────────────────────────────────────────────────────
const enrichmentWorker = new Worker('enrichment', async (job) => {
  const { contactId, linkedinUrl, userId } = job.data;
  logger.info(`[Worker:Enrich] Processing contact ${contactId}`);

  await db.query(
    `UPDATE contacts SET enrichment_status = 'enriching' WHERE id = $1`,
    [contactId]
  );

  const result = await enrichContact(contactId, linkedinUrl, userId);
  if (result) {
    await recomputeConfidence(contactId);
    // Queue re-embedding with enriched data
    const { embedQueue } = require('./queues');
    await embedQueue.add('embed', { contactId, userId }, { priority: 3 });
    logger.info(`[Worker:Enrich] ✓ Enriched contact ${contactId} via ${result._provider}`);
  }
}, { connection: conn, concurrency: 5 });

// ─── Embedding Worker ──────────────────────────────────────────────────────
const embeddingWorker = new Worker('embedding', async (job) => {
  const { contactId, userId } = job.data;
  logger.info(`[Worker:Embed] Embedding contact ${contactId}`);

  const { rows } = await db.query(
    `SELECT * FROM contacts WHERE id = $1 AND user_id = $2`,
    [contactId, userId]
  );
  if (!rows.length) return;

  // Fetch message summary for richer embedding
  const { rows: msgs } = await db.query(
    `SELECT conversation_summary, topics_discussed FROM linkedin_messages
     WHERE contact_id = $1 LIMIT 1`,
    [contactId]
  );

  const contact = {
    ...rows[0],
    messagesSummary: msgs[0]?.conversation_summary || null,
    topics:          msgs[0]?.topics_discussed || [],
  };

  await pineconeService.upsertContact(userId, contact);

  await db.query(
    `UPDATE contacts SET pinecone_indexed = true, pinecone_indexed_at = NOW() WHERE id = $1`,
    [contactId]
  );
}, { connection: conn, concurrency: 10 });

// ─── Message Parse Worker ──────────────────────────────────────────────────
const messageWorker = new Worker('message-parse', async (job) => {
  const { userId, csvContent } = job.data;
  logger.info(`[Worker:Messages] Parsing messages for user ${userId}`);
  const result = await processMessagesForUser(userId, csvContent);
  logger.info(`[Worker:Messages] Done: ${JSON.stringify(result)}`);
  return result;
}, { connection: conn, concurrency: 2 });

// ─── Network Scan Worker ───────────────────────────────────────────────────
const networkWorker = new Worker('network-scan', async (job) => {
  const { userId, groupId } = job.data;
  logger.info(`[Worker:NetworkScan] Scanning user ${userId} in group ${groupId}`);
  const result = await runNetworkScan(userId, groupId);
  logger.info(`[Worker:NetworkScan] Done: ${JSON.stringify(result)}`);
  return result;
}, { connection: conn, concurrency: 3 });

// ─── Bulk Enrichment Worker (Bright Data, community CSV flow) ──────────────
// Receives { userId, contactIds[], linkedinByContact: {id: url} } and runs
// enrichBulkViaBrightData. Each Bright Data trigger handles up to 100 URLs
// internally; we loop in 100-URL batches here only as a safety net.
const enrichBulkWorker = new Worker('enrich-bulk', async (job) => {
  const { userId, items } = job.data;
  if (!Array.isArray(items) || !items.length) return { enriched: 0, failed: 0 };
  logger.info(`[Worker:EnrichBulk] ${items.length} contacts for user ${userId}`);
  const result = await enrichBulkViaBrightData(items, userId);
  // Re-embed enriched contacts so the network scan sees fresh vectors.
  const { embedQueue } = require('./queues');
  for (const it of items) {
    embedQueue.add('embed', { contactId: it.contactId, userId }, { jobId: `embed_${it.contactId}` })
      .catch(() => {});
  }
  logger.info(`[Worker:EnrichBulk] done — enriched=${result.enriched} failed=${result.failed}`);
  return result;
}, { connection: conn, concurrency: 1 });

// ─── Scan Query Worker (chat-based network-of-network scan) ────────────────
const scanQueryWorker = new Worker('scan-query', async (job) => {
  const { scanId } = job.data;
  logger.info(`[Worker:Scan] Running scan ${scanId}`);
  return await runScanQuery(scanId);
}, { connection: conn, concurrency: 4 });

// ─── Notification Worker ───────────────────────────────────────────────────
const notificationWorker = new Worker('notifications', async (job) => {
  const { type, ...data } = job.data;
  logger.info(`[Worker:Notify] Processing ${type}`);

  if (type === 'intro_request') {
    await handleIntroNotification(data);
  } else if (type === 'drift_checkin') {
    await handleDriftCheckin(data);
  } else if (type === 'weekly_digest') {
    await handleWeeklyDigest(data);
  }
}, { connection: conn, concurrency: 10 });

async function handleIntroNotification({ introId, connectorId, requesterName, targetName, context }) {
  const { rows } = await db.query(
    `SELECT u.full_name, u.email, u.whatsapp_phone FROM users u WHERE u.id = $1`,
    [connectorId]
  );
  if (!rows.length) return;
  const connector = rows[0];

  const { notificationService } = require('../services/notificationService');
  const message = `${requesterName} is asking for an intro to ${targetName} via you.\nContext: "${context}"\nReply on Nexo to approve or decline.`;

  await notificationService.sendEmail(connector.email, `Intro request: ${requesterName} → ${targetName}`, message);
  if (connector.whatsapp_phone) {
    await notificationService.sendWhatsApp(connector.whatsapp_phone, message);
  }
}

async function handleDriftCheckin({ userId, contactId, contactName }) {
  const { rows } = await db.query(
    `SELECT u.email, u.whatsapp_phone FROM users u WHERE u.id = $1`,
    [userId]
  );
  if (!rows.length) return;
  const user = rows[0];
  const { notificationService } = require('../services/notificationService');
  const message = `You haven't logged any interaction with ${contactName} in a while. Still in touch?\n1. Yes, we talk regularly\n2. No, let's reconnect\n3. Remind me later\n4. We're no longer close`;

  if (user.whatsapp_phone) {
    await notificationService.sendWhatsApp(user.whatsapp_phone, message);
  }
}

async function handleWeeklyDigest({ groupId }) {
  const { rows: group } = await db.query(
    `SELECT g.*, u.email as admin_email FROM groups g
     JOIN users u ON u.id = g.admin_user_id WHERE g.id = $1`,
    [groupId]
  );
  if (!group.length) return;

  const { rows: stats } = await db.query(`
    SELECT
      COUNT(DISTINCT gm.user_id) FILTER (WHERE gm.joined_at > NOW() - INTERVAL '7 days') as new_members,
      COUNT(DISTINCT gse.id) FILTER (WHERE gse.searched_at > NOW() - INTERVAL '7 days') as searches,
      COUNT(DISTINCT ir.id) FILTER (WHERE ir.requested_at > NOW() - INTERVAL '7 days') as intros
    FROM groups g
    LEFT JOIN group_members gm ON gm.group_id = g.id
    LEFT JOIN group_search_events gse ON gse.group_id = g.id
    LEFT JOIN introduction_requests ir ON ir.group_id = g.id
    WHERE g.id = $1
  `, [groupId]);

  const s = stats[0];
  const { notificationService } = require('../services/notificationService');
  const body = `Weekly digest for ${group[0].name}:\n• ${s.new_members} new members\n• ${s.searches} searches\n• ${s.intros} intro requests`;
  await notificationService.sendEmail(group[0].admin_email, `Weekly digest: ${group[0].name}`, body);
}

// ─── Profile Monitor Worker ────────────────────────────────────────────────
const FREQUENCY_INTERVALS = {
  daily:   24 * 60 * 60 * 1000,
  weekly:  7  * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

const profileMonitorWorker = new Worker('profile-monitor', async (job) => {
  const { monitorId, contactId, linkedinUrl, userId } = job.data;
  logger.info(`[Worker:Monitor] Checking ${linkedinUrl}`);

  const { rows: [contact] } = await db.query(
    `SELECT job_title, company, bio, experience, education, skills FROM contacts WHERE id = $1`,
    [contactId]
  );

  if (!contact) {
    await db.query(`UPDATE profile_monitors SET is_active = false WHERE id = $1`, [monitorId]);
    return;
  }

  const oldSnapshot = {
    job_title: contact.job_title,
    company:   contact.company,
    bio:       contact.bio,
  };

  await enrichContact(contactId, linkedinUrl, userId);

  const { rows: [updated] } = await db.query(
    `SELECT job_title, company, bio FROM contacts WHERE id = $1`,
    [contactId]
  );

  const changedFields = {};
  for (const field of ['job_title', 'company', 'bio']) {
    if (updated[field] && updated[field] !== oldSnapshot[field]) {
      changedFields[field] = { old: oldSnapshot[field], new: updated[field] };
    }
  }

  if (Object.keys(changedFields).length > 0) {
    await db.query(
      `INSERT INTO profile_changes (user_id, contact_id, changed_fields) VALUES ($1, $2, $3)`,
      [userId, contactId, JSON.stringify(changedFields)]
    );

    await db.query(
      `UPDATE profile_monitors SET changes_detected = changes_detected + 1 WHERE id = $1`,
      [monitorId]
    );

    const changeDesc = Object.entries(changedFields)
      .map(([f, v]) => `${f}: "${v.old}" → "${v.new}"`)
      .join(', ');

    await db.query(
      `INSERT INTO activities (user_id, contact_id, type, description)
       VALUES ($1, $2, 'contact_updated', $3)
       ON CONFLICT DO NOTHING`,
      [userId, contactId, `LinkedIn profile updated: ${changeDesc}`]
    );

    logger.info(`[Worker:Monitor] Changes for ${linkedinUrl}: ${changeDesc}`);
  }

  // Schedule next check
  const { rows: [monitor] } = await db.query(
    `SELECT frequency FROM profile_monitors WHERE id = $1`, [monitorId]
  );
  const interval = FREQUENCY_INTERVALS[monitor?.frequency] || FREQUENCY_INTERVALS.weekly;
  await db.query(
    `UPDATE profile_monitors SET last_checked_at = NOW(), next_check_at = $1 WHERE id = $2`,
    [new Date(Date.now() + interval), monitorId]
  );
}, { connection: conn, concurrency: 5 });

// Error handlers
[enrichmentWorker, embeddingWorker, messageWorker, networkWorker, scanQueryWorker, enrichBulkWorker, notificationWorker, profileMonitorWorker].forEach(w => {
  w.on('failed', (job, err) => {
    logger.error(`[Worker] Job ${job?.id} in ${w.name} failed: ${err.message}`);

    if (w.name === 'enrichment' && job?.data?.contactId) {
      db.query(
        `UPDATE contacts SET enrichment_status = 'failed' WHERE id = $1 AND enrichment_status = 'enriching'`,
        [job.data.contactId]
      ).catch(dbErr => logger.error(`[Worker] Failed to reset enrichment status: ${dbErr.message}`));
    }
  });
});

logger.info('Workers running: enrichment, embedding, message-parse, network-scan, scan-query, enrich-bulk, notifications, profile-monitor');

module.exports = { enrichmentWorker, embeddingWorker, messageWorker, networkWorker, scanQueryWorker, enrichBulkWorker, notificationWorker, profileMonitorWorker };
