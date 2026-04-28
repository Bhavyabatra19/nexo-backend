/**
 * Chat-based Network-of-Network Scan (Sprint 1 P0).
 *
 *   POST /api/scan/query        — submit a natural-language ask, returns scan_id
 *   GET  /api/scan/:id          — status + metadata for one scan
 *   GET  /api/scan/:id/results  — ranked results array
 *   GET  /api/scan              — list of the user's recent scans
 *
 * Async by design: the route inserts the scans row, hands the id to a BullMQ
 * worker, and returns immediately. The frontend polls /:id until completed.
 *
 * If BullMQ enqueue fails (Redis down / not configured locally), we fall
 * back to running the scan inline on `setImmediate` so dev environments
 * without Redis still work end-to-end.
 */

const express = require('express');
const router  = express.Router();
const rateLimit = require('express-rate-limit');
const { authenticateToken } = require('../middleware/auth');
const db = require('../db');
const logger = require('../logger');
const { scanQueryQueue } = require('../workers/queues');
const { runScan } = require('../services/scanOrchestrator');

// 30 scans per user per hour. The LLM parse + Pinecone fanout is cheap
// per-call but a tight loop on the chat input would still rack up tokens.
const scanRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.userId || req.ip,
  message: { success: false, error: 'Scan rate limit reached (30 per hour). Try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/query', authenticateToken, scanRateLimit, async (req, res) => {
  const query = (req.body?.query || '').trim();
  if (!query) return res.status(400).json({ success: false, error: 'query is required' });
  if (query.length > 500) return res.status(400).json({ success: false, error: 'query too long (max 500 chars)' });

  const { rows } = await db.query(
    `INSERT INTO scans (user_id, query, parsed, scope, status)
     VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, 'queued')
     RETURNING id, status, created_at`,
    [req.userId, query]
  );
  const scan = rows[0];

  let enqueued = false;
  try {
    await scanQueryQueue.add('run', { scanId: scan.id }, { jobId: `scan_${scan.id}` });
    enqueued = true;
  } catch (err) {
    logger.warn(`[scan] queue add failed (${err.message}) — running inline`);
  }

  if (!enqueued) {
    setImmediate(() => {
      runScan(scan.id).catch((e) => logger.error(`[scan] inline run failed: ${e.message}`));
    });
  }

  res.json({
    success: true,
    scan_id: scan.id,
    status:  scan.status,
    created_at: scan.created_at,
  });
});

router.get('/', authenticateToken, async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const { rows } = await db.query(
    `SELECT id, query, status, result_count, created_at, completed_at, duration_ms
       FROM scans
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [req.userId, limit]
  );
  res.json({ success: true, scans: rows });
});

router.get('/:id', authenticateToken, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, query, status, parsed, scope, result_count,
            error, created_at, started_at, completed_at, duration_ms
       FROM scans
      WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!rows.length) return res.status(404).json({ success: false, error: 'scan not found' });
  res.json({ success: true, scan: rows[0] });
});

router.get('/:id/results', authenticateToken, async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, status, parsed, results, result_count, duration_ms
       FROM scans
      WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.userId]
  );
  if (!rows.length) return res.status(404).json({ success: false, error: 'scan not found' });
  const scan = rows[0];
  res.json({
    success:      true,
    scan_id:      scan.id,
    status:       scan.status,
    parsed:       scan.parsed,
    results:      scan.results || [],
    result_count: scan.result_count,
    duration_ms:  scan.duration_ms,
  });
});

module.exports = router;
