const db = require('../db');

class AITokenService {
  /**
   * Check if a user has exceeded the daily token limit (100,000)
   * Resets the counter if a new day has started.
   * @param {string} userId - ID of the user
   * @returns {boolean} True if within limit, False if exceeded
   */
  static async checkLimit(userId) {
    try {
      const res = await db.query(`
        UPDATE users 
        SET 
          ai_tokens_used_today = CASE WHEN ai_tokens_last_reset < CURRENT_DATE THEN 0 ELSE ai_tokens_used_today END,
          ai_tokens_last_reset = CURRENT_DATE
        WHERE id = $1
        RETURNING ai_tokens_used_today
      `, [userId]);
      
      const usedTokens = parseInt(res.rows[0]?.ai_tokens_used_today || 0);
      
      // Strict 100,000 threshold across all LLM operations
      if (usedTokens >= 100000) {
        return false;
      }
      return true;
    } catch (error) {
       console.error('Error checking AI token limit:', error);
       // Fail open in case of DB issues, or fail closed?
       // Usually fail open to prevent breaking production due to a glitch
       return true;
    }
  }

  /**
   * Add tokens to the user's daily usage counter.
   * @param {string} userId - ID of the user
   * @param {number} inputTokens - Number of tokens in prompt
   * @param {number} outputTokens - Number of tokens generated
   */
  static async addTokens(userId, inputTokens = 0, outputTokens = 0) {
    const total = (inputTokens || 0) + (outputTokens || 0);
    if (!total || total <= 0) return;
    
    try {
      await db.query(`
        UPDATE users 
        SET ai_tokens_used_today = COALESCE(ai_tokens_used_today, 0) + $2
        WHERE id = $1
      `, [userId, total]);
    } catch (error) {
      console.error('Error recording AI token usage:', error);
    }
  }
}

module.exports = AITokenService;
