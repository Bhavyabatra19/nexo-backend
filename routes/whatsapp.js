const express = require('express');
const router  = express.Router();
const { sendTextMessage }        = require('../services/whatsapp');
const { processIncomingMessage } = require('../services/whatsappSessionService');

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// Health check
router.get('/', (req, res) => {
  res.send('WhatsApp webhook — Nexo AI');
});

/**
 * GET /api/whatsapp/webhook
 * Meta webhook verification handshake (one-time setup).
 */
router.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

/**
 * POST /api/whatsapp/webhook
 * Receives all incoming WhatsApp events (messages + status updates).
 *
 * Meta requires a 200 response within ~5 seconds, so we acknowledge
 * immediately and process asynchronously.
 */
router.post('/webhook', async (req, res) => {
  // Acknowledge immediately — never let Meta time out
  res.sendStatus(200);

  const { entry } = req.body;
  if (!entry || entry.length === 0) return;

  const changes = entry[0]?.changes;
  if (!changes || changes.length === 0) return;

  const value    = changes[0]?.value;
  const statuses = value?.statuses?.[0] || null;
  const messages = value?.messages?.[0] || null;

  // ── Status update (delivered / read / sent) — log only ──────────────────
  if (statuses) {
    console.log(
      `[WhatsApp] Status update — id:${statuses.id} status:${statuses.status}`
    );
  }

  // ── Incoming message ─────────────────────────────────────────────────────
  if (messages) {
    if (messages.type !== 'text') {
      sendTextMessage('Sorry, I can only respond to text messages.', messages.from)
        .catch(err => console.error('[WhatsApp] Non-text reply error:', err.message));
      return;
    }

    const phone             = messages.from;
    const messageText       = messages.text?.body || '';
    const whatsappMessageId = messages.id;

    if (!messageText.trim()) return;

    // Full AI pipeline — fire and forget so webhook returns fast
    processIncomingMessage({ phone, messageText, whatsappMessageId })
      .catch(err => console.error('[WhatsApp] Pipeline error:', err.message));
  }
});

module.exports = router;
