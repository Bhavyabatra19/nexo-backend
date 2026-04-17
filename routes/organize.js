const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const db = require('../db');

/**
 * Tags and Lists Routes
 * For organizing contacts
 */

// ============= TAGS =============

/**
 * GET /api/organize/tags
 * Get all tags for user
 */
router.get('/tags', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM tags WHERE user_id = $1 ORDER BY name ASC',
      [req.userId]
    );

    res.json({
      success: true,
      tags: result.rows
    });

  } catch (error) {
    console.error('Error fetching tags:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/organize/tags
 * Create a new tag
 */
router.post('/tags', authenticateToken, async (req, res) => {
  try {
    const { name, color = '#3B82F6', textColor = '#FFFFFF' } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Tag name is required'
      });
    }

    const result = await db.query(`
      INSERT INTO tags (user_id, name, color, text_color)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [req.userId, name, color, textColor]);

    res.json({
      success: true,
      tag: result.rows[0]
    });

  } catch (error) {
    if (error.code === '23505') { // Unique constraint violation
      return res.status(400).json({
        success: false,
        error: 'Tag with this name already exists'
      });
    }

    console.error('Error creating tag:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PATCH /api/organize/tags/:id
 * Update tag
 */
router.patch('/tags/:id', authenticateToken, async (req, res) => {
  try {
    const { name, color, textColor } = req.body;
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }

    if (color) {
      updates.push(`color = $${paramCount++}`);
      values.push(color);
    }

    if (textColor) {
      updates.push(`text_color = $${paramCount++}`);
      values.push(textColor);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No updates provided'
      });
    }

    values.push(req.params.id, req.userId);

    const result = await db.query(`
      UPDATE tags 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount++} AND user_id = $${paramCount}
      RETURNING *
    `, values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Tag not found'
      });
    }

    res.json({
      success: true,
      tag: result.rows[0]
    });

  } catch (error) {
    console.error('Error updating tag:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/organize/tags/:id
 * Delete tag
 */
router.delete('/tags/:id', authenticateToken, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM tags WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );

    res.json({
      success: true,
      message: 'Tag deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting tag:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/organize/tags/:id/contacts
 * Get all contacts with a specific tag
 */
router.get('/tags/:id/contacts', authenticateToken, async (req, res) => {
  try {
    const ContactModel = require('../models/Contact');
    const contacts = await ContactModel.getByTag(req.userId, req.params.id);

    res.json({
      success: true,
      contacts
    });

  } catch (error) {
    console.error('Error fetching contacts by tag:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============= LISTS =============

/**
 * GET /api/organize/lists
 * Get all lists for user
 */
router.get('/lists', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT l.*, COUNT(cl.contact_id) as contact_count
      FROM lists l
      LEFT JOIN contact_lists cl ON l.id = cl.list_id
      WHERE l.user_id = $1
      GROUP BY l.id
      ORDER BY l.name ASC
    `, [req.userId]);

    res.json({
      success: true,
      lists: result.rows
    });

  } catch (error) {
    console.error('Error fetching lists:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/organize/lists
 * Create a new list
 */
router.post('/lists', authenticateToken, async (req, res) => {
  try {
    const { name, description, criteria } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'List name is required'
      });
    }

    const result = await db.query(`
      INSERT INTO lists (user_id, name, description, criteria)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [req.userId, name, description || null, criteria ? JSON.stringify(criteria) : null]);

    res.json({
      success: true,
      list: result.rows[0]
    });

  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({
        success: false,
        error: 'List with this name already exists'
      });
    }

    console.error('Error creating list:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PATCH /api/organize/lists/:id
 * Update list
 */
router.patch('/lists/:id', authenticateToken, async (req, res) => {
  try {
    const { name, description, criteria } = req.body;
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }

    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }

    if (criteria !== undefined) {
      updates.push(`criteria = $${paramCount++}`);
      values.push(criteria ? JSON.stringify(criteria) : null);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No updates provided'
      });
    }

    values.push(req.params.id, req.userId);

    const result = await db.query(`
      UPDATE lists 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount++} AND user_id = $${paramCount}
      RETURNING *
    `, values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'List not found'
      });
    }

    res.json({
      success: true,
      list: result.rows[0]
    });

  } catch (error) {
    console.error('Error updating list:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/organize/lists/:id
 * Get single list by ID
 */
router.get('/lists/:id', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM lists WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'List not found'
      });
    }

    res.json({
      success: true,
      list: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching list:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/organize/lists/:id
 * Delete list
 */
router.delete('/lists/:id', authenticateToken, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM lists WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );

    res.json({
      success: true,
      message: 'List deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting list:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/organize/lists/:id/contacts
 * Get all contacts in a specific list
 */
router.get('/lists/:id/contacts', authenticateToken, async (req, res) => {
  try {
    const ContactModel = require('../models/Contact');
    const contacts = await ContactModel.getByList(req.userId, req.params.id);

    res.json({
      success: true,
      contacts
    });

  } catch (error) {
    console.error('Error fetching contacts by list:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/organize/lists/:id/contacts
 * Add contact to list
 */
router.post('/lists/:id/contacts', authenticateToken, async (req, res) => {
  try {
    const { contactId } = req.body;

    if (!contactId) {
      return res.status(400).json({
        success: false,
        error: 'contactId is required'
      });
    }

    // Verify list belongs to user
    const listResult = await db.query(
      'SELECT * FROM lists WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );

    if (listResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'List not found'
      });
    }

    // Verify contact belongs to user
    const ContactModel = require('../models/Contact');
    const contact = await ContactModel.getById(contactId, req.userId);

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    // Add contact to list
    await db.query(
      'INSERT INTO contact_lists (contact_id, list_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [contactId, req.params.id]
    );

    res.json({
      success: true,
      message: 'Contact added to list'
    });

  } catch (error) {
    console.error('Error adding contact to list:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/organize/lists/:id/contacts/bulk
 * Add multiple contacts to list
 */
router.post('/lists/:id/contacts/bulk', authenticateToken, async (req, res) => {
  try {
    const { contactIds } = req.body;

    if (!contactIds || !Array.isArray(contactIds)) {
      return res.status(400).json({
        success: false,
        error: 'contactIds array is required'
      });
    }

    // Verify list belongs to user
    const listResult = await db.query(
      'SELECT * FROM lists WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );

    if (listResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'List not found'
      });
    }

    const promises = contactIds.map(cid => {
      return db.query(
        'INSERT INTO contact_lists (contact_id, list_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [cid, req.params.id]
      );
    });
    await Promise.all(promises);

    res.json({
      success: true,
      message: 'Contacts added to list'
    });

  } catch (error) {
    console.error('Error adding contacts to list:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/organize/lists/:id/contacts/:contactId
 * Remove contact from list
 */
router.delete('/lists/:id/contacts/:contactId', authenticateToken, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM contact_lists WHERE list_id = $1 AND contact_id = $2',
      [req.params.id, req.params.contactId]
    );

    res.json({
      success: true,
      message: 'Contact removed from list'
    });

  } catch (error) {
    console.error('Error removing contact from list:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
