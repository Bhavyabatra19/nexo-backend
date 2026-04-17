require('dotenv').config();
const { Pool } = require('pg');

/**
 * PostgreSQL Connection Pool
 * Manages database connections efficiently
 */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // Connection pool settings — tuned for 100 concurrent users
  max: parseInt(process.env.DB_POOL_MAX, 10) || 50,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const configuredDbTimeZone = process.env.DB_TIMEZONE || 'Asia/Kolkata';
const dbTimeZone = /^[A-Za-z_\-/]+$/.test(configuredDbTimeZone)
  ? configuredDbTimeZone
  : 'Asia/Kolkata';

// Test connection on startup
pool.on('connect', async (client) => {
  try {
    // Keep SQL timestamp behavior consistent across environments.
    await client.query(`SET TIME ZONE '${dbTimeZone}'`);
    console.log(`✓ Connected to PostgreSQL database (timezone: ${dbTimeZone})`);
  } catch (error) {
    console.error(`Failed to set database session timezone to ${dbTimeZone}:`, error.message);
  }
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
  process.exit(-1);
});

/**
 * Execute a query with parameterized values
 * @param {string} text - SQL query
 * @param {array} params - Query parameters
 * @returns {Promise} Query result
 */
const isProduction = process.env.NODE_ENV === 'production';

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    // Only log slow queries in production to reduce I/O overhead
    if (!isProduction || duration > 200) {
      console.log('Executed query', { text: text.substring(0, 120), duration, rows: res.rowCount });
    }
    return res;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}

/**
 * Get a client from the pool for transactions
 * @returns {Promise} Database client
 */
async function getClient() {
  const client = await pool.connect();
  const query = client.query.bind(client);
  const release = client.release.bind(client);
  
  // Set a timeout to release client if it's not released manually
  const timeout = setTimeout(() => {
    console.error('A client has been checked out for more than 5 seconds!');
    console.error('The last query executed was:', client.lastQuery);
  }, 5000);
  
  // Monkey-patch the query method to track the last query
  client.query = (...args) => {
    client.lastQuery = args;
    return query(...args);
  };
  
  client.release = () => {
    clearTimeout(timeout);
    client.query = query;
    client.release = release;
    return release();
  };
  
  return client;
}

/**
 * Test database connection
 */
async function testConnection() {
  try {
    const result = await query('SELECT NOW() as now');
    console.log('✓ Database connection test successful:', result.rows[0].now);
    return true;
  } catch (error) {
    console.error('✗ Database connection test failed:', error.message);
    return false;
  }
}

module.exports = {
  query,
  getClient,
  pool,
  testConnection
};
