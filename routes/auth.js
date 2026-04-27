const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const {
  getAuthUrl,
  getTokensFromCode,
  getAuthenticatedClient
} = require('../config/oauth');
const {
  generateToken,
  generateRefreshToken,
  setAuthCookies,
  clearAuthCookies,
} = require('../middleware/auth');
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

    const { user, isNew } = await UserModel.findOrCreate({
      email: userInfo.email,
      fullName: userInfo.name,
      googleId: userInfo.id,
      profilePicture: userInfo.picture
    });

    await TokenModel.upsert(user.id, tokens);

    const accessToken = generateToken(user.id);
    const refreshToken = generateRefreshToken(user.id);
    setAuthCookies(res, accessToken, refreshToken);

    const qs = isNew ? '?new=1' : '';
    res.redirect(`${process.env.FRONTEND_AUTH_URL}/auth/callback${qs}`);

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
    // Prefer cookie (primary path). Body fallback keeps legacy clients working.
    const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        error: 'Refresh token required'
      });
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);

    if (decoded.type !== 'refresh') {
      return res.status(400).json({
        success: false,
        error: 'Invalid refresh token'
      });
    }

    const newAccessToken = generateToken(decoded.userId);
    setAuthCookies(res, newAccessToken, null);

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
        lastLogin: req.user.last_login,
        isPlatformAdmin: req.user.is_platform_admin === true,
        orgDomain: req.user.org_domain || null,
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
router.post('/logout', async (req, res) => {
  // Unauthenticated: always succeed — cookie-wipe should work even if the token is already expired.
  clearAuthCookies(res);
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
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
