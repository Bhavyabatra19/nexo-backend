/**
 * Platform-admin gate. Requires authenticateToken to have run first so
 * req.user is populated. The is_platform_admin flag is flipped manually in
 * the DB — there is no in-app way to grant it.
 */
function requirePlatformAdmin(req, res, next) {
  if (!req.user?.is_platform_admin) {
    return res.status(403).json({ success: false, error: 'Platform admin only' });
  }
  next();
}

module.exports = { requirePlatformAdmin };
