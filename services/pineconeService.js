/**
 * Pinecone Service — v2
 *
 * KEY CHANGE from v1: Uses per-user namespaces (user_{userId}) instead of
 * a flat index with user_id metadata filter. This enables:
 *   - Parallel group search across multiple users' namespaces
 *   - Clean data isolation per user
 *   - Efficient group-scoped queries without full-index scan
 *
 * Embedding model: gemini-2.0-flash-lite for cost (not Pro)
 */

const { Pinecone } = require('@pinecone-database/pinecone');
const { GoogleGenAI } = require('@google/genai');
const db = require('../db');
const logger = require('../logger');

class PineconeService {
  constructor() {
    this.pc     = null;
    this.index  = null;
    this.genAI  = null;
    this._init();
  }

  _init() {
    try {
      if (process.env.PINECONE_API_KEY) {
        this.pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
        this.index = this.pc.index(process.env.PINECONE_INDEX || 'nexo-contacts');
      }
      if (process.env.GEMINI_API_KEY) {
        this.genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      }
    } catch (err) {
      logger.error('[Pinecone] Init error:', err.message);
    }
  }

  namespaceFor(userId) {
    return `user_${userId}`;
  }

  /**
   * Build rich text for embedding. Includes enriched fields + message summaries.
   */
  buildContactText(contact) {
    const parts = [
      contact.full_name,
      contact.job_title   ? `Title: ${contact.job_title}` : '',
      contact.company     ? `Company: ${contact.company}` : '',
      contact.bio         ? `Bio: ${contact.bio}` : '',
      contact.address     ? `Location: ${contact.address}` : '',
      // Enriched fields
      contact.skills?.length
        ? `Skills: ${Array.isArray(contact.skills) ? contact.skills.join(', ') : contact.skills}`
        : '',
      contact.experience?.length
        ? `Experience: ${(Array.isArray(contact.experience) ? contact.experience : JSON.parse(contact.experience || '[]'))
            .slice(0, 3).map(e => `${e.title} at ${e.company}`).join(', ')}`
        : '',
      contact.education?.length
        ? `Education: ${(Array.isArray(contact.education) ? contact.education : JSON.parse(contact.education || '[]'))
            .slice(0, 2).map(e => `${e.degree || ''} ${e.school || ''}`).join(', ')}`
        : '',
      // Conversation summaries (private — in owner's namespace only)
      contact.messagesSummary ? `Conversation context: ${contact.messagesSummary}` : '',
      contact.topics?.length  ? `Topics discussed: ${contact.topics.join(', ')}` : '',
      // Notes
      contact.notes ? `Notes: ${contact.notes}` : '',
    ].filter(Boolean);

    return parts.join('. ').trim() || `Contact: ${contact.full_name}`;
  }

  async getEmbedding(text, retries = 3) {
    if (!this.genAI) throw new Error('GEMINI_API_KEY not configured');

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await this.genAI.models.embedContent({
          model:    'gemini-embedding-001',
          contents: text,
        });
        return response.embeddings[0].values;
      } catch (err) {
        if (attempt === retries) throw err;
        logger.warn(`[Pinecone] Embed attempt ${attempt} failed, retrying...`);
        await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }
  }

  /**
   * Upsert a single contact into its owner's namespace.
   */
  async upsertContact(userId, contact) {
    if (!this.index) throw new Error('Pinecone not configured');

    const namespace = this.namespaceFor(userId);
    const text      = this.buildContactText(contact);
    const embedding = await this.getEmbedding(text);

    await this.index.namespace(namespace).upsert([{
      id:       contact.id.toString(),
      values:   embedding,
      metadata: {
        user_id:    userId,
        full_name:  contact.full_name || '',
        company:    contact.company || '',
        job_title:  contact.job_title || '',
        is_private: contact.is_private || false,
        confidence: contact.confidence_score || 0,
        tier:       contact.connection_tier || 'social',
      },
    }]);

    return true;
  }

  /**
   * Batch upsert for a user's contacts.
   */
  async upsertContacts(userId, contacts) {
    let total = 0;
    for (const contact of contacts) {
      try {
        await this.upsertContact(userId, contact);
        total++;
        await new Promise(r => setTimeout(r, 100)); // throttle
      } catch (err) {
        logger.error(`[Pinecone] Failed to upsert contact ${contact.id}: ${err.message}`);
      }
    }
    return total;
  }

  /**
   * Personal search — only the user's own namespace.
   */
  async searchPersonal(userId, queryText, topK = 20) {
    if (!this.index) throw new Error('Pinecone not configured');
    const embedding = await this.getEmbedding(queryText);
    const namespace = this.namespaceFor(userId);

    const results = await this.index.namespace(namespace).query({
      vector:          embedding,
      topK,
      includeMetadata: true,
    });

    return results.matches.map(m => ({
      contactId: m.id,
      score:     m.score,
      metadata:  m.metadata,
    }));
  }

  /**
   * Group search — queries multiple user namespaces in parallel.
   * Returns merged, deduplicated results ranked by score.
   * Private contacts (is_private=true in metadata) are excluded.
   */
  async searchGroup(memberUserIds, queryText, topK = 20) {
    if (!this.index) throw new Error('Pinecone not configured');
    if (!memberUserIds.length) return [];

    const embedding = await this.getEmbedding(queryText);

    // Parallel queries across all member namespaces
    const perUserResults = await Promise.allSettled(
      memberUserIds.map(uid =>
        this.index.namespace(this.namespaceFor(uid)).query({
          vector:          embedding,
          topK:            10,
          includeMetadata: true,
        }).then(r => r.matches.map(m => ({
          contactId: m.id,
          ownerId:   uid,
          score:     m.score,
          metadata:  m.metadata,
        })))
      )
    );

    // Flatten successful results, skip private contacts
    const allMatches = perUserResults
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(m => !m.metadata?.is_private);

    // Deduplicate by contactId, keep highest score
    const seen = new Map();
    for (const m of allMatches) {
      if (!seen.has(m.contactId) || seen.get(m.contactId).score < m.score) {
        seen.set(m.contactId, m);
      }
    }

    return Array.from(seen.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Delete all vectors for a contact from its owner's namespace.
   */
  async deleteContact(userId, contactId) {
    if (!this.index) return;
    try {
      await this.index.namespace(this.namespaceFor(userId)).deleteOne(contactId.toString());
    } catch (err) {
      logger.warn(`[Pinecone] Delete failed for ${contactId}: ${err.message}`);
    }
  }

  /**
   * Delete all vectors for a user (on account deletion).
   */
  async deleteUserNamespace(userId) {
    if (!this.index) return;
    try {
      await this.index.namespace(this.namespaceFor(userId)).deleteAll();
    } catch (err) {
      logger.warn(`[Pinecone] Namespace delete failed for user ${userId}: ${err.message}`);
    }
  }
}

module.exports = new PineconeService();
