const { Pool, types } = require('pg');
require('dotenv').config();

// Enforce Asia/Bangkok timezone in Node.js process
process.env.TZ = 'Asia/Bangkok';

// Force pg driver to return DATE column (type ID 1082) as plain 'YYYY-MM-DD' string
// This prevents UTC shifting (e.g. 2026-09-15 becoming 2026-09-14 17:00:00 UTC)
types.setTypeParser(1082, (val) => val);

const connectionString = process.env.DATABASE_URL;

let pool = null;

if (connectionString) {
  const isLocalhost = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
  pool = new Pool({
    connectionString,
    ssl: isLocalhost ? false : { rejectUnauthorized: false },
    max: 10, // Max concurrent connections to avoid exhausting free-tier pool limits
    idleTimeoutMillis: 30000, // Close idle connections after 30s
    connectionTimeoutMillis: 10000, // 10s connection timeout for cold starts
    options: '-c timezone=Asia/Bangkok' // Enforce timezone directly at connection handshake
  });

  pool.on('error', (err) => {
    console.error('Unexpected error on idle PostgreSQL client:', err);
  });
} else {
  console.warn('⚠️  DATABASE_URL is not set in environment variables or .env!');
  console.warn('👉 To connect to Supabase or Neon, copy .env.example to .env and provide your DATABASE_URL.');
}

// Wrapper for query execution with automatic error handling
async function query(text, params) {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured. Please set DATABASE_URL in your .env file.');
  }
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  // console.log('Executed query', { text: text.slice(0, 80), duration, rows: res.rowCount });
  return res;
}

// Helper to acquire a client for atomic transactions (BEGIN ... COMMIT/ROLLBACK)
async function getClient() {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured.');
  }
  return await pool.connect();
}

module.exports = {
  pool,
  query,
  getClient
};
