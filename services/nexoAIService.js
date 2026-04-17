/**
 * Nexo AI Core Service
 *
 * Extracts the conversational AI logic from routes/ai.js so it can be
 * reused by both the REST endpoint and the WhatsApp handler without
 * duplicating code or creating circular dependencies.
 *
 * Single export: chat(userId, message, history) → { reply }
 */

const { GoogleGenAI } = require('@google/genai');
const pineconeService  = require('./pineconeService');
const Contact          = require('../models/Contact');
const Note             = require('../models/Note');
const Reminder         = require('../models/Reminder');
const AITokenService   = require('./aiTokenService');
const { scheduleReminder, cancelReminder } = require('./reminderScheduler');
const db               = require('../db');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (identical to the ones in routes/ai.js)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchEnrichedContacts(contactIds, userId) {
  if (!contactIds.length) return [];

  // Batch-fetch all contacts in one query
  const contactsRes = await db.query(
    'SELECT * FROM contacts WHERE id = ANY($1) AND user_id = $2',
    [contactIds, userId]
  );
  const contacts = contactsRes.rows;
  if (!contacts.length) return [];

  const ids = contacts.map(c => c.id);

  // Batch-fetch notes, reminders, tags in parallel (3 queries total instead of 4N)
  const [notesRes, remindersRes, tagsRes] = await Promise.all([
    db.query('SELECT contact_id, id, title, content FROM notes WHERE contact_id = ANY($1) AND user_id = $2', [ids, userId]),
    db.query('SELECT contact_id, id, title, due_date, is_completed FROM reminders WHERE contact_id = ANY($1) AND user_id = $2', [ids, userId]),
    db.query('SELECT ct.contact_id, t.name FROM tags t JOIN contact_tags ct ON t.id = ct.tag_id WHERE ct.contact_id = ANY($1)', [ids]),
  ]);

  // Group by contact_id
  const notesMap = {};
  for (const n of notesRes.rows) {
    (notesMap[n.contact_id] ||= []).push(`[ID:${n.id}] ${n.title ? n.title + ': ' : ''}${n.content}`);
  }
  const remindersMap = {};
  for (const r of remindersRes.rows) {
    (remindersMap[r.contact_id] ||= []).push(`[ID:${r.id}] ${r.title} (Due: ${r.due_date}, Completed: ${r.is_completed})`);
  }
  const tagsMap = {};
  for (const t of tagsRes.rows) {
    (tagsMap[t.contact_id] ||= []).push(t.name);
  }

  for (const c of contacts) {
    c.notesList     = (notesMap[c.id] || []).join('; ');
    c.remindersList = (remindersMap[c.id] || []).join('; ');
    c.tagsList      = (tagsMap[c.id] || []).join(', ');
  }

  return contacts;
}

function formatContactsForLLM(contacts) {
  if (contacts.length === 0) return "No contacts found in the user's network matching this query.";

  return contacts.map((c, i) => {
    // Use short index instead of full UUID to save tokens; keep ID available for tool calls
    let text = `[${i + 1}] ${c.id} | ${c.full_name || 'Unknown'}`;
    if (c.job_title)     text += ` | ${c.job_title}`;
    if (c.company)       text += ` | @${c.company}`;
    if (c.email)         text += ` | ${c.email}`;
    // Omit phone and linkedin_url — rarely referenced by AI
    if (c.last_contacted) text += ` | LC:${new Date(c.last_contacted).toLocaleDateString()}`;
    if (c.total_meetings > 0) text += ` | Mtgs:${c.total_meetings}`;
    if (c.tagsList)      text += ` | Tags:${c.tagsList}`;
    // Deduplicate: skip c.notes if notesList covers it; truncate both
    if (c.notesList)     text += ` | Notes:${c.notesList.substring(0, 200)}`;
    else if (c.notes)    text += ` | Notes:${c.notes.substring(0, 200)}`;
    if (c.remindersList) text += ` | Rem:${c.remindersList.substring(0, 150)}`;
    return text;
  }).join('\n');
}

const CONVERSATIONAL_SYSTEM_PROMPT = `You are **Nexo AI**, a conversational professional networking assistant. You help users leverage their professional connections to solve problems, find opportunities, and strengthen relationships.

## ⚠️ CRITICAL ANTI-HALLUCINATION RULES (Read First):
These rules override everything else and must never be violated:

1. **NEVER contradict your own previous responses.** If you identified a contact (e.g., "Om Agrawal, Category Manager at Urban Company") in an earlier turn of this conversation, that contact EXISTS in the user's network. Do NOT say they are "not found" or "not in your contacts" in a later turn. The contact data provided below is a fresh search result and may not always re-surface the same contacts — that is a search limitation, NOT evidence the contact is gone.

2. **ALWAYS scan the conversation history first.** Before concluding a contact doesn't exist, check if they were mentioned by name in any prior AI response in this conversation. If they were, treat them as confirmed and proceed accordingly.

3. **Never invent contact IDs.** If you need a contact's ID for a tool call and cannot find it in the current contact data, but the contact was confirmed in history, explicitly tell the user: "I need to look up [Name]'s details again — could you confirm which [Name] you mean?" Do NOT fabricate a UUID.

4. **Confirmed contacts are sticky for the whole session.** Once a contact is confirmed (user selected them from a disambiguation list, or you identified them and user proceeded), treat them as fully confirmed for all subsequent turns.

---

## Your Core Behavior:
1. **ALWAYS relate responses back to the user's contacts.** Every answer should connect to people in their network. You are a networking intelligence assistant, not a general-purpose chatbot.

2. **Understand intent, not just keywords.** When a user says "I need help in marketing", understand they want to find connections who can help with marketing — suggest people with marketing expertise from their network.

3. **Be conversational and proactive.** Don't just list names. Explain WHY each person is relevant.

4. **Handle vague requests intelligently:**
   - "I need help with X" → Find connections with expertise in X, explain why they're relevant
   - "Who should I reconnect with?" → Suggest contacts they haven't spoken to in a while
   - "I'm looking for investors" → Find VCs, angel investors, fund managers in their network
   - "Any designers?" → Find UI/UX designers, graphic designers, product designers

5. **Handling CRUD Operations (Notes and Reminders):**
   - If the user asks to add, update, or delete a note or reminder for a contact, find the most relevant contact, then inspect their details to find the specific ID of the note or reminder.
   - **CRITICAL:** Before calling the tool to add, update, or delete the note or reminder, you MUST summarize what you are about to do (e.g., "I will delete the reminder for [Name] about [Task]") and EXPLICITLY ASK FOR CONFIRMATION from the user (e.g. "Should I go ahead and do this?").
   - ONLY call the tool after the user explicitly replies with a "yes" or equivalent confirmation. 
   - Never modify or delete data without asking for confirmation first.
   - If the contact was confirmed in a prior turn, use the contact ID from the [CONFIRMED CONTACTS] section injected into this prompt — do NOT re-search.

## Output Formatting Rules:
- Use **Markdown** formatting for readability.
- Default to short, conversational paragraphs. This is the standard format for contact overviews, record overviews, and recommendations.
- Do not use tables, headings, or numbered sections unless the user explicitly asks for a list, comparison, or table.
- If you mention multiple contacts, weave them into one or two concise paragraphs or a very short prose list instead of tabular formatting.

## Scope Boundaries:
- If the user asks something completely unrelated to networking/professional connections (e.g., "What's the weather?" or "Write me a poem"), politely redirect: "I'm Nexo AI — I'm best at helping you navigate your professional network! Try asking me things like 'Who can help me with fundraising?' or 'Find me designers in my network.'"
- You CAN discuss professional topics generally, but always bring it back to their contacts.

## Contact Data Context:
The following are contacts from the user's professional network retrieved for this query. Note: this list may not be exhaustive — always cross-reference with [CONFIRMED CONTACTS] below.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Cached system prompt + date context (rebuilt once per day)
// ─────────────────────────────────────────────────────────────────────────────
let _cachedSystemBase = null;
let _cachedSystemDate = null;

function getSystemPromptBase() {
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (_cachedSystemDate === todayStr) return _cachedSystemBase;

  const todayFriendly = now.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const dateContext = `\n## Current Date & Time Context:\nToday is **${todayFriendly}** (${todayStr}) in IST (Asia/Kolkata). Use this to resolve any relative dates like "today", "tomorrow", "next Monday", or bare dates without a year.\n`;
  _cachedSystemBase = `${CONVERSATIONAL_SYSTEM_PROMPT}\n${dateContext}---\n`;
  _cachedSystemDate = todayStr;
  return _cachedSystemBase;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract names mentioned in prior AI responses so we can re-anchor searches
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan conversation history for contact names the AI already confirmed.
 * We look for bold-marked names (**Name**) in model turns, which is the
 * output format we enforce in the system prompt.
 * Returns a deduplicated array of name strings.
 */
function extractMentionedNamesFromHistory(history) {
  const names = new Set();
  for (const msg of history) {
    if (msg.role !== 'model') continue;
    // Match **Name** patterns (bold names in markdown responses)
    const boldMatches = (msg.content || '').matchAll(/\*\*([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)+)\*\*/g);
    for (const m of boldMatches) names.add(m[1]);
    // Also match plain "Name (Title at Company)" patterns at line starts
    const listMatches = (msg.content || '').matchAll(/^\*?\s*([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)+)\s*[\(|]/gm);
    for (const m of listMatches) names.add(m[1]);
  }
  return Array.from(names);
}

/**
 * Run a single conversational Nexo AI turn.
 *
 * @param {string} userId   - Authenticated user's UUID
 * @param {string} message  - The user's current message
 * @param {Array}  history  - Previous turns: [{ role: 'user'|'model', content: string }, ...]
 *                            Pass [] for a fresh conversation.
 * @param {Object} options  - Optional flags
 * @param {boolean} options.searchNotes - When true, fetch all user notes and include as extra context
 * @returns {Promise<{ reply: string }>}
 */
async function chat(userId, message, history = [], options = {}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is missing');
  }

  const isWithinLimit = await AITokenService.checkLimit(userId);
  if (!isWithinLimit) {
    return { reply: 'Retry tomorrow you have consumed your daily ai usage limit' };
  }

  // ── Semantic search for relevant contacts ──────────────────────────────────
  let contactsData = [];

  // Construct a richer search query using recent conversation history to maintain context.
  // This prevents losing contact reference when a user says "yes add it" or "add a note for him".
  const recentContext = history.slice(-4).map(m => m.content).join(' ');
  const searchQuery = `${recentContext} ${message}`.trim();

  let combinedContactIds = new Set();
  const mentionedNames = extractMentionedNamesFromHistory(history);

  // Run all three search strategies in parallel instead of sequentially
  const searchPromises = [
    // 1. Pinecone Semantic Search
    pineconeService.searchContacts(userId, searchQuery, 25)
      .catch(err => { console.error('[NexoAI] Pinecone search error:', err.message); return []; }),

    // 2. Exact Name Supplementary Database Search
    db.query(`
      SELECT id FROM contacts
      WHERE user_id = $1
      AND (
        $2 ILIKE '%' || full_name || '%' OR
        (first_name IS NOT NULL AND LENGTH(first_name) > 1 AND (' ' || REPLACE(REPLACE(REPLACE($2, ',', ' '), '.', ' '), '!', ' ') || ' ') ILIKE '% ' || first_name || ' %') OR
        (LENGTH($3) > 2 AND full_name ILIKE '%' || $3 || '%') OR
        (LENGTH($3) > 2 AND company ILIKE '%' || $3 || '%')
      )
      LIMIT 15
    `, [userId, searchQuery, message])
      .then(r => r.rows.map(row => row.id))
      .catch(err => { console.error('[NexoAI] Supplementary DB search failed:', err.message); return []; }),
  ];

  // 3. History-anchored contact pinning (only if names exist in history)
  if (mentionedNames.length > 0) {
    const conditions = mentionedNames.map((_, i) => `full_name ILIKE $${i + 2}`).join(' OR ');
    const params = [userId, ...mentionedNames.map(n => `%${n}%`)];
    searchPromises.push(
      db.query(`SELECT id FROM contacts WHERE user_id = $1 AND (${conditions}) LIMIT 20`, params)
        .then(r => {
          if (r.rows.length > 0) console.log(`[NexoAI] History-anchored ${r.rows.length} contact(s) from prior turns`);
          return r.rows.map(row => row.id);
        })
        .catch(err => { console.error('[NexoAI] History-anchor DB search failed:', err.message); return []; })
    );
  }

  const searchResults = await Promise.all(searchPromises);
  for (const ids of searchResults) {
    for (const id of ids) combinedContactIds.add(id);
  }

  // Use 15 contacts for most queries; keeps token cost low without losing relevance
  const finalContactIds = Array.from(combinedContactIds).slice(0, 15);
  contactsData = await fetchEnrichedContacts(finalContactIds, userId);

  // If still empty, provide a sample of the user's contacts for context
  if (contactsData.length === 0) {
    const allContacts = await Contact.getAll(userId, { limit: 15 });
    contactsData = await fetchEnrichedContacts(allContacts.map(c => c.id), userId);
  }

  // ── Build Gemini contents array ────────────────────────────────────────────
  const dataContext = formatContactsForLLM(contactsData);

  // ── Notes search context (only when user explicitly asked to search notes) ─
  let notesContext = '';
  if (options.searchNotes) {
    try {
      const notesRes = await db.query(`
        SELECT n.title, n.content, n.created_at, c.full_name as contact_name
        FROM notes n
        LEFT JOIN contacts c ON n.contact_id = c.id
        WHERE n.user_id = $1
        ORDER BY n.created_at DESC
        LIMIT 200
      `, [userId]);

      if (notesRes.rows.length > 0) {
        const notesText = notesRes.rows.map((n, i) => {
          let line = `[Note ${i + 1}]`;
          if (n.contact_name) line += ` Contact: ${n.contact_name}`;
          if (n.title) line += ` | Title: ${n.title}`;
          line += ` | Content: ${n.content}`;
          line += ` | Created: ${new Date(n.created_at).toLocaleDateString()}`;
          return line;
        }).join('\n');
        notesContext = `\n## User's Notes:\nThe user wants you to search through their notes. Here are all their notes — use these to answer their question:\n${notesText}\n`;
      } else {
        notesContext = `\n## User's Notes:\nThe user has no notes yet.\n`;
      }
    } catch (err) {
      console.error('[NexoAI] Notes search failed:', err.message);
    }
  }

  // Build a "confirmed contacts" block from names already mentioned in history.
  // This is injected explicitly so the model cannot claim a contact is missing.
  const confirmedNamesBlock = mentionedNames.length > 0
    ? `\n## [CONFIRMED CONTACTS — These contacts were already identified in this session. Do NOT say they are missing or unknown.]\n${mentionedNames.map(n => `- ${n}`).join('\n')}\n`
    : '';

  const conversationContents = [];

  // Inject the last 6 history turns (trimmed to 1000 chars each to save tokens)
  for (const msg of history.slice(-6)) {
    conversationContents.push({
      role:  msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: (msg.content || '').substring(0, 1000) }],
    });
  }

  // Current user turn with cached system context
  conversationContents.push({
    role:  'user',
    parts: [{ text: `${getSystemPromptBase()}${dataContext}\n${notesContext}${confirmedNamesBlock}---\n\nUser message: ${message}` }],
  });

  // ── Conditionally include CRUD tools only when intent is detected ──────────
  const CRUD_KEYWORDS = /\b(add|create|set|make|write|delete|remove|update|edit|change|modify|complete|mark|remind|note|reminder|reminders|pending|overdue|upcoming)\b/i;
  const recentText = `${message} ${history.slice(-3).map(m => m.content).join(' ')}`;
  const hasCrudIntent = CRUD_KEYWORDS.test(recentText);

  const tools = !hasCrudIntent ? [] : [
    {
      functionDeclarations: [
        {
          name: 'add_note',
          description: 'Creates a new note for a specific contact. CRITICAL: Wait for user confirmation before calling.',
          parameters: {
            type: 'OBJECT',
            properties: {
              contactId: { type: 'STRING', description: 'The UUID of the contact. You MUST obtain this from the contact data context.' },
              title: { type: 'STRING', description: 'A short title for the note.' },
              content: { type: 'STRING', description: 'The content of the note.' }
            },
            required: ['contactId', 'content']
          }
        },
        {
          name: 'add_reminder',
          description: 'Creates a new reminder for a specific contact. CRITICAL: Wait for user confirmation before calling.',
          parameters: {
            type: 'OBJECT',
            properties: {
              contactId: { type: 'STRING', description: 'The UUID of the contact. You MUST obtain this from the contact data context.' },
              title: { type: 'STRING', description: 'The title or task for the reminder.' },
              dueDate: { type: 'STRING', description: 'The due date and optional time in YYYY-MM-DD or YYYY-MM-DD HH:mm format. Use the exact time the user specifies (e.g., 18:07, 09:42). Do not round.' }
            },
            required: ['contactId', 'title', 'dueDate']
          }
        },
        {
          name: 'update_note',
          description: 'Updates an existing note for a contact. CRITICAL: Wait for user confirmation before calling.',
          parameters: {
            type: 'OBJECT',
            properties: {
              noteId: { type: 'STRING', description: 'The UUID of the note to update (from the contact notes list).' },
              title: { type: 'STRING', description: 'The new title for the note.' },
              content: { type: 'STRING', description: 'The new content of the note.' }
            },
            required: ['noteId', 'content']
          }
        },
        {
          name: 'delete_note',
          description: 'Deletes an existing note. CRITICAL: Wait for user confirmation before calling.',
          parameters: {
            type: 'OBJECT',
            properties: {
              noteId: { type: 'STRING', description: 'The UUID of the note to delete (from the contact notes list).' }
            },
            required: ['noteId']
          }
        },
        {
          name: 'update_reminder',
          description: 'Updates an existing reminder for a contact. CRITICAL: Wait for user confirmation before calling.',
          parameters: {
            type: 'OBJECT',
            properties: {
              reminderId: { type: 'STRING', description: 'The UUID of the reminder to update.' },
              contactId: { type: 'STRING', description: 'The UUID of the contact associated with the reminder.' },
              title: { type: 'STRING', description: 'The new title for the reminder.' },
              dueDate: { type: 'STRING', description: 'The new due date/time.' },
              isCompleted: { type: 'BOOLEAN', description: 'Whether the reminder is completed.' }
            },
            required: ['reminderId', 'contactId']
          }
        },
        {
          name: 'delete_reminder',
          description: 'Deletes an existing reminder. CRITICAL: Wait for user confirmation before calling.',
          parameters: {
            type: 'OBJECT',
            properties: {
              reminderId: { type: 'STRING', description: 'The UUID of the reminder to delete (from the contact reminders list).' }
            },
            required: ['reminderId']
          }
        },
        {
          name: 'list_reminders',
          description: 'Lists the user\'s reminders. Use this when the user asks about upcoming, pending, overdue, or past reminders. Does NOT require confirmation.',
          parameters: {
            type: 'OBJECT',
            properties: {
              filter: { type: 'STRING', description: 'Filter type: "upcoming" (not completed, due in future), "overdue" (not completed, past due), "completed", or "all". Default "upcoming".' }
            },
            required: []
          }
        }
      ]
    }
  ];

  // ── Call Gemini ────────────────────────────────────────────────────────────
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const geminiConfig = tools.length > 0 ? { tools } : {};
  const response = await ai.models.generateContent({
    model:    'gemini-2.5-flash',
    contents: conversationContents,
    config:   geminiConfig,
  });

  if (response.usageMetadata) {
    await AITokenService.addTokens(userId, response.usageMetadata.promptTokenCount, response.usageMetadata.candidatesTokenCount);
  }

  let replyText = response.text;

  // ── Handle Function Calls (Tools) ──────────────────────────────────────────
  if (response.functionCalls && response.functionCalls.length > 0) {
    const fnCall = response.functionCalls[0];
    let result = {};

    try {
      if (fnCall.name === 'add_note') {
        const { contactId, title, content } = fnCall.args;
        await Note.create(contactId, userId, content, title);
        
        const ActivityModel = require('../models/Activity');
        const activityDesc = title ? `Added note: ${title}` : `Added note: ${content.length > 50 ? content.substring(0, 50) + '...' : content}`;
        await ActivityModel.create(contactId, userId, 'note_added', activityDesc);
        await db.query(`UPDATE contacts SET ai_summary = NULL WHERE id = $1 AND user_id = $2`, [contactId, userId]);

        result = { success: true, message: 'Note successfully added to the contact.' };
        console.log(`[NexoAI] Tool 'add_note' executed for user ${userId}, contact ${contactId}`);
      } else if (fnCall.name === 'add_reminder') {
        const { contactId, title, dueDate } = fnCall.args;

        const createdReminder = await Reminder.create(contactId, userId, title, dueDate, null);

        // Schedule exact-time notification
        scheduleReminder({ id: createdReminder.id, due_date: dueDate, user_id: userId, contact_id: contactId });

        const ActivityModel = require('../models/Activity');
        await ActivityModel.create(contactId, userId, 'reminder_created', title ? `Set reminder: ${title}` : `Set reminder`);
        await db.query(`UPDATE contacts SET ai_summary = NULL WHERE id = $1 AND user_id = $2`, [contactId, userId]);

        result = { success: true, message: 'Reminder successfully added to the contact.' };
        console.log(`[NexoAI] Tool 'add_reminder' executed for user ${userId}, contact ${contactId} with date ${dueDate}`);
      } else if (fnCall.name === 'update_note') {
        const { noteId, title, content } = fnCall.args;
        await Note.update(noteId, userId, content, title);
        
        const noteRow = await db.query('SELECT contact_id FROM notes WHERE id = $1 AND user_id = $2', [noteId, userId]);
        if (noteRow.rows.length > 0) {
            const ActivityModel = require('../models/Activity');
            const activityDesc = title ? `Updated note: ${title}` : `Updated note: ${content.length > 50 ? content.substring(0, 50) + '...' : content}`;
            await ActivityModel.create(noteRow.rows[0].contact_id, userId, 'note_updated', activityDesc);
            await db.query(`UPDATE contacts SET ai_summary = NULL WHERE id = $1 AND user_id = $2`, [noteRow.rows[0].contact_id, userId]);
        }
        
        result = { success: true, message: 'Note successfully updated.' };
        console.log(`[NexoAI] Tool 'update_note' executed for user ${userId}, note ${noteId}`);
      } else if (fnCall.name === 'delete_note') {
        const { noteId } = fnCall.args;
        const noteRow = await db.query('SELECT contact_id, title, content FROM notes WHERE id = $1 AND user_id = $2', [noteId, userId]);
        
        await Note.delete(noteId, userId);
        
        if (noteRow.rows.length > 0) {
            const noteTitle = noteRow.rows[0].title || noteRow.rows[0].content?.substring(0, 50);

            // Intentionally not creating a "note_deleted" activity entry.
            // Keeping deleted-note events out of timeline avoids showing removed content history.
            // const ActivityModel = require('../models/Activity');
            // await ActivityModel.create(
            //     noteRow.rows[0].contact_id,
            //     userId,
            //     'note_deleted',
            //     `Deleted note: ${noteTitle}`
            // );

            await db.query(
                `DELETE FROM activities WHERE contact_id = $1 AND user_id = $2 AND type = 'note_updated' AND description LIKE $3`, 
                [noteRow.rows[0].contact_id, userId, `Updated note: ${noteTitle}%`]
            );
            await db.query(
                `DELETE FROM activities WHERE contact_id = $1 AND user_id = $2 AND type = 'note_added' AND description LIKE $3`, 
                [noteRow.rows[0].contact_id, userId, `Added note: ${noteTitle}%`]
            );
            await db.query(`UPDATE contacts SET ai_summary = NULL WHERE id = $1 AND user_id = $2`, [noteRow.rows[0].contact_id, userId]);
        }
        
        result = { success: true, message: 'Note successfully deleted.' };
        console.log(`[NexoAI] Tool 'delete_note' executed for user ${userId}, note ${noteId}`);
      } else if (fnCall.name === 'update_reminder') {
        let { reminderId, contactId, title, dueDate, isCompleted } = fnCall.args;
        
        const existingReminders = await Reminder.getByContactId(contactId, userId);
        const existing = existingReminders.reminders.find(r => r.id === reminderId);
        if (!existing) {
             result = { error: 'Reminder not found for this contact.' };
        } else {
             await Reminder.update(
                 reminderId, 
                 userId, 
                 contactId, 
                 title || existing.title, 
                 dueDate || existing.dueDate, 
                 isCompleted !== undefined ? isCompleted : existing.isCompleted, 
                 existing.recurrence
             );
             // Reschedule or cancel the in-memory timer
             if (isCompleted) {
               cancelReminder(reminderId);
             } else if (dueDate) {
               scheduleReminder({ id: reminderId, due_date: dueDate, user_id: userId, contact_id: contactId || existing.contactId });
             }

             result = { success: true, message: 'Reminder successfully updated.' };
             console.log(`[NexoAI] Tool 'update_reminder' executed for user ${userId}, reminder ${reminderId}`);

             const ActivityModel = require('../models/Activity');
             if (isCompleted !== undefined && isCompleted !== existing.isCompleted) {
                 await ActivityModel.create(
                     contactId || existing.contactId, 
                     userId, 
                     'reminder_completed', 
                     isCompleted ? `Completed task: ${title || existing.title}` : `Re-opened task: ${title || existing.title}`
                 );
             } else {
                 await ActivityModel.create(
                     contactId || existing.contactId, 
                     userId, 
                     'reminder_updated', 
                     `Updated task: ${title || existing.title}`
                 );
             }
             await db.query(`UPDATE contacts SET ai_summary = NULL WHERE id = $1 AND user_id = $2`, [contactId || existing.contactId, userId]);
        }
      } else if (fnCall.name === 'delete_reminder') {
        const { reminderId } = fnCall.args;
        const reminderRow = await db.query('SELECT contact_id, title FROM reminders WHERE id = $1 AND user_id = $2', [reminderId, userId]);
        
        await Reminder.delete(reminderId, userId);
        cancelReminder(reminderId);

        if (reminderRow.rows.length > 0) {
            const { contact_id, title } = reminderRow.rows[0];
            const ActivityModel = require('../models/Activity');
            
            await ActivityModel.create(
                contact_id, 
                userId, 
                'reminder_deleted', 
                `Deleted task: ${title}`
            );

            await db.query(
                `DELETE FROM activities WHERE contact_id = $1 AND user_id = $2 AND type IN ('reminder_created', 'reminder_completed', 'reminder_updated') AND (description LIKE $3 OR description LIKE $4 OR description LIKE $5 OR description LIKE $6)`,
                [contact_id, userId, `%${title}%`, `Set reminder: ${title}`, `Completed task: ${title}`, `Updated task: ${title}`]
            );
            await db.query(`UPDATE contacts SET ai_summary = NULL WHERE id = $1 AND user_id = $2`, [contact_id, userId]);
        }
        
        result = { success: true, message: 'Reminder successfully deleted.' };
        console.log(`[NexoAI] Tool 'delete_reminder' executed for user ${userId}, reminder ${reminderId}`);
      } else if (fnCall.name === 'list_reminders') {
        const filter = fnCall.args?.filter || 'upcoming';
        const allReminders = await Reminder.getAllByUserId(userId, 50, 0);
        const now = new Date();
        let filtered = allReminders.reminders;

        if (filter === 'upcoming') {
          filtered = filtered.filter(r => !r.isCompleted && new Date(r.dueDate) >= now);
        } else if (filter === 'overdue') {
          filtered = filtered.filter(r => !r.isCompleted && new Date(r.dueDate) < now);
        } else if (filter === 'completed') {
          filtered = filtered.filter(r => r.isCompleted);
        }

        result = {
          reminders: filtered.map(r => ({
            id: r.id,
            title: r.title,
            dueDate: r.dueDate,
            isCompleted: r.isCompleted,
            contactName: r.contactName || null,
          })),
          count: filtered.length,
        };
        console.log(`[NexoAI] Tool 'list_reminders' executed for user ${userId}, filter=${filter}, found ${filtered.length}`);
      } else {
        result = { error: 'Unknown function call.' };
      }
    } catch (err) {
      console.error('[NexoAI] Tool execution error:', err.message);
      result = { error: 'Failed to execute action due to a server error.' };
    }

    conversationContents.push({ role: 'model', parts: [{ functionCall: fnCall }] });
    conversationContents.push({
      role: 'user',
      parts: [{ functionResponse: { name: fnCall.name, response: result } }]
    });

    const followUpResponse = await ai.models.generateContent({
      model:    'gemini-2.5-flash',
      contents: conversationContents,
      config:   { tools },
    });

    if (followUpResponse.usageMetadata) {
      await AITokenService.addTokens(userId, followUpResponse.usageMetadata.promptTokenCount, followUpResponse.usageMetadata.candidatesTokenCount);
    }

    replyText = followUpResponse.text;
    if (!replyText && followUpResponse.functionCalls) {
      replyText = 'I have started the operation, please hold on.';
    } else if (!replyText) {
      replyText = 'Action completed successfully.';
    }
  }

  // Final safety check
  if (!replyText) {
      replyText = 'Action generated. Let me know if you need anything else.';
  }

  return { reply: replyText };
}

module.exports = { chat };