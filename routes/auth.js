const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const {
  getAuthUrl,
  getTokensFromCode,
  getAuthenticatedClient
} = require('../config/oauth');
const { generateToken, generateRefreshToken } = require('../middleware/auth');
const UserModel = require('../models/User');
const TokenModel = require('../models/Token');

/**
 * Authentication Routes with PostgreSQL Integration
 */

/**
 * GET /api/auth/google
 * Initiate OAuth flow
 */
router.get('/google', (req, res) => {
  try {
    const authUrl = getAuthUrl();
    
    res.json({
      success: true,
      authUrl: authUrl,
      message: 'Redirect user to this URL for Google authentication'
    });
  } catch (error) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/auth/google/callback
 * OAuth callback - exchanges code for tokens and creates/logs in user
 */
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).json({
      success: false,
      error: `OAuth error: ${error}`
    });
  }

  if (!code) {
    return res.status(400).json({
      success: false,
      error: 'No authorization code provided'
    });
  }

  try {
    // Exchange code for tokens
    const tokens = await getTokensFromCode(code);
    
    // Get user info from Google
    const authClient = getAuthenticatedClient(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: authClient });
    const { data: userInfo } = await oauth2.userinfo.get();

    // Find or create user in database
    const user = await UserModel.findOrCreate({
      email: userInfo.email,
      fullName: userInfo.name,
      googleId: userInfo.id,
      profilePicture: userInfo.picture
    });

    // Save Google tokens to database
    await TokenModel.upsert(user.id, tokens);

    // Generate JWT tokens for our app
    const accessToken = generateToken(user.id);
    const refreshToken = generateRefreshToken(user.id);
    res.redirect(process.env.FRONTEND_AUTH_URL+"/auth/callback?accessToken="+accessToken+"&refreshToken="+refreshToken);
    // // Send response
    // res.json({
    //   success: true,
    //   message: 'Authentication successful',
    //   user: {
    //     id: user.id,
    //     email: user.email,
    //     fullName: user.full_name,
    //     profilePicture: user.profile_picture
    //   },
    //   tokens: {
    //     accessToken,
    //     refreshToken,
    //     expiresIn: '7d'
    //   }
    // });

  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        error: 'Refresh token required'
      });
    }

    // Verify refresh token
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);

    if (decoded.type !== 'refresh') {
      return res.status(400).json({
        success: false,
        error: 'Invalid refresh token'
      });
    }

    // Generate new access token
    const newAccessToken = generateToken(decoded.userId);

    res.json({
      success: true,
      accessToken: newAccessToken
    });

  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Invalid or expired refresh token'
    });
  }
});

/**
 * GET /api/auth/me
 * Get current user info (requires authentication)
 */
router.get('/me', require('../middleware/auth').authenticateToken, async (req, res) => {
  try {
    const stats = await UserModel.getStats(req.userId);

    res.json({
      success: true,
      user: {
        id: req.user.id,
        email: req.user.email,
        fullName: req.user.full_name,
        profilePicture: req.user.profile_picture,
        createdAt: req.user.created_at,
        lastLogin: req.user.last_login
      },
      statistics: stats
    });

  } catch (error) {
    console.error('Error fetching user info:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout user (optional - just delete tokens on client)
 */
router.post('/logout', require('../middleware/auth').authenticateToken, async (req, res) => {
  try {
    // Optionally: Could delete Google tokens from database
    // await TokenModel.delete(req.userId);

    res.json({
      success: true,
      message: 'Logged out successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/auth/disconnect
 * Disconnect Google account (delete tokens)
 */
router.delete('/disconnect', require('../middleware/auth').authenticateToken, async (req, res) => {
  try {
    await TokenModel.delete(req.userId);

    res.json({
      success: true,
      message: 'Google account disconnected successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
