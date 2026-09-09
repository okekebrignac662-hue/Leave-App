const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log('Migrating shifts to: กะ A, กะ B, เช้าตลอด (หัวหน้างาน)...');

  // 1. In employees table:
  await pool.query(`UPDATE employees SET shift = 'A' WHERE shift = 'Day' OR shift IS NULL`);
  await pool.query(`UPDATE employees SET shift = 'B' WHERE shift = 'Night'`);
  await pool.query(`UPDATE employees SET shift = 'Morning' WHERE role = 'SUPERVISOR'`);

  // 2. In quota_settings:
  // Convert existing Day -> A, Night -> B
  await pool.query(`UPDATE quota_settings SET shift = 'A' WHERE shift = 'Day'`);
  await pool.query(`UPDATE quota_settings SET shift = 'B' WHERE shift = 'Night'`);

  // Ensure A, B, Morning exist for all departments
  const depts = ['Crimping 1', 'Assembly', 'QC', 'Management'];
  for (const dept of depts) {
    const quotaA = dept === 'Crimping 1' ? 3 : (dept === 'QC' ? 1 : 2);
    const quotaB = dept === 'Crimping 1' ? 3 : (dept === 'QC' ? 1 : 2);
    const quotaM = 2;

    await pool.query(`
      INSERT INTO quota_settings (department, shift, max_daily_leaves)
      VALUES ($1, 'A', $2)
      ON CONFLICT (department, shift) DO UPDATE SET max_daily_leaves = EXCLUDED.max_daily_leaves
    `, [dept, quotaA]);

    await pool.query(`
      INSERT INTO quota_settings (department, shift, max_daily_leaves)
      VALUES ($1, 'B', $2)
      ON CONFLICT (department, shift) DO UPDATE SET max_daily_leaves = EXCLUDED.max_daily_leaves
    `, [dept, quotaB]);

    await pool.query(`
      INSERT INTO quota_settings (department, shift, max_daily_leaves)
      VALUES ($1, 'Morning', $2)
      ON CONFLICT (department, shift) DO UPDATE SET max_daily_leaves = EXCLUDED.max_daily_leaves
    `, [dept, quotaM]);
  }

  // Delete any lingering Day/Night records if conflict prevented rename
  await pool.query(`DELETE FROM quota_settings WHERE shift IN ('Day', 'Night')`);

  const quotas = await pool.query(`SELECT department, shift, max_daily_leaves FROM quota_settings ORDER BY department, shift`);
  console.log('Updated Quota Settings:\n', quotas.rows);

  const sups = await pool.query(`SELECT id, name, role, department, shift FROM employees WHERE role = 'SUPERVISOR'`);
  console.log('Supervisors:\n', sups.rows);

  const empSample = await pool.query(`SELECT id, name, role, department, shift FROM employees LIMIT 6`);
  console.log('Sample Employees:\n', empSample.rows);

  await pool.end();
  console.log('✅ Shift A / B / Morning migration completed!');
}

run().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
