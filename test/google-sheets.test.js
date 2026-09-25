const assert = require('assert');
const http = require('http');

const TEST_PORT = 3555;
process.env.PORT = TEST_PORT;

const googleSheetsService = require('../src/googleSheetsService');
const app = require('../src/server');

function makeRequest(path, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: 'localhost',
      port: TEST_PORT,
      path,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('🧪 Starting Google Sheets Integration Tests...\n');

  try {
    // 1. Test Service Formatters
    console.log('1️⃣  Testing Data Formatters in googleSheetsService...');
    const leavePayload = googleSheetsService.formatLeavePayload({
      id: 101,
      employee_id: 'EMP-001',
      employee_name: 'สมชาย ใจดี',
      department: 'Assembly',
      shift: 'A',
      leave_type: 'Vacation',
      duration_type: 'HOURLY',
      start_date: '2026-09-30',
      end_date: '2026-09-30',
      days_count: 0.25,
      start_time: '10:00',
      end_time: '12:00',
      hours_count: 2.0,
      reason: 'ธุระด่วน',
      status: 'PENDING'
    });

    assert.strictEqual(leavePayload.id, 101);
    assert.strictEqual(leavePayload.employee_id, 'EMP-001');
    assert.strictEqual(leavePayload.duration_type, 'HOURLY');
    assert.strictEqual(leavePayload.hours_count, 2.0);
    assert.strictEqual(leavePayload.start_time, '10:00');
    console.log('✅ [PASS] formatLeavePayload formats hourly and full-day fields accurately');

    const empPayload = googleSheetsService.formatEmployeePayload({
      id: 'EMP-002',
      name: 'สมหญิง จริงใจ',
      department: 'QC',
      shift: 'B',
      role: 'EMPLOYEE',
      pin: '1234',
      vacation_quota: 6,
      personal_quota: 6,
      sick_quota: 30,
      unpaid_quota: 30
    });
    assert.strictEqual(empPayload.id, 'EMP-002');
    assert.strictEqual(empPayload.shift, 'B');
    assert.strictEqual(empPayload.pin, '1234');
    console.log('✅ [PASS] formatEmployeePayload formats employee attributes accurately');

    // 2. Test GET /api/google-sheets/config
    console.log('\n2️⃣  Testing GET /api/google-sheets/config...');
    const cfgRes = await makeRequest('/api/google-sheets/config');
    assert.strictEqual(cfgRes.status, 200);
    assert.strictEqual(cfgRes.data.success, true);
    assert.ok(typeof cfgRes.data.config.autoSync === 'boolean');
    console.log('✅ [PASS] GET /api/google-sheets/config returns current configuration');

    // 3. Test POST /api/google-sheets/config (Unauthorized)
    console.log('\n3️⃣  Testing Authorization on POST /api/google-sheets/config...');
    const unauthRes = await makeRequest('/api/google-sheets/config', { method: 'POST' }, {
      adminId: 'EMP-001',
      webhookUrl: 'https://script.google.com/macros/s/AKfycbx_TEST/exec'
    });
    assert.strictEqual(unauthRes.status, 403);
    console.log('✅ [PASS] Non-admin cannot modify Google Sheets config');

    // 4. Test Invalid Webhook URL
    console.log('\n4️⃣  Testing Invalid Webhook URL rejection...');
    const invalidUrlRes = await makeRequest('/api/google-sheets/config', { method: 'POST' }, {
      adminId: 'ADMIN-001',
      webhookUrl: 'https://malicious-site.com/webhook'
    });
    assert.strictEqual(invalidUrlRes.status, 400);
    console.log('✅ [PASS] Rejects non-Google Apps Script URLs');

    // 5. Test Valid Config Save
    console.log('\n5️⃣  Testing Valid Config Save (ADMIN-001)...');
    const validSaveRes = await makeRequest('/api/google-sheets/config', { method: 'POST' }, {
      adminId: 'ADMIN-001',
      webhookUrl: 'https://script.google.com/macros/s/AKfycbx_MOCK_TEST_URL/exec',
      autoSync: true
    });
    assert.strictEqual(validSaveRes.status, 200);
    assert.strictEqual(validSaveRes.data.success, true);
    assert.strictEqual(validSaveRes.data.config.configured, true);
    assert.strictEqual(validSaveRes.data.config.webhookUrl, 'https://script.google.com/macros/s/AKfycbx_MOCK_TEST_URL/exec');
    console.log('✅ [PASS] Admin successfully saved Google Sheets Webhook URL');

    // 6. Test Sync Permissions
    console.log('\n6️⃣  Testing Sync Permissions (POST /api/google-sheets/sync)...');
    const empSyncRes = await makeRequest('/api/google-sheets/sync', { method: 'POST' }, {
      requesterId: 'EMP-001',
      syncType: 'ALL'
    });
    assert.strictEqual(empSyncRes.status, 403);
    console.log('✅ [PASS] Regular employee blocked from initiating manual sync');

    // 7. Verify Auto-Sync Non-Blocking Nature
    console.log('\n7️⃣  Testing that leave request creation works seamlessly even with offline/mock webhook...');
    const randomDay = Math.floor(Math.random() * 20) + 1;
    const testDate = `2026-11-${String(randomDay).padStart(2, '0')}`;
    const createReqRes = await makeRequest('/api/leave-requests', { method: 'POST' }, {
      employeeId: 'EMP-001',
      leaveType: 'Vacation',
      startDate: testDate,
      endDate: testDate,
      reason: 'ทดสอบการส่งคำขอพร้อมซิงค์'
    });
    if (createReqRes.status !== 201) {
      console.error('Response error:', createReqRes.data);
    }
    assert.strictEqual(createReqRes.status, 201);
    assert.strictEqual(createReqRes.data.success, true);
    console.log('✅ [PASS] Leave request creation succeeds smoothly without blocking on webhook');

    console.log('\n🎉 ALL GOOGLE SHEETS INTEGRATION TESTS PASSED 100%!\n');
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  }
}

runTests();
