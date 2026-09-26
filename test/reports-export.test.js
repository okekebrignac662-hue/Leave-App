const assert = require('assert');
const http = require('http');
require('dotenv').config();

const PORT = 3888;
process.env.PORT = PORT;

const app = require('../src/server');
const { pool } = require('../src/db');

function request(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, data: body });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(typeof data === 'string' ? data : JSON.stringify(data));
    req.end();
  });
}

async function runReportExportTests() {
  console.log('\n📊 Starting HR & Payroll Report Export Verification Tests...\n');
  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total++;
    try {
      await fn();
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ [FAIL] ${name}:`, err.message);
    }
  }

  // Setup sample test records if database connected
  const testDate = '2028-11-15';
  if (pool) {
    try {
      // Ensure test employees exist with isolated test IDs (never overwrite real staff)
      await pool.query(`
        INSERT INTO employees (id, name, department, shift, pin, role, vacation_quota, personal_quota, sick_quota, unpaid_quota)
        VALUES 
          ('099998', 'ทดสอบ สรุปรายงานเอ็กเซล', 'Crimping 1', 'A', '1234', 'EMPLOYEE', 6, 6, 30, 30),
          ('099999', 'ทดสอบ ส่งออกข้อมูลพีดีเอฟ', 'Crimping 1', 'B', '1234', 'EMPLOYEE', 6, 6, 30, 30)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          department = EXCLUDED.department,
          shift = EXCLUDED.shift;
      `);

      // Clean old test requests
      await pool.query("DELETE FROM leave_requests WHERE start_date >= '2028-11-01' AND start_date <= '2028-11-30'");

      // Insert controlled test leave requests
      await pool.query(`
        INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, days_count, duration_type, hours_count, reason, status, reviewed_by, reviewed_at)
        VALUES 
          ('099998', 'Vacation', '2028-11-10', '2028-11-12', 3, 'FULL_DAY', NULL, 'พักผ่อนประจำปี', 'APPROVED', 'SUP-001', CURRENT_TIMESTAMP),
          ('099999', 'Sick', '2028-11-15', '2028-11-15', 0.25, 'HOURLY', 2.0, 'ไปพบแพทย์', 'APPROVED', 'SUP-001', CURRENT_TIMESTAMP),
          ('099998', 'Personal', '2028-11-20', '2028-11-20', 1, 'FULL_DAY', NULL, 'ทำธุระส่วนตัว', 'PENDING', NULL, NULL);
      `);
    } catch (setupErr) {
      console.warn('Note on test DB setup:', setupErr.message);
    }
  }

  // Test 1: JSON Export format and KPIs
  await test('GET /api/reports/leave-export with JSON format returns valid summary and rows', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/reports/leave-export?format=json',
      method: 'GET'
    });

    assert.strictEqual(res.status, 200, 'Status should be 200');
    assert.strictEqual(res.data.success, true, 'success should be true');
    assert.ok(res.data.summary, 'summary object must exist');
    assert.ok(typeof res.data.summary.totalRecords === 'number', 'totalRecords must be a number');
    assert.ok(typeof res.data.summary.totalDays === 'number', 'totalDays must be a number');
    assert.ok(Array.isArray(res.data.rows), 'rows must be an array');
    assert.ok(res.data.summary.byType, 'byType summary must exist');
    assert.ok(res.data.summary.byStatus, 'byStatus summary must exist');
  });

  // Test 2: CSV Export format, UTF-8 BOM, headers, and Excel formula protection
  await test('GET /api/reports/leave-export with format=csv returns UTF-8 BOM, Thai headers, and Excel formula protection', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/reports/leave-export?format=csv',
      method: 'GET'
    });

    assert.strictEqual(res.status, 200, 'Status should be 200');
    const contentType = res.headers['content-type'] || '';
    assert.ok(contentType.includes('text/csv'), `Content-Type should be text/csv, got: ${contentType}`);
    
    const disposition = res.headers['content-disposition'] || '';
    assert.ok(disposition.includes('attachment;'), `Content-Disposition should be attachment, got: ${disposition}`);

    const rawBody = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    // Verify UTF-8 BOM: character code 65279 (\uFEFF)
    assert.strictEqual(rawBody.charCodeAt(0), 0xFEFF, 'First character must be UTF-8 Byte Order Mark (\\uFEFF)');

    // Verify Thai headers
    assert.ok(rawBody.includes('เลขที่คำขอ'), 'CSV must contain "เลขที่คำขอ" header');
    assert.ok(rawBody.includes('รหัสพนักงาน'), 'CSV must contain "รหัสพนักงาน" header');
    assert.ok(rawBody.includes('ชื่อ-นามสกุล'), 'CSV must contain "ชื่อ-นามสกุล" header');
    assert.ok(rawBody.includes('แผนก'), 'CSV must contain "แผนก" header');
    assert.ok(rawBody.includes('สถานะคำขอ'), 'CSV must contain "สถานะคำขอ" header');

    // If test records exist, verify numeric employee id has formula protection
    if (rawBody.includes('099998')) {
      assert.ok(rawBody.includes('="099998"'), 'Employee ID with leading zero must be formatted as ="099998" for Excel');
    }
  });

  // Test 3: Date range filter
  await test('Filter by Date Range captures correct leave requests', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/reports/leave-export?format=json&startDate=2028-11-01&endDate=2028-11-18',
      method: 'GET'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    if (pool) {
      // In range: 2028-11-10 to 12 (Vacation) and 2028-11-15 (Sick)
      // Out of range: 2028-11-20 (Personal)
      const found20 = res.data.rows.find(r => r.start_date === '2028-11-20');
      assert.strictEqual(found20, undefined, 'Leave starting 2028-11-20 should be excluded by endDate=2028-11-18');
    }
  });

  // Test 4: Status filter (APPROVED only)
  await test('Filter by status=APPROVED only returns approved leave requests', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/reports/leave-export?format=json&status=APPROVED',
      method: 'GET'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    res.data.rows.forEach(r => {
      assert.strictEqual(r.status.toUpperCase(), 'APPROVED', `Every row should be APPROVED, found: ${r.status}`);
    });
  });

  // Test 5: Department filter
  await test('Filter by department correctly isolates matching department', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/reports/leave-export?format=json&department=Crimping%201',
      method: 'GET'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    res.data.rows.forEach(r => {
      assert.strictEqual(r.department.toUpperCase(), 'CRIMPING 1', `Every row should be Crimping 1, found: ${r.department}`);
    });
  });

  // Test 6: Search text filter
  await test('Search query matches employee name or ID', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/reports/leave-export?format=json&search=099998',
      method: 'GET'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.rows.length >= 2, 'Should return at least 2 records for 099998');
    res.data.rows.forEach(r => {
      const match = r.employee_name.includes('099998') || r.employee_id.includes('099998') || (r.reason && r.reason.includes('099998'));
      assert.ok(match, 'Result should match search query');
    });
  });

  // Cleanup test data
  if (pool) {
    await pool.query("DELETE FROM leave_requests WHERE start_date >= '2028-11-01' AND start_date <= '2028-11-30'").catch(() => {});
    await pool.query("DELETE FROM employees WHERE id IN ('099998', '099999')").catch(() => {});
  }

  console.log(`\n========================================`);
  console.log(`Report Export Test Results: ${passed}/${total} passed`);
  console.log(`========================================\n`);

  if (passed !== total) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runReportExportTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

