/**
 * Introduction Request Routes
 * POST /api/intros              — request an intro
 * GET  /api/intros              — list my requests (sent + received)
 * POST /api/intros/:id/approve  — approve + get AI draft
 * POST /api/intros/:id/deny     — deny request
 */

const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { GoogleGenAI } = require('@google/genai');
const { notificationQueue } = require('../workers/queues');
const logger = require('../logger');

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 5 intro requests per user per 7 days
const introRateLimit = rateLimit({
  windowMs: 7 * 24 * 60 * 60 * 1000,
  max: 5,
  keyGenerator: req => req.userId,
  message: { success: false, error: 'Intro request limit reached (5 per week)' },
});

// ── Request Intro ──────────────────────────────────────────────────────────────
router.post('/', authenticateToken, introRateLimit, async (req, res) => {
  const { connector_id, target_contact_id, context, preferred_method, group_id } = req.body;

  if (!connector_id || !target_contact_id || !context) {
    return res.status(400).json({ success: false, error: 'connector_id, target_contact_id, context required' });
  }
  if (context.length > 300) {
    return res.status(400).json({ success: false, error: 'Context max 300 chars' });
  }

  // Verify target contact is visible and not private
  const { rows: contacts } = await db.query(`
    SELECT c.full_name, u.full_name AS connector_name
    FROM contacts c
    JOIN users u ON u.id = c.user_id
    WHERE c.id = $1 AND c.user_id = $2 AND c.is_private = false
  `, [target_contact_id, connector_id]);

  if (!contacts.length) {
    return res.status(404).json({ success: false, error: 'Contact not found or is private' });
  }

  // Can't request intro to yourself
  if (connector_id === req.userId) {
    return res.status(400).json({ success: false, error: 'Cannot request intro via yourself' });
  }

  const { rows: intro } = await db.query(`
    INSERT INTO introduction_requests
      (group_id, requester_id, connector_id, target_contact_id, context, preferred_method)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [group_id, req.userId, connector_id, target_contact_id, context, preferred_method || 'email']);

  // Notify connector
  const { rows: requester } = await db.query(
    `SELECT full_name FROM users WHERE id = $1`, [req.userId]
  );
  await notificationQueue.add('notification', {
    type:          'intro_request',
    introId:       intro[0].id,
    connectorId:   connector_id,
    requesterName: requester[0].full_name,
    targetName:    contacts[0].full_name,
    context,
  });

  res.json({ success: true, intro: intro[0] });
});

// ── List My Intros ─────────────────────────────────────────────────────────────
router.get('/', authenticateToken, async (req, res) => {
  const { rows: sent } = await db.query(`
    SELECT ir.*, c.full_name AS target_name, u.full_name AS connector_name
    FROM introduction_requests ir
    JOIN contacts c ON c.id = ir.target_contact_id
    JOIN users u ON u.id = ir.connector_id
    WHERE ir.requester_id = $1
    ORDER BY ir.requested_at DESC LIMIT 20
  `, [req.userId]);

  const { rows: received } = await db.query(`
    SELECT ir.*, c.full_name AS target_name, u.full_name AS requester_name
    FROM introduction_requests ir
    JOIN contacts c ON c.id = ir.target_contact_id
    JOIN users u ON u.id = ir.requester_id
    WHERE ir.connector_id = $1 AND ir.status = 'pending'
    ORDER BY ir.requested_at DESC LIMIT 20
  `, [req.userId]);

  res.json({ success: true, sent, received });
});

// ── Approve + Generate AI Draft ──────────────────────────────────────────────────
router.post('/:id/approve', authenticateToken, async (req, res) => {
  const { connector_note } = req.body;

  const { rows: intro } = await db.query(`
    SELECT ir.*, c.full_name AS target_name, u.full_name AS requester_name, u.email AS requester_email
    FROM introduction_requests ir
    JOIN contacts c ON c.id = ir.target_contact_id
    JOIN users u ON u.id = ir.requester_id
    WHERE ir.id = $1 AND ir.connector_id = $2 AND ir.status = 'pending'
  `, [req.params.id, req.userId]);

  if (!intro.length) {
    return res.status(404).json({ success: false, error: 'Request not found or already handled' });
  }

  const r = intro[0];
  const { rows: connector } = await db.query(`SELECT full_name FROM users WHERE id = $1`, [req.userId]);

  // Generate AI intro draft using Gemini Pro (user-facing quality matters here)
  let aiDraft = '';
  try {
    const response = await genAI.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{
        parts: [{
          text: `Write a warm, concise introduction email (3-4 sentences max).
Connector: ${connector[0].full_name}
Introducing: ${r.requester_name}
To: ${r.target_name}
Requester's context: "${r.context}"
${connector_note ? `Connector's personal note: "${connector_note}"` : ''}

Write it in first person as if the connector is writing it. Personal, not corporate.
Subject line first, then body. No placeholders.`
        }]
      }]
    });
    aiDraft = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (err) {
    logger.warn('[Intros] AI draft failed:', err.message);
  }

  await db.query(`
    UPDATE introduction_requests
    SET status = 'approved', connector_note = $1, ai_draft = $2, responded_at = NOW()
    WHERE id = $3
  `, [connector_note, aiDraft, req.params.id]);

  res.json({ success: true, status: 'approved', ai_draft: aiDraft, intro: r });
});

// ── Deny ─────────────────────────────────────────────────────────────────────────
router.post('/:id/deny', authenticateToken, async (req, res) => {
  const { rows } = await db.query(`
    UPDATE introduction_requests
    SET status = 'denied', responded_at = NOW()
    WHERE id = $1 AND connector_id = $2 AND status = 'pending'
    RETURNING *
  `, [req.params.id, req.userId]);

  if (!rows.length) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true });
});

module.exports = router;
