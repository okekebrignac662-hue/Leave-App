const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
require('dotenv').config();

async function initDatabase() {
  if (!pool) {
    console.error('❌ Error: DATABASE_URL is not set. Please create a .env file with your DATABASE_URL.');
    process.exit(1);
  }

  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  console.log(`📄 Reading SQL schema from: ${schemaPath}`);

  try {
    const sql = fs.readFileSync(schemaPath, 'utf-8');
    console.log('⏳ Connecting to PostgreSQL and executing schema...');
    
    await pool.query(sql);

    console.log('✅ Database schema and seed data created successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to initialize database:', error.message);
    process.exit(1);
  }
}

initDatabase();
