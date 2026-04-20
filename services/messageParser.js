/**
 * LinkedIn Messages Parser
 *
 * Parses messages.csv from LinkedIn data export.
 * Summarizes each conversation per contact using Gemini Flash.
 * Stores summaries in linkedin_messages table — raw content is NEVER stored.
 */

const { GoogleGenAI } = require('@google/genai');
const db = require('../db');
const logger = require('../logger');
const { recomputeConfidence } = require('./confidence');
const crypto = require('crypto');

let genAI = null;
function getGenAI() {
  if (!genAI && process.env.GEMINI_API_KEY) genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return genAI;
}

/**
 * Parse LinkedIn messages.csv into per-contact conversation groups.
 * LinkedIn messages.csv columns: CONVERSATION ID, CONVERSATION TITLE, FROM, SENDER PROFILE URL, DATE, SUBJECT, CONTENT
 */
function parseMessagesCSV(csvContent) {
  const lines = csvContent.split('\n');
  if (lines.length < 2) return {};

  // Find header row
  let headerIdx = 0;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    if (lines[i].toLowerCase().includes('conversation id') || lines[i].toLowerCase().includes('from')) {
      headerIdx = i;
      break;
    }
  }

  const headers = lines[headerIdx].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
  const fromIdx     = headers.findIndex(h => h === 'from' || h === 'sender name');
  const senderUrlIdx = headers.findIndex(h => h.includes('sender profile url') || h.includes('sender url'));
  const contentIdx  = headers.findIndex(h => h === 'content' || h === 'message');
  const dateIdx     = headers.findIndex(h => h === 'date' || h.includes('date'));

  if (fromIdx === -1) {
    logger.warn('[MessageParser] Could not find FROM column in messages.csv');
    return {};
  }

  const byContact = {};

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // CSV parse with basic quote handling
    const cols = parseCSVLine(line);
    if (cols.length < 3) continue;

    const from       = cols[fromIdx]?.replace(/"/g, '').trim();
    const senderUrl  = senderUrlIdx >= 0 ? cols[senderUrlIdx]?.replace(/"/g, '').trim() : null;
    const content    = contentIdx >= 0 ? cols[contentIdx]?.replace(/"/g, '').trim() : '';
    const date       = dateIdx >= 0 ? cols[dateIdx]?.replace(/"/g, '').trim() : null;

    if (!from || from === 'LinkedIn Member') continue;

    const key = senderUrl || from;
    if (!byContact[key]) {
      byContact[key] = {
        name:       from,
        linkedinUrl: senderUrl || null,
        messages:   [],
      };
    }
    byContact[key].messages.push({ content, date, from });
  }

  return byContact;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

/**
 * Process messages for a user. Called by the BullMQ worker.
 * contactsByKey: output of parseMessagesCSV
 */
async function processMessagesForUser(userId, csvContent) {
  const byContact = parseMessagesCSV(csvContent);
  const contactKeys = Object.keys(byContact);
  logger.info(`[MessageParser] Processing ${contactKeys.length} conversations for user ${userId}`);

  let processed = 0;
  let upgraded  = 0;

  for (const key of contactKeys) {
    const conv = byContact[key];
    if (conv.messages.length === 0) continue;

    // Find matching contact in DB
    let contactRow = null;
    if (conv.linkedinUrl) {
      const { rows } = await db.query(
        `SELECT id, connection_tier FROM contacts WHERE user_id = $1 AND linkedin_url = $2 LIMIT 1`,
        [userId, conv.linkedinUrl]
      );
      contactRow = rows[0] || null;
    }
    if (!contactRow) {
      const { rows } = await db.query(
        `SELECT id, connection_tier FROM contacts
         WHERE user_id = $1 AND (full_name ILIKE $2 OR first_name || ' ' || last_name ILIKE $2) LIMIT 1`,
        [userId, `%${conv.name}%`]
      );
      contactRow = rows[0] || null;
    }

    if (!contactRow) continue;

    // Build content hash (for dedup) — never store raw content
    const rawHash = crypto.createHash('sha256')
      .update(conv.messages.map(m => m.content || '').join(''))
      .digest('hex');

    // Check if already parsed with same content
    const { rows: existing } = await db.query(
      `SELECT id, raw_hash FROM linkedin_messages WHERE user_id = $1 AND contact_id = $2 LIMIT 1`,
      [userId, contactRow.id]
    );
    if (existing.length && existing[0].raw_hash === rawHash) continue;

    // Summarize with Gemini Flash — ONLY summary stored, no raw messages
    const summary = await summarizeConversation(conv.name, conv.messages);

    const lastMsg = conv.messages
      .filter(m => m.date)
      .sort((a, b) => new Date(b.date) - new Date(a.date))[0];

    await db.query(`
      INSERT INTO linkedin_messages
        (user_id, contact_id, message_count, last_message_at, conversation_summary,
         topics_discussed, sentiment, raw_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (user_id, contact_id) DO UPDATE SET
        message_count        = EXCLUDED.message_count,
        last_message_at      = EXCLUDED.last_message_at,
        conversation_summary = EXCLUDED.conversation_summary,
        topics_discussed     = EXCLUDED.topics_discussed,
        sentiment            = EXCLUDED.sentiment,
        raw_hash             = EXCLUDED.raw_hash,
        parsed_at            = NOW()
    `, [
      userId, contactRow.id, conv.messages.length,
      lastMsg?.date ? new Date(lastMsg.date) : null,
      summary.text, summary.topics, summary.sentiment, rawHash,
    ]);

    // Auto-upgrade social → acquaintance when messages exist
    if (contactRow.connection_tier === 'social') {
      await db.query(
        `UPDATE contacts SET connection_tier = 'acquaintance', tier_set_by = 'system', tier_set_at = NOW()
         WHERE id = $1`,
        [contactRow.id]
      );
      upgraded++;
    }

    // Re-embed: unmark pinecone_indexed so worker re-embeds with richer text
    await db.query(
      `UPDATE contacts SET pinecone_indexed = false WHERE id = $1`,
      [contactRow.id]
    );

    // Recompute confidence
    await recomputeConfidence(contactRow.id);
    processed++;
  }

  logger.info(`[MessageParser] Done: ${processed} processed, ${upgraded} tiers upgraded`);
  return { processed, upgraded, total: contactKeys.length };
}

async function summarizeConversation(contactName, messages) {
  // Use last 30 messages max — cost control
  const sample = messages.slice(-30).map(m => m.content || '').filter(Boolean).join('\n');

  if (!sample.trim()) {
    return { text: null, topics: [], sentiment: 'neutral' };
  }

  try {
    const ai = getGenAI();
    if (!ai) return { text: null, topics: [], sentiment: 'neutral' };
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash-lite',
      contents: [{
        parts: [{
          text: `Analyze this LinkedIn message thread with ${contactName}. Respond in JSON only.

Messages:
${sample.slice(0, 3000)}

Return exactly: {"summary": "2-3 sentence summary", "topics": ["topic1","topic2"], "sentiment": "warm|neutral|cold"}`
        }]
      }]
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return { text: null, topics: [], sentiment: 'neutral' };

    const parsed = JSON.parse(json);
    return {
      text:      parsed.summary || null,
      topics:    Array.isArray(parsed.topics) ? parsed.topics.slice(0, 5) : [],
      sentiment: ['warm','neutral','cold'].includes(parsed.sentiment) ? parsed.sentiment : 'neutral',
    };
  } catch (err) {
    logger.warn(`[MessageParser] Gemini summarization failed: ${err.message}`);
    return { text: null, topics: [], sentiment: 'neutral' };
  }
}

module.exports = { parseMessagesCSV, processMessagesForUser };
