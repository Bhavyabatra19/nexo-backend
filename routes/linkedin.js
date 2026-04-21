const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const { authenticateToken } = require('../middleware/auth');
const LinkedInImportModel = require('../models/LinkedInImport');
const aiDeduplicationService = require('../services/aiDeduplicationService');
const AITokenService = require('../services/aiTokenService');
const db = require('../db');
const { messageParseQueue, enrichQueue, networkScanQueue } = require('../workers/queues');
const { recomputeUserConfidence } = require('../services/confidence');
const logger = require('../logger');
const { fetchAllConnections } = require('../services/linkedin/voyagerConnections');
const { processConnectionsBatch } = require('../services/linkedinScraper');
const { enrichBulkViaBrightData } = require('../services/enrichment/adapter');

/**
 * LinkedIn Import Routes — v2
 * Accepts connections.csv AND messages.csv (both files or zip)
 * Files stored in S3 (if configured) or memory fallback
 */

// S3 upload helper (optional — falls back to memory)
async function uploadToS3(buffer, key) {
  if (!process.env.AWS_S3_BUCKET) return null;
  try {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
    await s3.send(new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key:    key,
      Body:   buffer,
    }));
    return key;
  } catch (err) {
    logger.warn(`[LinkedIn] S3 upload failed, continuing without: ${err.message}`);
    return null;
  }
}

// In-memory job store for active (processing) jobs only.
// Results are persisted to user_jobs table when done.
const importJobs = new Map();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of importJobs) {
    if (job.createdAt < cutoff) importJobs.delete(id);
  }
}, 5 * 60 * 1000);

// Configure multer — memory storage (S3 upload happens after parse)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024 // 25MB limit (zip files)
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv') || file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV or ZIP files are allowed'));
    }
  }
});

// Accept both connections.csv and messages.csv in one request
const uploadFields = upload.fields([
  { name: 'connections', maxCount: 1 },
  { name: 'messages',    maxCount: 1 },
  { name: 'file',        maxCount: 1 }, // legacy single-file upload
]);

/**
 * GET /api/linkedin/status
 * Returns the current LinkedIn import job state for the authenticated user.
 * Used on page load to restore state across reloads / tab closes.
 *
 * Responses:
 *   { status: 'idle' }
 *   { status: 'processing', jobId, progress, fileName, fileSize }
 *   { status: 'pending_review', analysis, importData, fileName, fileSize }
 *   { status: 'idle', notice: '...' }  ← job lost on server restart
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM user_jobs
       WHERE user_id = $1 AND job_type = 'linkedin_import'
         AND status IN ('processing', 'pending_review')
       LIMIT 1`,
      [req.userId]
    );

    if (rows.length === 0) return res.json({ success: true, status: 'idle' });

    const row = rows[0];
    const meta = row.metadata || {};

    if (row.status === 'processing') {
      const inMemJob = row.job_id ? importJobs.get(row.job_id) : null;
      if (inMemJob) {
        return res.json({
          success: true,
          status: 'processing',
          jobId: row.job_id,
          progress: inMemJob.progress,
          fileName: meta.fileName,
          fileSize: meta.fileSize,
        });
      }
      // Server restarted — job is gone; clean up DB and return idle
      await db.query(`DELETE FROM user_jobs WHERE id = $1`, [row.id]);
      return res.json({
        success: true,
        status: 'idle',
        notice: 'The previous import was interrupted by a server restart. Please upload your file again.',
      });
    }

    if (row.status === 'pending_review') {
      return res.json({
        success: true,
        status: 'pending_review',
        analysis: row.result?.analysis,
        importData: row.result?.importData,
        fileName: meta.fileName,
        fileSize: meta.fileSize,
      });
    }

    return res.json({ success: true, status: 'idle' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/linkedin/upload
 * Accepts connections.csv + optional messages.csv (or single file legacy).
 * - Connections: parsed synchronously, shown to user immediately
 * - Enrichment: queued per contact via BullMQ
 * - Messages: queued for async Gemini parsing
 */
router.post('/upload', authenticateToken, uploadFields, async (req, res) => {
  try {
    // Support both new multi-file and legacy single-file upload
    const connectionsFile = req.files?.connections?.[0] || req.files?.file?.[0];
    const messagesFile    = req.files?.messages?.[0];

    if (!connectionsFile) {
      return res.status(400).json({ success: false, error: 'No connections.csv uploaded' });
    }

    // Check AI token limit before starting expensive task
    const isWithinLimit = await AITokenService.checkLimit(req.userId);
    if (!isWithinLimit) {
      return res.status(429).json({ success: false, error: 'Retry tomorrow you have consumed your daily ai usage limit' });
    }

    const csvContent = connectionsFile.buffer.toString('utf-8');
    const parsedContacts = LinkedInImportModel.parseLinkedInCSV(csvContent);
    logger.info(`[LinkedIn] Parsed ${parsedContacts.length} contacts for user ${req.userId}`);
    console.log(`[LinkedIn] Parsed ${parsedContacts.length} contacts for user ${req.userId}`);

    // Clear any previous job for this user
    await db.query(
      `DELETE FROM user_jobs WHERE user_id = $1 AND job_type = 'linkedin_import'`,
      [req.userId]
    );

    const jobId = crypto.randomUUID();
    importJobs.set(jobId, {
      status: 'processing',
      userId: req.userId,
      progress: { current: 0, total: Math.ceil(parsedContacts.length / 50) },
      result: null,
      error: null,
      createdAt: Date.now()
    });

    // Persist to DB immediately — store messages CSV so worker can parse it async
    const jobMeta = {
      fileName:           connectionsFile.originalname,
      fileSize:           connectionsFile.size,
      messagesCsvContent: messagesFile ? messagesFile.buffer.toString('utf-8') : null,
    };
    await db.query(
      `INSERT INTO user_jobs (user_id, job_type, status, job_id, metadata)
       VALUES ($1, 'linkedin_import', 'processing', $2, $3)`,
      [req.userId, jobId, JSON.stringify(jobMeta)]
    );

    // Respond immediately so the HTTP connection is freed
    res.json({ success: true, jobId, total: parsedContacts.length });

    // Run deduplication in the background (no await)
    const userId = req.userId;
    LinkedInImportModel.findDuplicates(userId, parsedContacts, (progress) => {
      const job = importJobs.get(jobId);
      if (job) job.progress = progress;
    })
      .then(async (deduplication) => {
        const job = importJobs.get(jobId);
        if (job) { job.status = 'done'; job.result = deduplication; }
        console.log(`[LinkedIn] Job ${jobId} completed — ${deduplication.duplicates} dupes, ${deduplication.unique} unique`);

        // Persist result to DB
        try {
          await db.query(
            `UPDATE user_jobs
             SET status = 'pending_review',
                 result = $1,
                 job_id = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $2 AND job_type = 'linkedin_import'`,
            [
              JSON.stringify({
                analysis: { totalInCSV: deduplication.total, duplicates: deduplication.duplicates, unique: deduplication.unique },
                importData: deduplication,
              }),
              userId,
            ]
          );
        } catch (dbErr) {
          console.error('[LinkedIn] Failed to persist result to DB:', dbErr.message);
        }
      })
      .catch(async (err) => {
        const job = importJobs.get(jobId);
        if (job) { job.status = 'error'; job.error = err.message; }
        console.error(`[LinkedIn] Job ${jobId} failed:`, err.message);
        // Clean up DB row on error so user can retry
        try {
          await db.query(
            `DELETE FROM user_jobs WHERE user_id = $1 AND job_type = 'linkedin_import'`,
            [userId]
          );
        } catch {}
      });

  } catch (error) {
    console.error('LinkedIn upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * GET /api/linkedin/job/:jobId
 * Poll for background job status. Returns progress while processing,
 * full import data when done.
 */
router.get('/job/:jobId', authenticateToken, (req, res) => {
  const job = importJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found or expired' });
  }

  // Security: only the owner can poll their job
  if (job.userId !== req.userId) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }

  if (job.status === 'processing') {
    return res.json({ success: true, status: 'processing', progress: job.progress });
  }

  if (job.status === 'error') {
    return res.json({ success: false, status: 'error', error: job.error });
  }

  // Done — return the full result and clean up memory but keep job to prevent 404s on concurrent polls
  const result = job.result;
  delete job.result;
  return res.json({
    success: true,
    status: 'done',
    analysis: result ? {
      totalInCSV: result.total,
      duplicates: result.duplicates,
      unique: result.unique
    } : null,
    importData: result || null
  });
});

/**
 * POST /api/linkedin/import
 * Execute the import after user reviews preview
 */
router.post('/import', authenticateToken, async (req, res) => {
  try {
    const { importData, options = {} } = req.body;

    if (!importData) {
      return res.status(400).json({
        success: false,
        error: 'Import data is required'
      });
    }

    // Validate import data structure
    if (!importData.duplicateDetails || !importData.uniqueContacts) {
      return res.status(400).json({
        success: false,
        error: 'Invalid import data format'
      });
    }

    console.log(`Executing LinkedIn import for user ${req.userId}`);
    console.log(`Duplicates to update: ${importData.duplicateDetails.length}`);
    console.log(`Unique contacts to add: ${importData.uniqueContacts.length}`);

    // Execute import
    const result = await LinkedInImportModel.executeImport(
      req.userId,
      importData,
      {
        applyDuplicateMerges: options.updateDuplicates !== false,
        addUniqueContacts: options.addUnique !== false
      }
    );

    // Queue enrichment for contacts with LinkedIn URLs
    const { rows: contactsToEnrich } = await db.query(`
      SELECT id, linkedin_url FROM contacts
      WHERE user_id = $1 AND linkedin_url IS NOT NULL
        AND enrichment_status = 'pending'
    `, [req.userId]);

    for (const c of contactsToEnrich) {
      await enrichQueue.add('enrich', {
        contactId:   c.id,
        linkedinUrl: c.linkedin_url,
        userId:      req.userId,
      }, { priority: 5, attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
    }

    // Queue message parsing if messages CSV was stored in job metadata
    const { rows: jobMeta } = await db.query(
      `SELECT metadata FROM user_jobs WHERE user_id = $1 AND job_type = 'linkedin_import' LIMIT 1`,
      [req.userId]
    );
    if (jobMeta[0]?.metadata?.messagesCsvContent) {
      await messageParseQueue.add('parse', {
        userId:     req.userId,
        csvContent: jobMeta[0].metadata.messagesCsvContent,
      }, { attempts: 2 });
    }

    // Trigger network scan in all groups this user belongs to
    const { rows: userGroups } = await db.query(
      `SELECT group_id FROM group_members WHERE user_id = $1 AND consent_given_at IS NOT NULL`,
      [req.userId]
    );
    for (const g of userGroups) {
      await networkScanQueue.add('scan', {
        userId:  req.userId,
        groupId: g.group_id,
      }, { priority: 3 });
    }

    // Recompute confidence scores for all contacts
    recomputeUserConfidence(req.userId).catch(() => {});

    // Job is complete — remove from DB
    try {
      await db.query(
        `DELETE FROM user_jobs WHERE user_id = $1 AND job_type = 'linkedin_import'`,
        [req.userId]
      );
    } catch {}

    // Update group member linkedin_uploaded flag
    await db.query(
      `UPDATE group_members SET linkedin_uploaded = true WHERE user_id = $1`,
      [req.userId]
    );

    res.json({
      success: true,
      result: {
        duplicatesUpdated:  result.duplicatesUpdated,
        uniqueAdded:        result.uniqueAdded,
        totalImported:      result.duplicatesUpdated + result.uniqueAdded,
        enrichmentQueued:   contactsToEnrich.length,
        errors:             result.errors
      },
      message: `Successfully imported ${result.duplicatesUpdated + result.uniqueAdded} contacts. Enriching ${contactsToEnrich.length} in background.`
    });

  } catch (error) {
    console.error('LinkedIn import error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/linkedin/cancel
 * User dismissed the preview without importing — clean up the job.
 */
router.delete('/cancel', authenticateToken, async (req, res) => {
  try {
    await db.query(
      `DELETE FROM user_jobs WHERE user_id = $1 AND job_type = 'linkedin_import'`,
      [req.userId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/linkedin/history
 * Get LinkedIn import history
 */
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        id, sync_type, status, contacts_synced,
        started_at, completed_at,
        EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000 as duration_ms
      FROM sync_history
      WHERE user_id = $1 AND sync_type = 'linkedin_import'
      ORDER BY started_at DESC
      LIMIT 20
    `, [req.userId]);

    res.json({
      success: true,
      imports: result.rows.map(row => ({
        id: row.id,
        contactsImported: row.contacts_synced,
        status: row.status,
        importedAt: row.started_at,
        duration: Math.round(row.duration_ms / 1000) + 's'
      }))
    });

  } catch (error) {
    console.error('Error fetching import history:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/linkedin/dedup-dry-run
 * Upload a CSV and get a full diagnostic report showing exactly what each
 * contact triggers at every pipeline phase — zero AI calls made.
 *
 * Response shape:
 *   summary            – counts per phase
 *   phases.intraBatchDeduped  – contacts removed as within-CSV duplicates
 *   phases.preFiltered        – contacts discarded (invalid/incomplete)
 *   phases.definiteRuleMatch  – exact email/phone/linkedin matches (no AI needed)
 *   phases.sentToAI           – ambiguous contacts + fuzzy scores + candidates
 *   phases.markedUnique       – contacts with zero signal against DB
 *   aiPayload                 – the exact slim batches that would go to Gemini
 */
router.post('/dedup-dry-run', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const csvContent = req.file.buffer.toString('utf-8');
    const parsedContacts = LinkedInImportModel.parseLinkedInCSV(csvContent);

    const existingResult = await db.query(
      `SELECT id, full_name, first_name, last_name, email, company, job_title,
              phone, linkedin_url
       FROM contacts WHERE user_id = $1`,
      [req.userId]
    );

    const report = aiDeduplicationService.dryRun(existingResult.rows, parsedContacts);

    // ?batches=true → include the full slim AI payload (verbose, large response)
    if (req.query.batches === 'true') {
      const AI_BATCH = 20;
      // Rebuild batches from sentToAI phase data (slim format)
      const pairs = report.phases.sentToAI.map(entry => ({
        incoming:   aiDeduplicationService._slim({ id: entry.incoming.tempId, ...entry.incoming }),
        candidates: entry.topCandidates.map(c => aiDeduplicationService._slim({ id: c.id, fullName: c.fullName, email: c.email, phone: null, company: c.company, jobTitle: null, linkedinUrl: c.linkedinUrl || null })),
      }));
      report.aiPayload.batches = [];
      for (let i = 0; i < pairs.length; i += AI_BATCH) {
        report.aiPayload.batches.push(pairs.slice(i, i + AI_BATCH));
      }
    }

    res.json({ success: true, report });
  } catch (err) {
    console.error('[LinkedIn] dedup-dry-run error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/linkedin/test-parse
 * Test endpoint to validate CSV format without importing
 */
router.post('/test-parse', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    const csvContent = req.file.buffer.toString('utf-8');
    const parsedContacts = LinkedInImportModel.parseLinkedInCSV(csvContent);

    // Get sample contacts
    const sample = parsedContacts.slice(0, 5);

    res.json({
      success: true,
      totalParsed: parsedContacts.length,
      sample: sample,
      validation: {
        hasNames: sample.every(c => c.fullName),
        hasEmails: sample.filter(c => c.email).length,
        hasCompanies: sample.filter(c => c.company).length,
        hasJobTitles: sample.filter(c => c.jobTitle).length,
        hasLinkedInUrls: sample.filter(c => c.linkedinUrl).length
      }
    });

  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to parse CSV: ' + error.message,
      hint: 'Please ensure you\'re uploading a valid LinkedIn Connections export CSV'
    });
  }
});

/**
 * POST /api/linkedin/fetch-connections
 *
 * Server-side LinkedIn network fetch using Voyager API (LinkedIn's internal API).
 * User provides their session cookies — we paginate all connections and import them.
 *
 * How to get cookies (instruct user):
 *   1. Open linkedin.com in Chrome (stay logged in)
 *   2. DevTools → Application → Cookies → www.linkedin.com
 *   3. Copy: li_at value  AND  JSESSIONID value
 *
 * Body: { li_at: string, jsessionid: string }
 *
 * Returns SSE stream so the client can show live progress:
 *   data: {"type":"progress","fetched":100,"total":312}
 *   data: {"type":"done","imported":312,"enrichmentQueued":312}
 *   data: {"type":"error","message":"..."}
 */
router.post('/fetch-connections', authenticateToken, async (req, res) => {
  const { li_at, jsessionid } = req.body;

  if (!li_at || !jsessionid) {
    return res.status(400).json({
      success: false,
      error: 'Both li_at and jsessionid cookie values are required.',
      hint: 'Open LinkedIn in Chrome → F12 → Application → Cookies → www.linkedin.com',
    });
  }

  if (li_at.length < 20 || jsessionid.length < 5) {
    return res.status(400).json({
      success: false,
      error: 'Cookie values look invalid — please re-copy from browser DevTools.',
    });
  }

  // Use SSE so the frontend can show a live progress bar
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    send({ type: 'start', message: 'Connecting to LinkedIn...' });

    const connections = await fetchAllConnections(
      li_at,
      jsessionid,
      ({ fetched, total }) => {
        send({ type: 'progress', fetched, total });
      }
    );

    if (!connections.length) {
      send({ type: 'error', message: 'No connections returned — cookies may be expired or invalid.' });
      return res.end();
    }

    send({ type: 'importing', message: `Saving ${connections.length} contacts...` });

    // Reuse the same batch processor as the Chrome extension
    const result = await processConnectionsBatch(req.userId, connections);

    // Queue enrichment for any new contacts without it yet
    const { rows: toEnrich } = await db.query(`
      SELECT id, linkedin_url FROM contacts
      WHERE user_id = $1 AND linkedin_url IS NOT NULL AND enrichment_status = 'pending'
    `, [req.userId]);

    for (const c of toEnrich) {
      await enrichQueue.add('enrich', {
        contactId:   c.id,
        linkedinUrl: c.linkedin_url,
        userId:      req.userId,
      }, { priority: 5, attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
    }

    // Trigger network scan for group overlap detection
    const { rows: userGroups } = await db.query(
      `SELECT group_id FROM group_members WHERE user_id = $1 AND consent_given_at IS NOT NULL`,
      [req.userId]
    );
    for (const g of userGroups) {
      await networkScanQueue.add('scan', { userId: req.userId, groupId: g.group_id }, { priority: 3 });
    }

    // Recompute confidence for all
    recomputeUserConfidence(req.userId).catch(() => {});

    send({
      type: 'done',
      imported:          result.created + result.updated,
      created:           result.created,
      updated:           result.updated,
      skipped:           result.skipped,
      enrichmentQueued:  toEnrich.length,
      message: `Imported ${result.created + result.updated} contacts. Enriching ${toEnrich.length} in background.`,
    });

    logger.info(`[Voyager] User ${req.userId}: imported ${result.created} new, ${result.updated} updated, ${toEnrich.length} queued for enrichment`);

  } catch (err) {
    logger.error(`[Voyager] fetch-connections failed for user ${req.userId}: ${err.message}`);

    // Distinguish auth errors from other failures
    if (err.response?.status === 401 || err.response?.status === 403) {
      send({ type: 'error', message: 'LinkedIn session expired — please re-copy your cookies and try again.' });
    } else if (err.response?.status === 429) {
      send({ type: 'error', message: 'LinkedIn rate limited this request. Wait 10 minutes and try again.' });
    } else {
      send({ type: 'error', message: err.message });
    }
  }

  res.end();
});

/**
 * POST /api/linkedin/import-by-url
 *
 * Import LinkedIn contacts directly from profile URLs using Bright Data.
 * Accepts up to 100 LinkedIn /in/ URLs, creates stub contacts, enriches
 * them via Bright Data, and streams SSE progress back to the client.
 *
 * Body: { urls: string[] }
 *
 * SSE events:
 *   { type: 'start',    total: N }
 *   { type: 'status',   message: string }
 *   { type: 'progress', processed: N, total: N }
 *   { type: 'done',     imported: N, enriched: N, errors: N }
 *   { type: 'error',    message: string }
 */
router.post('/import-by-url', authenticateToken, async (req, res) => {
  const { urls } = req.body;

  if (!Array.isArray(urls) || !urls.length) {
    return res.status(400).json({ success: false, error: 'urls array is required' });
  }
  if (urls.length > 100) {
    return res.status(400).json({ success: false, error: 'Maximum 100 URLs per request' });
  }

  // Normalise and validate — must be linkedin.com/in/* URLs
  const validUrls = urls
    .map(u => String(u).trim().split('?')[0].replace(/\/$/, ''))
    .filter(u => /^https?:\/\/(www\.)?linkedin\.com\/in\/[^/]+/.test(u));

  if (!validUrls.length) {
    return res.status(400).json({ success: false, error: 'No valid LinkedIn profile URLs found' });
  }

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    send({ type: 'start', total: validUrls.length });

    // Step 1: upsert stub contacts so we have IDs before enrichment
    const contactMap = new Map(); // linkedin_url -> contactId
    for (const url of validUrls) {
      const slug    = url.replace(/.*\/in\//, '').replace(/[^a-zA-Z0-9_-]/g, '');
      const { rows } = await db.query(
        `INSERT INTO contacts
           (user_id, full_name, linkedin_url, source, enrichment_status)
         VALUES ($1, $2, $3, 'url_import', 'pending')
         ON CONFLICT (user_id, linkedin_url)
           DO UPDATE SET enrichment_status = 'pending'
         RETURNING id`,
        [req.userId, slug, url]
      );
      if (rows[0]) contactMap.set(url, rows[0].id);
    }

    send({
      type: 'status',
      message: `Fetching ${contactMap.size} profiles from LinkedIn via Bright Data…`,
    });

    // Step 2: batch-trigger Bright Data and poll until results are ready
    const { enrichBatch } = require('../services/enrichment/brightdata');
    const urlList  = [...contactMap.keys()];
    const results  = await enrichBatch(urlList);

    // Step 3: update contacts with enriched profile data
    let enriched = 0;
    let errors   = 0;

    for (let i = 0; i < urlList.length; i++) {
      const url       = urlList[i];
      const contactId = contactMap.get(url);
      const result    = results[i];

      if (!result || !contactId) { errors++; continue; }

      // Build first/last name from full_name if individual parts missing
      let firstName = result.first_name || null;
      let lastName  = result.last_name  || null;
      if (!firstName && result.full_name) {
        const parts = result.full_name.trim().split(/\s+/);
        firstName   = parts[0] || null;
        lastName    = parts.slice(1).join(' ') || null;
      }

      await db.query(`
        UPDATE contacts SET
          full_name           = COALESCE($1,  full_name),
          first_name          = COALESCE($2,  first_name),
          last_name           = COALESCE($3,  last_name),
          job_title           = COALESCE($4,  job_title),
          company             = COALESCE($5,  company),
          bio                 = COALESCE($6,  bio),
          skills              = COALESCE($7::jsonb,  skills),
          experience          = COALESCE($8::jsonb,  experience),
          education           = COALESCE($9::jsonb,  education),
          photo_url           = COALESCE($10, photo_url),
          enrichment_status   = 'enriched',
          enrichment_provider = 'brightdata',
          enriched_at         = NOW(),
          pinecone_indexed    = false
        WHERE id = $11
      `, [
        result.full_name || null,
        firstName,
        lastName,
        result.occupation || null,
        result.company    || null,
        result.bio        || null,
        result.skills?.length       ? JSON.stringify(result.skills)       : null,
        result.experiences?.length  ? JSON.stringify(result.experiences)  : null,
        result.education?.length    ? JSON.stringify(result.education)    : null,
        result.profile_pic_url      || null,
        contactId,
      ]);

      enriched++;
      send({ type: 'progress', processed: enriched + errors, total: validUrls.length });
    }

    // Update group member flag and recompute confidence
    if (enriched > 0) {
      await db.query(
        `UPDATE group_members SET linkedin_uploaded = true WHERE user_id = $1`,
        [req.userId]
      );
      recomputeUserConfidence(req.userId).catch(() => {});
    }

    send({ type: 'done', imported: contactMap.size, enriched, errors });
    logger.info(`[UrlImport] User ${req.userId}: ${enriched} enriched, ${errors} errors from ${validUrls.length} URLs`);

  } catch (err) {
    logger.error(`[UrlImport] User ${req.userId}: ${err.message}`);
    send({ type: 'error', message: err.message });
  }

  res.end();
});

/**
 * POST /api/linkedin/bulk-enrich
 *
 * Queues Bright Data enrichment for all unenriched connections that
 * have a LinkedIn URL. Kicks off immediately in background — client
 * gets a count back right away.
 *
 * Optional body: { contactIds: [...] } to target specific contacts.
 * Without it, enriches all pending contacts for the user.
 */
router.post('/bulk-enrich', authenticateToken, async (req, res) => {
  const { contactIds } = req.body || {};

  let query, params;
  if (Array.isArray(contactIds) && contactIds.length) {
    query = `
      SELECT id, linkedin_url FROM contacts
      WHERE user_id = $1
        AND id = ANY($2::uuid[])
        AND linkedin_url IS NOT NULL
        AND enrichment_status IN ('pending', 'queued', 'failed')
    `;
    params = [req.userId, contactIds];
  } else {
    query = `
      SELECT id, linkedin_url FROM contacts
      WHERE user_id = $1
        AND linkedin_url IS NOT NULL
        AND enrichment_status IN ('pending', 'queued', 'failed')
      LIMIT 500
    `;
    params = [req.userId];
  }

  const { rows } = await db.query(query, params);

  if (!rows.length) {
    return res.json({ success: true, queued: 0, message: 'No contacts need enrichment.' });
  }

  // Mark them all as 'enriching' immediately so we don't double-queue
  const ids = rows.map(r => r.id);
  await db.query(
    `UPDATE contacts SET enrichment_status = 'enriching' WHERE id = ANY($1::uuid[])`,
    [ids]
  );

  // Return immediately — enrichment runs in background
  res.json({
    success: true,
    queued: rows.length,
    message: `Bright Data enrichment started for ${rows.length} contacts.`,
  });

  // Run async — do not await
  const items = rows.map(r => ({ contactId: r.id, linkedinUrl: r.linkedin_url }));
  enrichBulkViaBrightData(items, req.userId).then(result => {
    logger.info(`[BulkEnrich] User ${req.userId}: ${result.enriched} enriched, ${result.failed} failed`);
  }).catch(err => {
    logger.error(`[BulkEnrich] User ${req.userId}: ${err.message}`);
    // Reset failed contacts back to 'failed' status
    db.query(
      `UPDATE contacts SET enrichment_status = 'failed' WHERE id = ANY($1::uuid[]) AND enrichment_status = 'enriching'`,
      [ids]
    ).catch(() => {});
  });
});

module.exports = router;