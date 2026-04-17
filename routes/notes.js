const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const NoteModel = require('../models/Note');

// All routes are protected
router.use(authenticateToken);

// Get all notes for a specific contact
router.get('/:contactId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const { notes, total } = await NoteModel.getByContactId(req.params.contactId, req.userId, limit, offset);
    
    res.json({ 
      success: true, 
      notes,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + notes.length < total
      }
    });
  } catch (error) {
    console.error('Error fetching notes:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create a new note for a contact
router.post('/:contactId', async (req, res) => {
  try {
    const { content, title } = req.body;
    if (!content) {
      return res.status(400).json({ success: false, error: 'Content is required' });
    }
    const note = await NoteModel.create(req.params.contactId, req.userId, content, title);
    
    // Log Activity
    const ActivityModel = require('../models/Activity');
    const activityDesc = title 
      ? `Added note: ${title}` 
      : `Added note: ${content.length > 50 ? content.substring(0, 50) + '...' : content}`;
    await ActivityModel.create(
      req.params.contactId, 
      req.userId, 
      'note_added', 
      activityDesc
    );

    // Force regeneration of AI summary
    const db = require('../db');
    await db.query(`UPDATE contacts SET ai_summary = NULL WHERE id = $1 AND user_id = $2`, [req.params.contactId, req.userId]);

    res.status(201).json({ success: true, note });
  } catch (error) {
    console.error('Error creating note:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update an existing note
router.put('/:noteId', async (req, res) => {
  try {
    const { content, title } = req.body;
    if (!content) {
      return res.status(400).json({ success: false, error: 'Content is required' });
    }
    const note = await NoteModel.update(req.params.noteId, req.userId, content, title);
    if (!note) {
      return res.status(404).json({ success: false, error: 'Note not found' });
    }
    const db = require('../db');
    const noteRow = await db.query('SELECT contact_id FROM notes WHERE id = $1', [req.params.noteId]);
    if (noteRow.rows.length > 0) {
      const contactId = noteRow.rows[0].contact_id;
      
      // Force regeneration of AI summary
      await db.query(`UPDATE contacts SET ai_summary = NULL WHERE id = $1 AND user_id = $2`, [contactId, req.userId]);

      // Log Activity
      const ActivityModel = require('../models/Activity');
      const activityDesc = title 
        ? `Updated note: ${title}` 
        : `Updated note: ${content.length > 50 ? content.substring(0, 50) + '...' : content}`;
      await ActivityModel.create(
        contactId, 
        req.userId, 
        'note_updated', 
        activityDesc
      );
    }

    res.json({ success: true, note });
  } catch (error) {
    console.error('Error updating note:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete a note
router.delete('/:noteId', async (req, res) => {
  try {
    // Get note details before deleting (for activity log)
    const db = require('../db');
    const noteRow = await db.query('SELECT contact_id, title, content FROM notes WHERE id = $1 AND user_id = $2', [req.params.noteId, req.userId]);
    
    await NoteModel.delete(req.params.noteId, req.userId);

    // Clean up related note activities so deleted notes do not remain in timeline
    if (noteRow.rows.length > 0) {
      const noteTitle = noteRow.rows[0].title || noteRow.rows[0].content?.substring(0, 50);

      // Intentionally not creating a "note_deleted" activity entry.
      // Keeping deleted-note events out of timeline avoids showing removed content history.
      // const ActivityModel = require('../models/Activity');
      // await ActivityModel.create(
      //   noteRow.rows[0].contact_id,
      //   req.userId,
      //   'note_deleted',
      //   `Deleted note: ${noteTitle}`
      // );

      // Remove the original "note_added" activity for this note
      await db.query(
        `DELETE FROM activities 
         WHERE contact_id = $1 AND user_id = $2 AND type IN ('note_added', 'note_updated')
         AND (description LIKE $3 OR description LIKE $4)`,
        [noteRow.rows[0].contact_id, req.userId, `Added note: ${noteTitle}%`, `Updated note: ${noteTitle}%`]
      );

      // Force regeneration of AI summary
      await db.query(`UPDATE contacts SET ai_summary = NULL WHERE id = $1 AND user_id = $2`, [noteRow.rows[0].contact_id, req.userId]);
    }

    res.json({ success: true, message: 'Note deleted successfully' });
  } catch (error) {
    console.error('Error deleting note:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
