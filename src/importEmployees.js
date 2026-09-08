const fs = require('fs');
const path = require('path');
const { pool, query } = require('./db');
require('dotenv').config();

async function importEmployees() {
  if (!pool) {
    console.error('❌ Error: DATABASE_URL is not set.');
    process.exit(1);
  }

  const csvPath = path.join(__dirname, '..', 'employees_list.csv');
  if (!fs.existsSync(csvPath)) {
    console.error(`❌ Error: ${csvPath} not found.`);
    process.exit(1);
  }

  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const dataLines = lines.slice(1);

  console.log(`📄 Found ${dataLines.length} employee records to import.`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Ensure department 'AUTO' exists in quota_settings
    await client.query(`
      INSERT INTO quota_settings (department, max_daily_leaves)
      VALUES ('AUTO', 5)
      ON CONFLICT (department) DO UPDATE SET max_daily_leaves = 5
    `);
    console.log('✅ Quota settings for department AUTO configured (max_daily_leaves = 5).');

    let count = 0;
    let supCount = 0;

    for (const line of dataLines) {
      const parts = line.split(',');
      if (parts.length >= 4) {
        const id = parts[1].trim();
        const name = parts[2].trim().replace(/\s+/g, ' ');
        const position = parts.slice(3).join(',').trim();
        const isSupervisor = position.includes('หัวหน้า');
        const role = isSupervisor ? 'SUPERVISOR' : 'EMPLOYEE';
        const pin = id; // PIN is same as Employee ID
        const department = 'AUTO';
        const vacationQuota = isSupervisor ? 10 : 6;
        const personalQuota = 6;
        const sickQuota = 30;

        await client.query(`
          INSERT INTO employees (id, name, department, pin, role, vacation_quota, personal_quota, sick_quota)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            department = EXCLUDED.department,
            pin = EXCLUDED.pin,
            role = EXCLUDED.role,
            vacation_quota = EXCLUDED.vacation_quota,
            personal_quota = EXCLUDED.personal_quota,
            sick_quota = EXCLUDED.sick_quota
        `, [id, name, department, pin, role, vacationQuota, personalQuota, sickQuota]);

        count++;
        if (isSupervisor) {
          supCount++;
          console.log(`👑 Imported Supervisor: [${id}] ${name} (PIN: ${pin}, Dept: ${department})`);
        }
      }
    }

    await client.query('COMMIT');
    console.log(`\n🎉 Successfully imported ${count} employees (${supCount} supervisor) into Supabase PostgreSQL!`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Import failed:', err);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

importEmployees();
