/**
 * WhatsApp Session Service
 *
 * Orchestrates the full WhatsApp → Nexo AI pipeline:
 *   1. Idempotency  – skip already-processed WhatsApp message IDs
 *   2. User lookup  – validate sender phone against users.whatsapp_number
 *   3. Session      – get or create a 30-min-inactivity session
 *   4. Storage      – persist every incoming/outgoing message
 *   5. AI           – call nexoAIService.chat() with conversation history
 *   6. 24h window   – use template when outside Meta's free-form window
 *   7. Delivery     – send response back via WhatsApp Cloud API
 */

const db             = require('../db');
const nexoAI         = require('./nexoAIService');
const { sendTextMessage, sendTemplateMessage } = require('./whatsapp');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_IDLE_MINUTES  = 30;
const WINDOW_HOURS          = 24;
const SIGNUP_COOLDOWN_MS    = 24 * 60 * 60 * 1000; // 24 h

const SIGNUP_MESSAGE =
  `👋 No user found in our database.\n\nPlease sign up first to start using Nexo AI:\nhttps://getnexo.in/ \n\nOR add your number on the settings page by enabling whatsapp notifications:\nhttps://getnexo.in/dashboard/settings`;

// In-memory map: normalizedPhone → timestamp of last signup-prompt sent.
// Resets on server restart, which is acceptable (rare false extra message).
const _signupSentAt = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a phone number for DB comparison.
 * Strips leading '+' and whitespace; keeps only digits.
 * E.g. "+91 98765 43210" → "919876543210"
 */
function normalizePhone(raw) {
  return (raw || '').replace(/\D/g, '');
}

/**
 * Convert AI markdown to WhatsApp-friendly text.
 * WhatsApp supports *bold*, _italic_, ~strike~, `mono` — but not ## headers or tables.
 */
function formatForWhatsApp(text) {
  return text
    // Convert ### / ## / # headings → *bold*
    .replace(/^#{1,3}\s+(.+)$/gm, '*$1*')
    // Convert **bold** → *bold*
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    // Drop table separator rows (|---|---|)
    .replace(/^\|[-| :]+\|$/gm, '')
    // Strip leading/trailing pipes from table rows, replace inner pipes with spaces
    .replace(/^\|(.+)\|$/gm, (_, inner) =>
      inner.split('|').map(cell => cell.trim()).filter(Boolean).join('   ')
    )
    // Collapse 3+ blank lines to 2
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// User lookup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find a registered user whose whatsapp_number matches the sender.
 * Returns the full users row or null.
 */
async function getUserByPhone(normalizedPhone) {
  const result = await db.query(
    `SELECT * FROM users WHERE REGEXP_REPLACE(whatsapp_number, '[^0-9]', '', 'g') = $1 AND is_active = TRUE LIMIT 1`,
    [normalizedPhone]
  );
  return result.rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if this WhatsApp messageId has already been stored.
 * Prevents duplicate processing when Meta retries the webhook.
 */
async function isMessageAlreadyProcessed(messageId) {
  if (!messageId) return false;
  const result = await db.query(
    `SELECT 1 FROM whatsapp_messages WHERE message_id = $1 LIMIT 1`,
    [messageId]
  );
  return result.rowCount > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the active session for userId, creating a new one if needed.
 * Sessions expire after SESSION_IDLE_MINUTES of inactivity.
 */
async function getOrCreateSession(userId) {
  // Expire stale sessions first
  await db.query(`
    UPDATE whatsapp_sessions
    SET session_status = 'expired', updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $1
      AND session_status = 'active'
      AND last_activity < CURRENT_TIMESTAMP - INTERVAL '${SESSION_IDLE_MINUTES} minutes'
  `, [userId]);

  // Try to find an active session
  const existing = await db.query(
    `SELECT * FROM whatsapp_sessions
     WHERE user_id = $1 AND session_status = 'active'
     ORDER BY last_activity DESC
     LIMIT 1`,
    [userId]
  );

  if (existing.rows.length > 0) {
    // Refresh last_activity
    const session = existing.rows[0];
    await db.query(
      `UPDATE whatsapp_sessions
       SET last_activity = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [session.id]
    );
    console.log(`[WhatsApp] Reusing session ${session.id} for user ${userId}`);
    return session;
  }

  // Create new session
  const created = await db.query(
    `INSERT INTO whatsapp_sessions (user_id, session_status, last_activity)
     VALUES ($1, 'active', CURRENT_TIMESTAMP)
     RETURNING *`,
    [userId]
  );
  const session = created.rows[0];
  console.log(`[WhatsApp] Created session ${session.id} for user ${userId}`);
  return session;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message storage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a message to whatsapp_messages.
 * direction: 'incoming' (user → us) | 'outgoing' (us → user)
 */
async function saveMessage({ sessionId, userId, messageId, message, direction, messageType = 'text' }) {
  await db.query(
    `INSERT INTO whatsapp_messages (session_id, user_id, message_id, message, direction, message_type)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sessionId, userId, messageId || null, message, direction, messageType]
  );
}

/**
 * Return the last `limit` messages of a session as AI history format.
 * Returned as [{ role: 'user' | 'model', content: string }], oldest first.
 */
async function getConversationHistory(sessionId, limit = 10) {
  const result = await db.query(
    `SELECT direction, message FROM whatsapp_messages
     WHERE session_id = $1
     ORDER BY timestamp DESC
     LIMIT $2`,
    [sessionId, limit]
  );

  // Reverse to chronological order, then map to AI format
  return result.rows
    .reverse()
    .map(row => ({
      role:    row.direction === 'incoming' ? 'user' : 'model',
      content: row.message,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 24-hour messaging window (Meta requirement)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the user sent us a message within the last 24 hours,
 * meaning we can reply with free-form text.
 * Returns false if we must use an approved template instead.
 */
async function isWithin24HourWindow(userId) {
  const result = await db.query(
    `SELECT timestamp FROM whatsapp_messages
     WHERE user_id = $1 AND direction = 'incoming'
     ORDER BY timestamp DESC
     LIMIT 1`,
    [userId]
  );

  if (result.rows.length === 0) return false;

  const lastMessageAt = new Date(result.rows[0].timestamp);
  const diffMs = Date.now() - lastMessageAt.getTime();
  return diffMs < WINDOW_HOURS * 60 * 60 * 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spam prevention for unregistered users
// ─────────────────────────────────────────────────────────────────────────────

function shouldSendSignupMessage(normalizedPhone) {
  const lastSent = _signupSentAt.get(normalizedPhone);
  if (!lastSent) return true;
  return Date.now() - lastSent > SIGNUP_COOLDOWN_MS;
}

function markSignupSent(normalizedPhone) {
  _signupSentAt.set(normalizedPhone, Date.now());
}

// ─────────────────────────────────────────────────────────────────────────────
// Main orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a single incoming WhatsApp text message end-to-end.
 *
 * @param {Object} params
 * @param {string} params.phone             - Raw sender phone from webhook (e.g. "919876543210")
 * @param {string} params.messageText       - The text body of the message
 * @param {string} params.whatsappMessageId - Meta message ID (for idempotency)
 */
async function processIncomingMessage({ phone, messageText, whatsappMessageId }) {
  const normalizedPhone = normalizePhone(phone);

  console.log(`[WhatsApp] Incoming message from ${normalizedPhone}, messageId=${whatsappMessageId}`);

  // ── 1. Idempotency check ──────────────────────────────────────────────────
  if (await isMessageAlreadyProcessed(whatsappMessageId)) {
    console.log(`[WhatsApp] Duplicate messageId ${whatsappMessageId} — skipping`);
    return;
  }

  // ── 2. User lookup ────────────────────────────────────────────────────────
  const user = await getUserByPhone(normalizedPhone);

  if (!user) {
    console.log(`[WhatsApp] No registered user for phone ${normalizedPhone}`);
    if (shouldSendSignupMessage(normalizedPhone)) {
      await sendTextMessage(SIGNUP_MESSAGE, phone);
      markSignupSent(normalizedPhone);
      console.log(`[WhatsApp] Sent signup prompt to ${normalizedPhone}`);
    } else {
      console.log(`[WhatsApp] Signup cooldown active for ${normalizedPhone} — not sending again`);
    }
    return;
  }

  console.log(`[WhatsApp] User found: ${user.id} (${user.full_name})`);

  // ── 3. Get or create session ──────────────────────────────────────────────
  const session = await getOrCreateSession(user.id);

  // ── 4. Save incoming message ──────────────────────────────────────────────
  await saveMessage({
    sessionId:   session.id,
    userId:      user.id,
    messageId:   whatsappMessageId,
    message:     messageText,
    direction:   'incoming',
    messageType: 'text',
  });
  console.log(`[WhatsApp] Saved incoming message to session ${session.id}`);

  // ── 5. Conversation history for AI context ────────────────────────────────
  // Exclude the message we just saved (it will be the current "message" arg to chat())
  const history = await getConversationHistory(session.id, 10);
  // The last entry IS the message we just saved — drop it to avoid duplication
  const priorHistory = history.slice(0, -1);

  // ── 6. Call Nexo AI ───────────────────────────────────────────────────────
  console.log(`[WhatsApp] Sending to AI (session ${session.id}, history length ${priorHistory.length})`);
  let reply;
  try {
    const result = await nexoAI.chat(user.id, messageText, priorHistory);
    reply = result.reply;
    console.log(`[WhatsApp] AI response received (${reply.length} chars)`);
  } catch (err) {
    console.error(`[WhatsApp] AI error for user ${user.id}:`, err.message);
    reply = 'Something went wrong please try again later';
  }

  // ── 7. Save outgoing message ──────────────────────────────────────────────
  await saveMessage({
    sessionId:   session.id,
    userId:      user.id,
    messageId:   null,
    message:     reply,
    direction:   'outgoing',
    messageType: 'text',
  });

  // ── 8. 24-hour window check & send ───────────────────────────────────────
  const withinWindow = await isWithin24HourWindow(user.id);

  if (withinWindow) {
    const formattedReply = formatForWhatsApp(reply);
    await sendTextMessage(formattedReply, phone);
    console.log(`[WhatsApp] Free-form reply sent to ${normalizedPhone}`);
  } else {
    // Outside the 24h window: fall back to a template (if configured)
    console.warn(`[WhatsApp] Outside 24h window for user ${user.id} — using template`);
    try {
      await sendTemplateMessage(phone, 'nexo_ai_response', 'en');
    } catch (tmplErr) {
      console.error(`[WhatsApp] Template send failed:`, tmplErr.message);
    }
  }
}

module.exports = {
  processIncomingMessage,
  // Exported for unit testing / admin use
  getUserByPhone,
  getOrCreateSession,
  saveMessage,
  getConversationHistory,
  isWithin24HourWindow,
};
