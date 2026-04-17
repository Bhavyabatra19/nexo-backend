const db = require('../db');

/**
 * Google Token Model
 * Manages Google OAuth tokens in database
 */

class TokenModel {
  /**
   * Save or update Google OAuth tokens
   */
  static async upsert(userId, tokens) {
    const expiresAt = new Date(tokens.expiry_date);
    
    const query = `
      INSERT INTO google_tokens (user_id, access_token, refresh_token, expires_at, scope, token_type)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id) 
      DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = COALESCE(EXCLUDED.refresh_token, google_tokens.refresh_token),
        expires_at = EXCLUDED.expires_at,
        scope = EXCLUDED.scope,
        token_type = EXCLUDED.token_type,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `;

    const result = await db.query(query, [
      userId,
      tokens.access_token,
      tokens.refresh_token || null,
      expiresAt,
      tokens.scope || null,
      tokens.token_type || 'Bearer'
    ]);

    return result.rows[0];
  }

  /**
   * Get tokens for a user
   */
  static async getByUserId(userId) {
    const query = 'SELECT * FROM google_tokens WHERE user_id = $1';
    const result = await db.query(query, [userId]);
    return result.rows[0];
  }

  /**
   * Check if tokens exist and are valid
   */
  static async isValid(userId) {
    const query = `
      SELECT expires_at > CURRENT_TIMESTAMP as is_valid 
      FROM google_tokens 
      WHERE user_id = $1
    `;
    
    const result = await db.query(query, [userId]);
    return result.rows[0]?.is_valid || false;
  }

  /**
   * Get tokens in Google OAuth format
   */
  static async getTokensForGoogle(userId) {
    const tokens = await this.getByUserId(userId);
    
    if (!tokens) {
      return null;
    }

    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type,
      expiry_date: new Date(tokens.expires_at).getTime(),
      scope: tokens.scope
    };
  }

  /**
   * Delete tokens for a user
   */
  static async delete(userId) {
    const query = 'DELETE FROM google_tokens WHERE user_id = $1';
    await db.query(query, [userId]);
  }

  /**
   * Find users with expired tokens
   */
  static async findExpired() {
    const query = `
      SELECT user_id 
      FROM google_tokens 
      WHERE expires_at < CURRENT_TIMESTAMP
    `;
    
    const result = await db.query(query);
    return result.rows;
  }

  /**
   * Clean up expired tokens (can be run as a cron job)
   */
  static async cleanupExpired() {
    const query = `
      DELETE FROM google_tokens 
      WHERE expires_at < CURRENT_TIMESTAMP - INTERVAL '30 days'
      AND refresh_token IS NULL
    `;
    
    const result = await db.query(query);
    return result.rowCount;
  }
}

module.exports = TokenModel;
