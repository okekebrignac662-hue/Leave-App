const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

let pool = null;

if (connectionString) {
  const isLocalhost = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
  pool = new Pool({
    connectionString,
    ssl: isLocalhost ? false : { rejectUnauthorized: false }
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

module.exports = {
  pool,
  query
};
