const jwt = require('jsonwebtoken');
const UserModel = require('../models/User');

/**
 * Authentication Middleware
 * Protects routes and attaches user to request
 */

// In-memory user cache — avoids a DB round-trip on every authenticated request.
// TTL: 60 seconds. With 100 concurrent users this saves ~6,000 queries/min.
const USER_CACHE_TTL = 60_000;
const userCache = new Map();

function getCachedUser(userId) {
  const entry = userCache.get(userId);
  if (entry && Date.now() - entry.ts < USER_CACHE_TTL) return entry.user;
  if (entry) userCache.delete(userId);
  return null;
}

function setCachedUser(user) {
  userCache.set(user.id, { user, ts: Date.now() });
}

/** Call this after profile updates so stale data isn't served. */
function invalidateUserCache(userId) {
  userCache.delete(userId);
}

/**
 * Verify JWT token and attach user to request
 */
async function authenticateToken(req, res, next) {
  try {
    // Cookie first (folkX-style: extension + web app share session), then Bearer fallback for legacy clients
    const cookieToken = req.cookies?.accessToken;
    const authHeader = req.headers['authorization'];
    const headerToken = authHeader && authHeader.split(' ')[1];
    const token = cookieToken || headerToken;

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access token required'
      });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Try cache first, then DB
    let user = getCachedUser(decoded.userId);
    if (!user) {
      user = await UserModel.findById(decoded.userId);
      if (user) setCachedUser(user);
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'User not found'
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        error: 'User account is deactivated'
      });
    }

    // Attach user to request
    req.user = user;
    req.userId = user.id;

    next();

  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired'
      });
    }

    console.error('Auth middleware error:', error);
    return res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
}

/**
 * Optional authentication - doesn't fail if no token
 * Useful for endpoints that work better with auth but don't require it
 */
async function optionalAuth(req, res, next) {
  try {
    const cookieToken = req.cookies?.accessToken;
    const authHeader = req.headers['authorization'];
    const headerToken = authHeader && authHeader.split(' ')[1];
    const token = cookieToken || headerToken;

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await UserModel.findById(decoded.userId);
      
      if (user && user.is_active) {
        req.user = user;
        req.userId = user.id;
      }
    }

    next();

  } catch (error) {
    // Ignore errors in optional auth
    next();
  }
}

/**
 * Generate JWT token for user
 */
function generateToken(userId) {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

/**
 * Generate refresh token (longer expiry)
 */
function generateRefreshToken(userId) {
  return jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Cross-site (frontend on Vercel, extension chrome-extension://) cookies require SameSite=None + Secure.
// In non-HTTPS local dev, fall back to Lax so cookies still work on localhost.
const isProd = process.env.NODE_ENV === 'production';
const cookieBase = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? 'none' : 'lax',
  path: '/',
};

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie('accessToken', accessToken, { ...cookieBase, maxAge: 7 * 24 * 60 * 60 * 1000 });
  if (refreshToken) {
    res.cookie('refreshToken', refreshToken, { ...cookieBase, maxAge: 30 * 24 * 60 * 60 * 1000 });
  }
}

function clearAuthCookies(res) {
  res.clearCookie('accessToken', cookieBase);
  res.clearCookie('refreshToken', cookieBase);
}

module.exports = {
  authenticateToken,
  optionalAuth,
  generateToken,
  generateRefreshToken,
  invalidateUserCache,
  setAuthCookies,
  clearAuthCookies,
};
