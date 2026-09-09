const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running database migration for shifts...');
    await client.query('BEGIN');

    // 1. Add shift column to employees
    await client.query(`
      ALTER TABLE employees 
      ADD COLUMN IF NOT EXISTS shift VARCHAR(20) NOT NULL DEFAULT 'Day';
    `);
    console.log('Added shift column to employees table.');

    // 2. Add shift column to quota_settings
    await client.query(`
      ALTER TABLE quota_settings 
      ADD COLUMN IF NOT EXISTS shift VARCHAR(20) NOT NULL DEFAULT 'Day';
    `);
    console.log('Added shift column to quota_settings table.');

    // 3. Update unique constraint on quota_settings
    await client.query(`
      ALTER TABLE quota_settings DROP CONSTRAINT IF EXISTS quota_settings_department_key;
      ALTER TABLE quota_settings DROP CONSTRAINT IF EXISTS quota_settings_department_shift_key;
      ALTER TABLE quota_settings ADD CONSTRAINT quota_settings_department_shift_key UNIQUE (department, shift);
    `);
    console.log('Updated quota_settings UNIQUE constraint to (department, shift).');

    // 4. Seed Night shift quotas
    await client.query(`
      INSERT INTO quota_settings (department, shift, max_daily_leaves)
      VALUES 
        ('Crimping 1', 'Night', 3),
        ('Assembly', 'Night', 2),
        ('QC', 'Night', 1),
        ('Management', 'Night', 2)
      ON CONFLICT (department, shift) DO NOTHING;
    `);
    console.log('Seeded Night shift quotas.');

    // 5. Assign some demo employees to Night shift for testing
    await client.query(`
      UPDATE employees SET shift = 'Night' WHERE UPPER(id) IN ('EMP-003', 'EMP-004');
    `);
    console.log('Assigned EMP-003 and EMP-004 to Night shift.');

    await client.query('COMMIT');
    console.log('✅ SHIFT MIGRATION COMPLETED SUCCESSFULLY!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
