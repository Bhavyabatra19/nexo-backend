const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const pineconeService = require('../services/pineconeService');
const Contact = require('../models/Contact');
const { GoogleGenAI } = require('@google/genai');
const db = require('../db');
const AITokenService = require('../services/aiTokenService');

/**
 * Fetch enriched contact data from DB given a list of contact IDs.
 * Uses batched queries (4 total) instead of N+1 per contact.
 */
async function fetchEnrichedContacts(contactIds, userId) {
  if (!contactIds.length) return [];

  // 1. Batch-fetch all contacts
  const contactsRes = await db.query(
    'SELECT * FROM contacts WHERE id = ANY($1) AND user_id = $2',
    [contactIds, userId]
  );
  const contacts = contactsRes.rows;
  if (!contacts.length) return [];

  const ids = contacts.map(c => c.id);

  // 2. Batch-fetch notes, reminders, tags in parallel
  const [notesRes, remindersRes, tagsRes] = await Promise.all([
    db.query('SELECT contact_id, content FROM notes WHERE contact_id = ANY($1) AND user_id = $2', [ids, userId]),
    db.query('SELECT contact_id, title, due_date, is_completed FROM reminders WHERE contact_id = ANY($1) AND user_id = $2', [ids, userId]),
    db.query(`SELECT ct.contact_id, t.name FROM tags t JOIN contact_tags ct ON t.id = ct.tag_id WHERE ct.contact_id = ANY($1)`, [ids]),
  ]);

  // 3. Group by contact_id
  const notesMap = {};
  for (const n of notesRes.rows) {
    (notesMap[n.contact_id] ||= []).push(n.content);
  }
  const remindersMap = {};
  for (const r of remindersRes.rows) {
    (remindersMap[r.contact_id] ||= []).push(`${r.title} (Due: ${r.due_date}, Completed: ${r.is_completed})`);
  }
  const tagsMap = {};
  for (const t of tagsRes.rows) {
    (tagsMap[t.contact_id] ||= []).push(t.name);
  }

  // 4. Enrich
  for (const c of contacts) {
    c.notesList = (notesMap[c.id] || []).join('; ');
    c.remindersList = (remindersMap[c.id] || []).join('; ');
    c.tagsList = (tagsMap[c.id] || []).join(', ');
  }

  return contacts;
}

/**
 * Format contacts into a rich text block for the LLM
 */
function formatContactsForLLM(contacts) {
  if (contacts.length === 0) return 'No contacts found in the user\'s network matching this query.';
  
  return contacts.map((c, i) => {
    let text = `[Contact ${i + 1}] Name: ${c.full_name || 'Unknown'}`;
    if (c.job_title) text += ` | Title: ${c.job_title}`;
    if (c.company) text += ` | Company: ${c.company}`;
    if (c.email) text += ` | Email: ${c.email}`;
    if (c.phone) text += ` | Phone: ${c.phone}`;
    if (c.last_contacted) text += ` | Last Contacted: ${new Date(c.last_contacted).toLocaleDateString()}`;
    if (c.total_meetings) text += ` | Total Meetings: ${c.total_meetings}`;
    if (c.linkedin_url) text += ` | LinkedIn: ${c.linkedin_url}`;
    if (c.tagsList) text += ` | Tags: ${c.tagsList}`;
    if (c.notes) text += ` | Notes: ${c.notes}`;
    if (c.notesList) text += ` | Additional Notes: ${c.notesList}`;
    if (c.remindersList) text += ` | Reminders: ${c.remindersList}`;
    return text;
  }).join('\n');
}

/**
 * The conversational system prompt for Nexo AI
 */
const CONVERSATIONAL_SYSTEM_PROMPT = `You are **Nexo AI**, a conversational professional networking assistant. You help users leverage their professional connections to solve problems, find opportunities, and strengthen relationships.

## Your Core Behavior:
1. **ALWAYS relate responses back to the user's contacts.** Every answer should connect to people in their network. You are a networking intelligence assistant, not a general-purpose chatbot.

2. **Understand intent, not just keywords.** When a user says "I need help in marketing", understand they want to find connections who can help with marketing — suggest people with marketing expertise from their network.

3. **Be conversational and proactive.** Don't just list names. Explain WHY each person is relevant.

4. **Handle vague requests intelligently:**
   - "I need help with X" → Find connections with expertise in X, explain why they're relevant
   - "Who should I reconnect with?" → Suggest contacts they haven't spoken to in a while
   - "I'm looking for investors" → Find VCs, angel investors, fund managers in their network
   - "Any designers?" → Find UI/UX designers, graphic designers, product designers

## Output Formatting Rules:
- Use **Markdown** formatting for readability.
- Default to short, conversational paragraphs. This is the standard format for contact overviews, record overviews, and recommendations.
- Do not use tables, headings, or numbered sections unless the user explicitly asks for a list, comparison, or table.
- If you mention multiple contacts, weave them into one or two concise paragraphs or a very short prose list instead of tabular formatting.
- Use company context when relevant (e.g., "TechCorp is a leading SaaS platform for...") from AI summary column in contacts.

## Scope Boundaries:
- If the user asks something completely unrelated to networking/professional connections (e.g., "What's the weather?" or "Write me a poem"), politely redirect: "I'm Nexo AI — I'm best at helping you navigate your professional network! Try asking me things like 'Who can help me with fundraising?' or 'Find me designers in my network.'"
- You CAN discuss professional topics generally, but always bring it back to their contacts.

## Contact Data Context:
The following are contacts from the user's professional network. Use this data to inform your responses:
`;

/**
 * POST /api/ai/chat
 * Conversational AI chat — persists each turn to ai_chat_messages
 */
router.post('/chat', authenticateToken, async (req, res) => {
  try {
    const { message, searchNotes } = req.body;
    const userId = req.user.id;

    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is missing in backend' });
    }

    const isWithinLimit = await AITokenService.checkLimit(userId);
    if (!isWithinLimit) {
      return res.status(429).json({ success: false, error: 'Retry tomorrow you have consumed your daily ai usage limit', reply: 'Retry tomorrow you have consumed your daily ai usage limit' });
    }

    // 1. Save user message to DB
    await db.query(
      `INSERT INTO ai_chat_messages (user_id, role, content) VALUES ($1, 'user', $2)`,
      [userId, message]
    );

    // 2. Load last 10 messages from DB for AI context (excluding the one we just inserted)
    const historyResult = await db.query(
      `SELECT role, content FROM ai_chat_messages
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 11`,
      [userId]
    );
    // Reverse to chronological order, exclude the last one (the user msg we just saved)
    const dbHistory = historyResult.rows.reverse().slice(0, -1);

    // 3. Run the AI using nexoAIService (same logic, avoids duplication)
    const nexoAI = require('../services/nexoAIService');
    const { reply } = await nexoAI.chat(userId, message, dbHistory, { searchNotes: !!searchNotes });

    // 4. Save assistant reply to DB
    await db.query(
      `INSERT INTO ai_chat_messages (user_id, role, content) VALUES ($1, 'assistant', $2)`,
      [userId, reply]
    );

    res.json({ success: true, reply });

  } catch (error) {
    console.error('AI Chat Error:', error);
    res.status(500).json({ success: false, error: 'Something went wrong please try again later' });
  }
});

/**
 * GET /api/ai/history
 * Returns paginated chat history for the current user.
 * Query params:
 *   before  - ISO timestamp; returns messages older than this (for lazy loading)
 *   limit   - number of messages to return (default 20, max 50)
 *
 * Messages are returned in ascending (oldest→newest) order so the frontend
 * can simply prepend or append them.
 */
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const before = req.query.before; // ISO timestamp

    let rows;
    if (before) {
      const result = await db.query(
        `SELECT id, role, content, created_at
         FROM ai_chat_messages
         WHERE user_id = $1 AND created_at < $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [userId, before, limit]
      );
      rows = result.rows.reverse(); // return oldest→newest
    } else {
      const result = await db.query(
        `SELECT id, role, content, created_at
         FROM ai_chat_messages
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit]
      );
      rows = result.rows.reverse(); // return oldest→newest
    }

    // Check if there are more messages older than what we returned
    let hasMore = false;
    if (rows.length > 0) {
      const oldest = rows[0].created_at;
      const checkResult = await db.query(
        `SELECT 1 FROM ai_chat_messages WHERE user_id = $1 AND created_at < $2 LIMIT 1`,
        [userId, oldest]
      );
      hasMore = checkResult.rows.length > 0;
    }

    res.json({ success: true, messages: rows, hasMore });
  } catch (error) {
    console.error('AI History Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get the last time Pinecone was synced
 */
router.get('/sync-pinecone/status', authenticateToken, async (req, res) => {
  try {
    const result = await db.query('SELECT last_pinecone_sync as "lastSync", is_pinecone_syncing as "isSyncing" FROM users WHERE id = $1', [req.user.id]);
    
    // Get last 5 Pinecone syncs
    const historyResult = await db.query(`
      SELECT 
        id, sync_type, status, contacts_synced, events_synced,
        started_at, completed_at, duration_ms, error_message
      FROM sync_history
      WHERE user_id = $1 AND sync_type = 'Pinecone Embedding Sync'
      ORDER BY created_at DESC
      LIMIT 5
    `, [req.user.id]);

    res.json({ 
      success: true, 
      lastSync: result.rows[0]?.lastSync || null, 
      isSyncing: result.rows[0]?.isSyncing || false,
      history: historyResult.rows 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Sync endpoint to push contacts to Pinecone
 * Call this manually or conditionally to sync.
 */
router.post('/sync-pinecone', authenticateToken, async (req, res) => {
  const startTime = Date.now();
  try {
    const userId = req.user.id;

    // Check AI token limit before starting expensive embedding sync
    const isWithinLimit = await AITokenService.checkLimit(userId);
    if (!isWithinLimit) {
      return res.status(429).json({ success: false, error: 'Retry tomorrow you have consumed your daily ai usage limit' });
    }
    
    // Check if already syncing
    const userResult = await db.query('SELECT is_pinecone_syncing FROM users WHERE id = $1', [userId]);
    if (userResult.rows[0]?.is_pinecone_syncing) {
      return res.status(409).json({ success: false, error: 'Database is already syncing. Please wait.' });
    }
    
    // Set syncing lock
    await db.query(`UPDATE users SET is_pinecone_syncing = TRUE WHERE id = $1`, [userId]);

    const force = req.body?.force === true;
    
    let query = 'SELECT * FROM contacts WHERE user_id = $1';
    if (!force) {
      query += ` AND (last_embedded IS NULL OR updated_at > last_embedded OR last_synced > last_embedded)`;
    }
    query += ' LIMIT 10000';
    
    const contactsRes = await db.query(query, [userId]);
    const allContacts = contactsRes.rows;
    
    if (!allContacts.length) {
      await db.query(`UPDATE users SET last_pinecone_sync = CURRENT_TIMESTAMP, is_pinecone_syncing = FALSE WHERE id = $1`, [userId]);
      return res.json({ success: true, message: 'Databases are already fully synced.', count: 0 });
    }

    // Fetch relations for robust AI embeddings
    const allNotes = await db.query('SELECT contact_id, content FROM notes WHERE user_id = $1', [userId]);
    const allReminders = await db.query('SELECT contact_id, title FROM reminders WHERE user_id = $1', [userId]);
    
    const notesMap = {};
    allNotes.rows.forEach(n => {
       if (!notesMap[n.contact_id]) notesMap[n.contact_id] = [];
       notesMap[n.contact_id].push(n.content);
    });
    
    const remindersMap = {};
    allReminders.rows.forEach(r => {
       if (!remindersMap[r.contact_id]) remindersMap[r.contact_id] = [];
       remindersMap[r.contact_id].push(r.title);
    });

    allContacts.forEach(c => {
       c.notesList = notesMap[c.id] ? notesMap[c.id].join('; ') : '';
       c.remindersList = remindersMap[c.id] ? remindersMap[c.id].join('; ') : '';
    });

    const numUpserted = await pineconeService.upsertContacts(userId, allContacts);
    
    if (allContacts.length > 0) {
      const contactIds = allContacts.map(c => c.id);
      await db.query(`UPDATE contacts SET last_embedded = CURRENT_TIMESTAMP WHERE id = ANY($1)`, [contactIds]);
    }
    
    
    await db.query(`UPDATE users SET last_pinecone_sync = CURRENT_TIMESTAMP WHERE id = $1`, [userId]);
    
    // Record successful sync
    await db.query(`
      INSERT INTO sync_history (
        user_id, sync_type, status, contacts_synced, events_synced,
        started_at, completed_at, duration_ms
      )
      VALUES ($1, 'Pinecone Embedding Sync', 'success', $2, 0, $3, CURRENT_TIMESTAMP, $4)
    `, [
      userId,
      numUpserted,
      new Date(startTime),
      Date.now() - startTime
    ]).catch(err => console.error('Failed to record sync history:', err));

    res.json({
      success: true,
      message: `Successfully embedded and synced ${numUpserted} contacts to Pinecone.`,
      count: numUpserted
    });
  } catch (error) {
    console.error('Pinecone Sync Error:', error);
    
    // Record failed sync
    await db.query(`
      INSERT INTO sync_history (
        user_id, sync_type, status, started_at, completed_at,
        duration_ms, error_message
      )
      VALUES ($1, 'Pinecone Embedding Sync', 'failed', $2, CURRENT_TIMESTAMP, $3, $4)
    `, [
      req.user.id,
      new Date(startTime),
      Date.now() - startTime,
      error.message
    ]).catch(err => console.error('Failed to record sync error:', err));
    
    res.status(500).json({ success: false, error: error.message || 'Error syncing to Pinecone' });
  } finally {
    // Release the pinecone sync lock
    await db.query(`UPDATE users SET is_pinecone_syncing = FALSE WHERE id = $1`, [req.user.id]).catch(console.error);
  }
});

/**
 * POST /api/ai/summary/:contactId
 * Generate an AI overview/summary for a specific contact
 */
router.post('/summary/:contactId', authenticateToken, async (req, res) => {
  try {
    const contactId = req.params.contactId;
    const userId = req.user.id;

    const isWithinLimit = await AITokenService.checkLimit(userId);
    if (!isWithinLimit) {
      return res.status(429).json({ success: false, error: 'Retry tomorrow you have consumed your daily ai usage limit' });
    }

    // Fetch enriched contact data
    const enrichedContacts = await fetchEnrichedContacts([contactId], userId);
    if (enrichedContacts.length === 0) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }
    const contactData = enrichedContacts[0];

    // Format contact for prompt
    let text = `Name: ${contactData.full_name || 'Unknown'}`;
    if (contactData.job_title) text += ` | Title: ${contactData.job_title}`;
    if (contactData.company) text += ` | Company: ${contactData.company}`;
    if (contactData.email) text += ` | Email: ${contactData.email}`;
    if (contactData.bio) text += ` | Bio: ${contactData.bio}`;
    if (contactData.notes) text += ` | Notes: ${contactData.notes}`;
    if (contactData.notesList) text += ` | Additional Notes: ${contactData.notesList}`;
    if (contactData.tagsList) text += ` | Tags: ${contactData.tagsList}`;

    const prompt = `Based on the following contact details, create a brief professional summary as a single concise paragraph.
  Focus on who they are, their role or company, and any recent relationship context from their notes, reminders, or tags. Use the Google Search tool to add a relevant company detail when it helps. Keep it concise and natural. Do not use headings, bullets, numbered sections, or labels like "Profile Overview" or "Company Overview".

Contact Data:
${text}`;

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });
    
    const summary = response.text.trim();
    
    // Add usage to token counter
    if (response.usageMetadata) {
      await AITokenService.addTokens(userId, response.usageMetadata.promptTokenCount, response.usageMetadata.candidatesTokenCount);
    }

    // Save to DB
    const db = require('../db');
    await db.query(`UPDATE contacts SET ai_summary = $1 WHERE id = $2 AND user_id = $3`, [summary, contactId, userId]);

    res.json({ success: true, ai_summary: summary });
  } catch (error) {
    console.error('AI Summary Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Error communicating with AI' });
  }
});

/**
 * POST /api/ai/query-builder
 * Converts natural language to a structured contact list criteria object
 */
router.post('/query-builder', authenticateToken, async (req, res) => {
  try {
    const { prompt } = req.body;
    const userId = req.userId || (req.user && req.user.id);

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'Prompt is required' });
    }

    // Check token limit
    const isWithinLimit = await AITokenService.checkLimit(userId);
    if (!isWithinLimit) {
      return res.status(429).json({ success: false, error: 'Retry tomorrow you have consumed your daily ai usage limit' });
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [{ text: `You are a Nexo CRM Query Specialist. Your job is to convert natural language into a structured JSON "criteria" object for filtering contacts.

### Field Mappings:
- **source**: "google" (if Google sync mentioned), "linkedin" (if LinkedIn mentioned), "manual" (if manually added).
- **filter**: "stale" (not contacted in >30 days), "favorites" (starred), "no-calendar" (never contacted).
- **query**: String of 'field:value' pairs joined by '(and)' or '(or)'.
  - Fields: 'name', 'company', 'title', 'any' (use 'any' for general keywords like skills or intents).
  - Example: "company:Microsoft (and) any:fundraising"

### Hard Rules:
1. EXHAUSTIVE EXTRACTION: Include ALL keywords from the prompt in the result. If a word like "marketing" or "fundraising" is mentioned, it MUST appear in the "query" field (usually as any:marketing).
2. SAME-FIELD VALUES USE (or): When multiple values belong to the SAME field, join them with "(or)" because the user wants contacts matching ANY of those values. E.g. "venture capitalist and portfolio manager" are both titles, so use "title:venture capitalist (or) title:portfolio manager".
3. DIFFERENT-FIELD VALUES USE (and): When values belong to DIFFERENT fields, join them with "(and)". E.g. "designers at Google" → "title:designer (and) company:Google".
4. SOURCE SELECTION: If they mention LinkedIn, set source to "linkedin".
5. Result MUST be valid JSON.

### Examples:
- Query: "Find venture capitalists and portfolio managers"
  Result: { "query": "title:venture capitalist (or) title:portfolio manager" }

- Query: "LinkedIn investors who help with fundraising and marketing"
  Result: { "source": "linkedin", "query": "title:investor (and) any:fundraising (and) any:marketing" }

- Query: "Founders or CEOs at YC companies who are my favorites"
  Result: { "filter": "favorites", "query": "title:Founder (or) title:CEO (and) company:YC" }

- Query: "People at Google or Microsoft"
  Result: { "query": "company:Google (or) company:Microsoft" }

- Query: "Stale contacts at TechCorp"
  Result: { "filter": "stale", "query": "company:TechCorp" }

User Prompt: "${prompt}"
Result (JSON ONLY):` }]
        }
      ],
      config: { temperature: 0 }
    });

    // Handle token tracking using usageMetadata from response
    if (response.usageMetadata) {
      await AITokenService.addTokens(userId, response.usageMetadata.promptTokenCount, response.usageMetadata.candidatesTokenCount);
    }

    let jsonStr = response.text.trim();
    // Clean JSON response (handle potential markdown blocks)
    if (jsonStr.startsWith('```json')) jsonStr = jsonStr.replace(/^```json/, '').replace(/```\s*$/, '');
    else if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```/, '').replace(/```\s*$/, '');

    try {
      const criteria = JSON.parse(jsonStr);
      res.json({ success: true, criteria });
    } catch (e) {
      console.error('AI Query Builder failed to produce valid JSON:', response.text, e.message);
      res.status(500).json({ success: false, error: 'AI generated an invalid structure. Try being more specific.' });
    }

  } catch (error) {
    console.error('Query builder error:', error.message, error.stack);
    res.status(500).json({ success: false, error: 'Failed to generate AI query: ' + error.message });
  }
});

module.exports = router;

