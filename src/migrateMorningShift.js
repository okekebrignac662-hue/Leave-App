const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log('Seeding Morning (เช้าตลอด - หัวหน้างาน) shift quotas...');
  const depts = ['Crimping 1', 'Assembly', 'QC', 'Management'];
  for (const dept of depts) {
    await pool.query(
      `INSERT INTO quota_settings (department, shift, max_daily_leaves)
       VALUES ($1, $2, $3)
       ON CONFLICT (department, shift)
       DO UPDATE SET max_daily_leaves = EXCLUDED.max_daily_leaves`,
      [dept, 'Morning', 2]
    );
  }

  console.log('Updating supervisors to Morning shift...');
  await pool.query(`UPDATE employees SET shift = 'Morning' WHERE role = 'SUPERVISOR'`);

  const quotas = await pool.query(`SELECT department, shift, max_daily_leaves FROM quota_settings ORDER BY department, shift`);
  console.log('All Quota Settings:\n', quotas.rows);

  const sups = await pool.query(`SELECT id, name, role, department, shift FROM employees WHERE role = 'SUPERVISOR'`);
  console.log('Supervisors:\n', sups.rows);

  await pool.end();
  console.log('Done!');
}

run().catch(err => {
  console.error('Error migrating Morning shift:', err);
  process.exit(1);
});
