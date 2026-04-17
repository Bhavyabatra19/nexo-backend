const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const ContactModel = require('../models/Contact');
const db = require('../db');

function tokenizeCriteriaValue(value) {
  return String(value || '')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean);
}

/**
 * Contacts Routes
 * All routes require authentication
 */

/**
 * GET /api/contacts
 * Get all contacts with pagination and sorting
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const {
      limit = 100,
      offset = 0,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      filter,
      q,
      source,
      list,
      listId,
      createdAfter,
      createdBefore,
      contactedAfter,
      contactedBefore,
      tags
    } = req.query;

    let filterValue = filter;
    let sourceValue = source;
    let qValue = q;
    let criteriaQueryStr = null;
    const effectiveListId = listId || list;
    let createdAfterVal = createdAfter;
    let createdBeforeVal = createdBefore;
    let contactedAfterVal = contactedAfter;
    let contactedBeforeVal = contactedBefore;
    let tagsVal = tags;

    let baseCond = 'c.user_id = $1';
    let queryParams = [req.userId];
    let paramIndex = 2;

    let joinTables = '';
    
    let isDynamicList = false;
    if (effectiveListId) {
      // Fetch list to check if it has criteria (dynamic list) or is purely manual
      const listInfo = await db.query('SELECT criteria FROM lists WHERE id = $1 AND user_id = $2', [effectiveListId, req.userId]);
      if (listInfo.rows.length > 0) {
        const criteria = listInfo.rows[0].criteria;
        if (criteria && Object.keys(criteria).length > 0) {
          isDynamicList = true;
          if (!sourceValue && criteria.source) sourceValue = criteria.source;
          if (!filterValue && criteria.filter) filterValue = criteria.filter;
          if (criteria.query) criteriaQueryStr = criteria.query;
          if (!createdAfterVal && criteria.createdAfter) createdAfterVal = criteria.createdAfter;
          if (!createdBeforeVal && criteria.createdBefore) createdBeforeVal = criteria.createdBefore;
          if (!contactedAfterVal && criteria.contactedAfter) contactedAfterVal = criteria.contactedAfter;
          if (!contactedBeforeVal && criteria.contactedBefore) contactedBeforeVal = criteria.contactedBefore;
          if (!tagsVal && criteria.tags) tagsVal = criteria.tags;
          // Also include contacts manually added to this dynamic list
          joinTables = 'LEFT JOIN contact_lists cl ON c.id = cl.contact_id AND cl.list_id = $' + paramIndex;
          queryParams.push(effectiveListId);
          paramIndex++;
        } else {
          // Manual list - filter via join
          joinTables = 'INNER JOIN contact_lists cl ON c.id = cl.contact_id';
          baseCond += ` AND cl.list_id = $${paramIndex}`;
          queryParams.push(effectiveListId);
          paramIndex++;
        }
      }
    }

    // Apply base dashboard filters
    if (filterValue === 'stale') {
      const days = parseInt(req.query.days) || 30;
      baseCond += ` AND c.last_contacted IS NOT NULL AND c.last_contacted < CURRENT_TIMESTAMP - INTERVAL '${days} days'`;
    } else if (filterValue === 'favorites') {
      baseCond += ` AND c.is_favorite = true`;
    } else if (filterValue === 'no-calendar') {
      baseCond += ` AND c.last_contacted IS NULL`;
    }

    // Apply source filter
    if (sourceValue === 'google') {
      baseCond += ` AND c.google_contact_id IS NOT NULL`;
    } else if (sourceValue === 'linkedin') {
      baseCond += ` AND c.linkedin_url IS NOT NULL`;
    } else if (sourceValue === 'manual') {
      baseCond += ` AND c.google_contact_id IS NULL AND c.linkedin_url IS NULL`;
    }

    // Apply standard search query handling
    if (qValue) {
      // Join notes table for search if not already joined
      if (!joinTables.includes('notes')) {
        joinTables += ' LEFT JOIN notes n_search ON c.id = n_search.contact_id AND n_search.user_id = $1';
      }
      baseCond += ` AND (c.full_name ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR c.company ILIKE $${paramIndex} OR c.notes ILIKE $${paramIndex} OR n_search.content ILIKE $${paramIndex})`;
      queryParams.push(`%${qValue}%`);
      paramIndex++;
    }

    // Apply create date and contact date filters
    if (createdAfterVal) {
      baseCond += ` AND c.contact_created_date IS NOT NULL AND c.contact_created_date::date >= $${paramIndex}`;
      queryParams.push(createdAfterVal);
      paramIndex++;
    }
    if (createdBeforeVal) {
      baseCond += ` AND c.contact_created_date IS NOT NULL AND c.contact_created_date::date <= $${paramIndex}`;
      queryParams.push(createdBeforeVal);
      paramIndex++;
    }
    if (contactedAfterVal) {
      baseCond += ` AND c.last_contacted IS NOT NULL AND c.last_contacted::date >= $${paramIndex}`;
      queryParams.push(contactedAfterVal);
      paramIndex++;
    }
    if (contactedBeforeVal) {
      baseCond += ` AND c.last_contacted IS NOT NULL AND c.last_contacted::date <= $${paramIndex}`;
      queryParams.push(contactedBeforeVal);
      paramIndex++;
    }

    // Apply Tags
    if (tagsVal) {
      const tagIds = typeof tagsVal === 'string' ? tagsVal.split(',') : tagsVal;
      // Filter contacts that have at least one of these exact tags
      baseCond += ` AND EXISTS (
        SELECT 1 FROM contact_tags ct2 
        WHERE ct2.contact_id = c.id AND ct2.tag_id = ANY($${paramIndex}::uuid[])
      )`;
      queryParams.push(tagIds);
      paramIndex++;
    }

    // Apply parsed dynamic list criteria query
    if (criteriaQueryStr) {
      let separator = ' AND ';
      let parts = [criteriaQueryStr];
      if (criteriaQueryStr.includes('(and)')) { separator = ' AND '; parts = criteriaQueryStr.split('(and)'); }
      else if (criteriaQueryStr.includes('(or)')) { separator = ' OR '; parts = criteriaQueryStr.split('(or)'); }
      else if (criteriaQueryStr.includes('&')) { separator = ' AND '; parts = criteriaQueryStr.split('&'); }
      
      let criteriaConds = [];
      for (const part of parts) {
        const [key, ...valueParts] = part.split(':');
        const value = valueParts.join(':');
        if (key && value) {
          let dbCol = '';
          const trimmedKey = key.trim().toLowerCase();
          if (trimmedKey === 'title') dbCol = 'c.job_title';
          else if (trimmedKey === 'company') dbCol = 'c.company';
          else if (trimmedKey === 'name') dbCol = 'c.full_name';
          
          if (dbCol) {
            criteriaConds.push(`${dbCol} ILIKE $${paramIndex}`);
            queryParams.push(`%${value.trim()}%`);
            paramIndex++;
          } else if (trimmedKey === 'any') {
            const tokens = tokenizeCriteriaValue(value);
            if (tokens.length > 0) {
              const anyTokenConds = [];
              for (const token of tokens) {
                anyTokenConds.push(`(
                  c.job_title ILIKE $${paramIndex}
                  OR c.company ILIKE $${paramIndex}
                  OR c.full_name ILIKE $${paramIndex}
                  OR c.email ILIKE $${paramIndex}
                  OR c.bio ILIKE $${paramIndex}
                  OR c.notes ILIKE $${paramIndex}
                  OR EXISTS (
                    SELECT 1 FROM notes n_any
                    WHERE n_any.contact_id = c.id AND n_any.user_id = $1 AND n_any.content ILIKE $${paramIndex}
                  )
                  OR EXISTS (
                    SELECT 1 FROM contact_tags ct_any
                    JOIN tags t_any ON t_any.id = ct_any.tag_id
                    WHERE ct_any.contact_id = c.id AND t_any.name ILIKE $${paramIndex}
                  )
                )`);
                queryParams.push(`%${token}%`);
                paramIndex++;
              }
              criteriaConds.push(`(${anyTokenConds.join(' OR ')})`);
            }
          }
        }
      }
      if (criteriaConds.length > 0) {
        // For dynamic lists, also include contacts manually added to the list
        const criteriaBlock = `(${criteriaConds.join(separator)})`;
        baseCond += isDynamicList
          ? ` AND (${criteriaBlock} OR cl.list_id IS NOT NULL)`
          : ` AND ${criteriaBlock}`;
      }
    }

    // Map frontend sort keys to database columns securely
    const sortColumnMap = {
      name: 'full_name',
      company: 'company',
      title: 'job_title',
      lastContacted: 'last_contacted',
      created_at: 'created_at'
    };
    const sortColumn = sortColumnMap[sortBy] || 'created_at';
    const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Single query: fetch contacts + total count via window function (saves one round-trip)
    const query = `
      SELECT DISTINCT c.*, COUNT(*) OVER() AS _total_count FROM contacts c
      ${joinTables}
      WHERE ${baseCond}
      ORDER BY c.${sortColumn} ${safeSortOrder} NULLS LAST
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    const result = await db.query(query, [...queryParams, parseInt(limit), parseInt(offset)]);
    const contacts = result.rows;
    const totalCount = contacts.length > 0 ? parseInt(contacts[0]._total_count) : 0;
    // Remove the window column from each row
    contacts.forEach(c => delete c._total_count);

    if (contacts.length > 0) {
      const contactIds = contacts.map(c => c.id);
      const tagsResult = await db.query(`
        SELECT ct.contact_id, t.id, t.name, t.color, t.text_color
        FROM contact_tags ct
        JOIN tags t ON ct.tag_id = t.id
        WHERE ct.contact_id = ANY($1)
      `, [contactIds]);

      const tagsByContact = {};
      tagsResult.rows.forEach(row => {
        if (!tagsByContact[row.contact_id]) tagsByContact[row.contact_id] = [];
        tagsByContact[row.contact_id].push({ id: row.id, name: row.name, color: row.color, text_color: row.text_color });
      });
      
      contacts.forEach(c => {
        c.tags = tagsByContact[c.id] || [];
      });
    }

    res.json({
      success: true,
      contacts,
      pagination: {
        total: totalCount,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + contacts.length < totalCount
      }
    });

  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/contacts
 * Create a new manual contact
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const contactData = req.body;
    
    if (!contactData.name) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }

    const newContact = await ContactModel.create(req.userId, contactData);

    // Log Activity
    const ActivityModel = require('../models/Activity');
    await ActivityModel.create(
      newContact.id, 
      req.userId, 
      'contact_created', 
      'Created contact manually'
    );

    res.json({
      success: true,
      contact: newContact
    });

  } catch (error) {
    console.error('Error creating contact:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


/**
 * GET /api/contacts/stats
 * Get contact statistics
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const stats = await ContactModel.getStats(req.userId);

    res.json({
      success: true,
      statistics: {
        total: parseInt(stats.total),
        withCalendarData: parseInt(stats.with_calendar_data),
        withEmail: parseInt(stats.with_email),
        withPhone: parseInt(stats.with_phone),
        withCompany: parseInt(stats.with_company),
        favorites: parseInt(stats.favorites),
        avgMeetings: parseFloat(stats.avg_meetings || 0).toFixed(2)
      }
    });

  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/contacts/:id
 * Get single contact by ID
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const contact = await ContactModel.getById(req.params.id, req.userId);

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    // Fetch tags and lists in parallel (2 queries concurrently instead of sequentially)
    const [tagsResult, listsResult] = await Promise.all([
      db.query(`SELECT t.* FROM tags t INNER JOIN contact_tags ct ON t.id = ct.tag_id WHERE ct.contact_id = $1`, [contact.id]),
      db.query(`SELECT l.* FROM lists l INNER JOIN contact_lists cl ON l.id = cl.list_id WHERE cl.contact_id = $1`, [contact.id]),
    ]);

    res.json({
      success: true,
      contact: {
        ...contact,
        tags: tagsResult.rows,
        lists: listsResult.rows
      }
    });

  } catch (error) {
    console.error('Error fetching contact:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PATCH /api/contacts/:id/notes
 * Update contact notes
 */
router.patch('/:id/notes', authenticateToken, async (req, res) => {
  try {
    const { notes } = req.body;

    const contact = await ContactModel.updateNotes(
      req.params.id,
      req.userId,
      notes
    );

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    // Log Activity
    const ActivityModel = require('../models/Activity');
    await ActivityModel.create(req.params.id, req.userId, 'contact_updated', 'Updated contact notes');

    res.json({
      success: true,
      contact
    });

  } catch (error) {
    console.error('Error updating notes:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PATCH /api/contacts/:id
 * Update contact details
 */
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    const { name, email, phone, company, title, linkedinUrl, instagramUrl, bio, address, phones, emails, customLinks } = req.body;
    
    // Convert to DB column names if provided, otherwise preserve existing
    const updates = [];
    const values = [];
    let paramIdx = 1;

    if (name !== undefined) { updates.push(`full_name = $${paramIdx++}`); values.push(name); }
    if (email !== undefined) { updates.push(`email = $${paramIdx++}`); values.push(email); }
    if (phone !== undefined) { updates.push(`phone = $${paramIdx++}`); values.push(phone); }
    if (company !== undefined) { updates.push(`company = $${paramIdx++}`); values.push(company); }
    if (title !== undefined) { updates.push(`job_title = $${paramIdx++}`); values.push(title); }
    if (linkedinUrl !== undefined) { updates.push(`linkedin_url = $${paramIdx++}`); values.push(linkedinUrl); }
    if (bio !== undefined) { updates.push(`bio = $${paramIdx++}`); values.push(bio); }
    if (address !== undefined) { updates.push(`address = $${paramIdx++}`); values.push(address); }
    if (instagramUrl !== undefined) { updates.push(`instagram_url = $${paramIdx++}`); values.push(instagramUrl); }
    if (phones !== undefined) { updates.push(`phones = $${paramIdx++}`); values.push(JSON.stringify(phones)); }
    if (emails !== undefined) { updates.push(`emails = $${paramIdx++}`); values.push(JSON.stringify(emails)); }
    if (customLinks !== undefined) { updates.push(`custom_links = $${paramIdx++}`); values.push(JSON.stringify(customLinks)); }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    // Force regeneration of AI summary on next view when details change
    updates.push(`ai_summary = NULL`);

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(req.params.id);
    values.push(req.userId);

    const query = `
      UPDATE contacts 
      SET ${updates.join(', ')} 
      WHERE id = $${paramIdx} AND user_id = $${paramIdx + 1}
      RETURNING *
    `;

    const result = await db.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }

    // Log activity
    const ActivityModel = require('../models/Activity');
    await ActivityModel.create(req.params.id, req.userId, 'contact_updated', 'Updated contact details manually');

    res.json({ success: true, contact: result.rows[0] });
  } catch (error) {
    console.error('Error updating contact:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/contacts/:id/important-dates
 * Get important dates for a contact
 */
router.get('/:id/important-dates', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT important_dates FROM contacts WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }
    res.json({ success: true, importantDates: result.rows[0].important_dates || [] });
  } catch (error) {
    console.error('Error fetching important dates:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/contacts/:id/important-dates
 * Update important dates for a contact
 * Body: { importantDates: [{ label: "Birthday", date: "1995-06-15" }, ...] }
 */
router.put('/:id/important-dates', authenticateToken, async (req, res) => {
  try {
    const { importantDates } = req.body;
    if (!Array.isArray(importantDates)) {
      return res.status(400).json({ success: false, error: 'importantDates must be an array' });
    }
    const result = await db.query(
      'UPDATE contacts SET important_dates = $1 WHERE id = $2 AND user_id = $3 RETURNING id, important_dates',
      [JSON.stringify(importantDates), req.params.id, req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }
    
    // Log Activity
    const ActivityModel = require('../models/Activity');
    await ActivityModel.create(req.params.id, req.userId, 'contact_updated', 'Updated important dates');

    res.json({ success: true, importantDates: result.rows[0].important_dates });
  } catch (error) {
    console.error('Error updating important dates:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/contacts/:id/favorite
 * Toggle favorite status
 */
router.post('/:id/favorite', authenticateToken, async (req, res) => {
  try {
    const contact = await ContactModel.toggleFavorite(req.params.id, req.userId);

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }
    
    // Log activity
    const ActivityModel = require('../models/Activity');
    await ActivityModel.create(req.params.id, req.userId, 'contact_updated', contact.is_favorite ? 'Marked contact as favorite' : 'Removed contact from favorites');

    res.json({
      success: true,
      contact,
      isFavorite: contact.is_favorite
    });

  } catch (error) {
    console.error('Error toggling favorite:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/contacts/bulk/tags
 * Add a tag to multiple contacts
 */
router.post('/bulk/tags', authenticateToken, async (req, res) => {
  try {
    const { contactIds, tagId } = req.body;

    if (!contactIds || !Array.isArray(contactIds) || !tagId) {
      return res.status(400).json({ success: false, error: 'contactIds array and tagId are required' });
    }

    const tagResult = await db.query('SELECT * FROM tags WHERE id = $1 AND user_id = $2', [tagId, req.userId]);
    if (tagResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Tag not found' });
    }

    // Batch insert all tag associations in a single query
    const values = contactIds.map((_, i) => `($${i + 1}, $${contactIds.length + 1})`).join(',');
    const params = [...contactIds, tagId];
    await db.query(`INSERT INTO contact_tags (contact_id, tag_id) VALUES ${values} ON CONFLICT DO NOTHING`, params);

    // Batch log activities
    const ActivityModel = require('../models/Activity');
    await Promise.all(contactIds.map(cid =>
      ActivityModel.create(cid, req.userId, 'tag_changed', `Added tag: ${tagResult.rows[0].name}`)
    ));

    res.json({ success: true, message: 'Tag added to contacts' });
  } catch (error) {
    console.error('Error adding tag to contacts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/contacts/bulk/tags
 * Remove a tag from multiple contacts
 */
router.delete('/bulk/tags', authenticateToken, async (req, res) => {
  try {
    const { contactIds, tagId } = req.body;

    if (!contactIds || !Array.isArray(contactIds) || !tagId) {
      return res.status(400).json({ success: false, error: 'contactIds array and tagId are required' });
    }

    const tagResult = await db.query('SELECT * FROM tags WHERE id = $1 AND user_id = $2', [tagId, req.userId]);
    
    if (tagResult.rows.length > 0) {
      // Batch delete all tag associations in a single query
      await db.query('DELETE FROM contact_tags WHERE contact_id = ANY($1) AND tag_id = $2', [contactIds, tagId]);

      // Batch log activities
      const ActivityModel = require('../models/Activity');
      await Promise.all(contactIds.map(cid =>
        ActivityModel.create(cid, req.userId, 'tag_changed', `Removed tag: ${tagResult.rows[0].name}`)
      ));
    }

    res.json({ success: true, message: 'Tag removed from contacts' });
  } catch (error) {
    console.error('Error removing tag from contacts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/contacts/:id/tags
 * Add tag to contact
 */
router.post('/:id/tags', authenticateToken, async (req, res) => {
  try {
    const { tagId } = req.body;

    if (!tagId) {
      return res.status(400).json({
        success: false,
        error: 'tagId is required'
      });
    }

    // Verify contact belongs to user
    const contact = await ContactModel.getById(req.params.id, req.userId);
    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    // Verify tag belongs to user
    const tagResult = await db.query(
      'SELECT * FROM tags WHERE id = $1 AND user_id = $2',
      [tagId, req.userId]
    );

    if (tagResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Tag not found'
      });
    }

    // Add tag to contact
    await db.query(
      'INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, tagId]
    );
    
    // Log Activity
    const ActivityModel = require('../models/Activity');
    await ActivityModel.create(
      req.params.id, 
      req.userId, 
      'tag_changed', 
      `Added tag: ${tagResult.rows[0].name}`
    );

    // Force regeneration of AI summary
    await db.query(`UPDATE contacts SET ai_summary = NULL WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);

    res.json({
      success: true,
      message: 'Tag added to contact'
    });

  } catch (error) {
    console.error('Error adding tag:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/contacts/:id/tags/:tagId
 * Remove tag from contact
 */
router.delete('/:id/tags/:tagId', authenticateToken, async (req, res) => {
  try {
    // Get tag name before removing
    const tagResult = await db.query(
      'SELECT * FROM tags WHERE id = $1 AND user_id = $2',
      [req.params.tagId, req.userId]
    );

    await db.query(
      'DELETE FROM contact_tags WHERE contact_id = $1 AND tag_id = $2',
      [req.params.id, req.params.tagId]
    );
    
    // Log Activity
    if (tagResult.rows.length > 0) {
      const ActivityModel = require('../models/Activity');
      await ActivityModel.create(
        req.params.id, 
        req.userId, 
        'tag_changed', 
        `Removed tag: ${tagResult.rows[0].name}`
      );
    }

    // Force regeneration of AI summary
    await db.query(`UPDATE contacts SET ai_summary = NULL WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);

    res.json({
      success: true,
      message: 'Tag removed from contact'
    });

  } catch (error) {
    console.error('Error removing tag:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/contacts/:id
 * Delete contact
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    await ContactModel.delete(req.params.id, req.userId);

    // Remove from Pinecone (AI brain) — fire and forget
    try {
      const pineconeService = require('../services/pineconeService');
      await pineconeService.deleteUserVectors([req.params.id]);
    } catch (pineconeErr) {
      console.error('[Contacts] Pinecone cleanup failed:', pineconeErr.message);
    }

    res.json({
      success: true,
      message: 'Contact deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting contact:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
