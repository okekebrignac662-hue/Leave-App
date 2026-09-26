require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function updateWebhook() {
  try {
    const url = 'https://script.google.com/macros/s/AKfycbxl5D1r8k79bWXmq4qlCraAnvhm73fcx4RhwUKtmwu5iz8WwF5LHbsc7xMQxG9bfQB3/exec';
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('google_sheet_webhook_url', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [url]
    );
    console.log('Webhook URL updated successfully in the database.');
  } catch (error) {
    console.error('Error updating webhook:', error);
  } finally {
    await pool.end();
  }
}

updateWebhook();
