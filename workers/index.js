/**
 * Worker process — run separately with: npm run worker
 * Processes all BullMQ queues.
 */

require('dotenv').config();
const { Worker } = require('bullmq');
const { getRedisConnection } = require('./queues');
const logger = require('../logger');

const { enrichContact } = require('../services/enrichment/adapter');
const { recomputeConfidence, recomputeUserConfidence } = require('../services/confidence');
const { processMessagesForUser } = require('../services/messageParser');
const { runNetworkScan } = require('../services/networkScan');
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

// Error handlers
[enrichmentWorker, embeddingWorker, messageWorker, networkWorker, notificationWorker].forEach(w => {
  w.on('failed', (job, err) => {
    logger.error(`[Worker] Job ${job?.id} in ${w.name} failed: ${err.message}`);

    // Reset enriching contacts to 'failed' so they don't get permanently stuck
    if (w.name === 'enrichment' && job?.data?.contactId) {
      db.query(
        `UPDATE contacts SET enrichment_status = 'failed' WHERE id = $1 AND enrichment_status = 'enriching'`,
        [job.data.contactId]
      ).catch(dbErr => logger.error(`[Worker] Failed to reset enrichment status: ${dbErr.message}`));
    }
  });
});

logger.info('Workers running: enrichment, embedding, message-parse, network-scan, notifications');

module.exports = { enrichmentWorker, embeddingWorker, messageWorker, networkWorker, notificationWorker };
