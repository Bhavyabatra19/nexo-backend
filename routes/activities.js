const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const ActivityModel = require('../models/Activity');

// All routes are protected
router.use(authenticateToken);

// Get all activities for a specific contact
router.get('/:contactId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    const { activities, total } = await ActivityModel.getByContactId(req.params.contactId, req.userId, limit, offset);
    
    res.json({
      success: true,
      activities,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + activities.length < total
      }
    });
  } catch (error) {
    console.error('Error fetching activities:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
