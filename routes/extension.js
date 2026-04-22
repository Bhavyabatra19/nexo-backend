/**
 * Chrome Extension Routes — LinkedIn scraping endpoint
 *
 * POST /api/extension/profile       — single profile captured on browse
 * POST /api/extension/batch         — batch from connections scan
 * GET  /api/extension/status        — sync status for extension popup
 */

const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');
const { processExtensionProfile, processConnectionsBatch, normalizeLinkedInUrl } = require('../services/linkedinScraper');
const db = require('../db');
const NoteModel = require('../models/Note');

// Extension sends at most one profile every 2s during browsing — 300/min max
const extensionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: req => req.userId,
  message: { success: false, error: 'Extension rate limit exceeded' },
});

// Batch endpoint: max 30 batches per minute (50 contacts each = 1500 contacts/min ceiling)
const batchRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: req => req.userId,
  message: { success: false, error: 'Batch rate limit: wait before next batch' },
});

// ── Single Profile ─────────────────────────────────────────────────────────────
router.post('/profile', authenticateToken, extensionRateLimit, async (req, res) => {
  const profileData = req.body;

  if (!profileData.linkedin_url && !profileData.name) {
    return res.status(400).json({ success: false, error: 'linkedin_url or name required' });
  }

  const result = await processExtensionProfile(req.userId, profileData);
  res.json({ success: true, result });
});

// ── Batch Connections Scan ─────────────────────────────────────────────────────
// Extension calls this while scrolling /mynetwork page
router.post('/batch', authenticateToken, batchRateLimit, async (req, res) => {
  const { connections } = req.body;

  if (!Array.isArray(connections) || connections.length === 0) {
    return res.status(400).json({ success: false, error: 'connections array required' });
  }
  if (connections.length > 100) {
    return res.status(400).json({ success: false, error: 'Max 100 per batch' });
  }

  const result = await processConnectionsBatch(req.userId, connections);

  // Update group member linkedin_uploaded flag if any contacts were created
  if (result.created > 0) {
    await db.query(`
      UPDATE group_members SET linkedin_uploaded = true
      WHERE user_id = $1
    `, [req.userId]);
  }

  res.json({ success: true, result });
});

// ── Extension Status ───────────────────────────────────────────────────────────
// Extension popup calls this to show sync stats
router.get('/status', authenticateToken, async (req, res) => {
  const { rows } = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE source = 'chrome_extension') AS extension_contacts,
      COUNT(*) FILTER (WHERE source = 'chrome_extension' AND enrichment_status = 'enriched') AS enriched,
      COUNT(*) FILTER (WHERE pinecone_indexed = false AND source = 'chrome_extension') AS pending_index,
      MAX(updated_at) FILTER (WHERE source = 'chrome_extension') AS last_sync
    FROM contacts
    WHERE user_id = $1
  `, [req.userId]);

  const { rows: recentScrapes } = await db.query(`
    SELECT COUNT(*) AS total, MAX(scraped_at) AS last_scraped
    FROM linkedin_scrape_log
    WHERE user_id = $1 AND scraped_at > NOW() - INTERVAL '24 hours'
  `, [req.userId]);

  res.json({
    success: true,
    stats: {
      ...rows[0],
      scrapes_today: recentScrapes[0]?.total || 0,
      last_scraped:  recentScrapes[0]?.last_scraped,
    },
  });
});

// ── Widget: Lookup contact by LinkedIn URL ─────────────────────────────────────
// The in-page Nexo widget calls this on every /in/* page load.
router.get('/contact', authenticateToken, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ success: false, error: 'url required' });

  const cleanUrl = normalizeLinkedInUrl(url);

  const { rows } = await db.query(
    `SELECT c.id, c.first_name, c.last_name, c.full_name, c.job_title, c.company,
            c.photo_url, c.bio, c.linkedin_url, c.connection_tier, c.enrichment_status,
            c.enriched_at, c.updated_at,
            COALESCE(array_remove(array_agg(t.name), NULL), '{}') AS tags
       FROM contacts c
       LEFT JOIN contact_tags ct ON ct.contact_id = c.id
       LEFT JOIN tags t ON t.id = ct.tag_id
      WHERE c.user_id = $1 AND c.linkedin_url = $2
      GROUP BY c.id
      LIMIT 1`,
    [req.userId, cleanUrl]
  );

  if (!rows.length) {
    return res.json({ success: true, found: false, normalized_url: cleanUrl });
  }

  const contact = rows[0];
  const { notes } = await NoteModel.getByContactId(contact.id, req.userId, 5, 0);

  res.json({
    success: true,
    found: true,
    contact: {
      id: contact.id,
      name: contact.full_name || `${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
      job_title: contact.job_title,
      company: contact.company,
      photo_url: contact.photo_url,
      bio: contact.bio,
      linkedin_url: contact.linkedin_url,
      connection_tier: contact.connection_tier,
      enrichment_status: contact.enrichment_status,
      tags: contact.tags || [],
      enriched_at: contact.enriched_at,
      updated_at: contact.updated_at,
    },
    notes,
  });
});

// ── Widget: add note ───────────────────────────────────────────────────────────
router.post('/note', authenticateToken, async (req, res) => {
  const { contact_id, content } = req.body || {};
  if (!contact_id || !content?.trim()) {
    return res.status(400).json({ success: false, error: 'contact_id and content required' });
  }

  // Ensure the contact belongs to this user before writing.
  const { rowCount } = await db.query(
    `SELECT 1 FROM contacts WHERE id = $1 AND user_id = $2`,
    [contact_id, req.userId]
  );
  if (!rowCount) return res.status(404).json({ success: false, error: 'contact not found' });

  const note = await NoteModel.create(contact_id, req.userId, content.trim(), null);
  res.json({ success: true, note });
});

module.exports = router;
