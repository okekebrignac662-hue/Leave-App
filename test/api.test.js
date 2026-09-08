// Standalone verification script for Leave Management APIs
const http = require('http');

const PORT = 3099;
process.env.PORT = PORT;

// Start server in-process
const app = require('../src/server'); // server starts on PORT or 3000

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

async function runTests() {
  console.log('🧪 Starting API Verification Tests...\n');
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

  // 1. Health check
  await test('GET /api/health returns 200 OK', async () => {
    const res = await request({ hostname: 'localhost', port: PORT, path: '/api/health', method: 'GET' });
    if (res.status !== 200 || res.data.status !== 'OK') throw new Error(`Status ${res.status}`);
  });

  // 2. Static HTML check
  await test('GET / returns HTML frontend UI', async () => {
    const res = await request({ hostname: 'localhost', port: PORT, path: '/', method: 'GET' });
    if (res.status !== 200 || !res.data.includes('Online Leave App')) throw new Error('HTML UI missing title');
  });

  // 3. Login API - Employee
  await test('POST /api/login for EMP-001 returns isSupervisor=false', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { empId: 'EMP-001', pin: '1234' });

    if (res.status !== 200 || !res.data.success || res.data.user.isSupervisor !== false) {
      throw new Error(`Expected isSupervisor false, got ${JSON.stringify(res.data)}`);
    }
  });

  // 4. Login API - Supervisor
  await test('POST /api/login for SUP-001 returns isSupervisor=true', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { empId: 'SUP-001', pin: '1234' });

    if (res.status !== 200 || !res.data.success || res.data.user.isSupervisor !== true) {
      throw new Error(`Expected isSupervisor true, got ${JSON.stringify(res.data)}`);
    }
  });

  // 4.1 Login API - Reject Unknown ID
  await test('POST /api/login rejects unknown ID', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { empId: 'RANDOM-999', pin: '1234' });

    if (res.status !== 401) {
      throw new Error(`Expected status 401 for unknown user, got ${res.status}`);
    }
  });

  // 4.2 Login API - Reject Wrong PIN
  await test('POST /api/login rejects wrong PIN', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { empId: 'EMP-001', pin: 'wrong-pin' });

    if (res.status !== 401) {
      throw new Error(`Expected status 401 for wrong pin, got ${res.status}`);
    }
  });

  // 5. Employee Quota API
  await test('GET /api/employees/EMP-001/quota returns quota breakdown', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/employees/EMP-001/quota',
      method: 'GET'
    });

    if (res.status !== 200 || !res.data.success || !res.data.quota.vacation) {
      throw new Error(`Invalid quota response: ${JSON.stringify(res.data)}`);
    }
  });

  // 5.1 Department Calendar API
  await test('GET /api/department-calendar returns daily usage and max limit', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/department-calendar?department=Assembly&month=2026-09',
      method: 'GET'
    });

    if (res.status !== 200 || !res.data.success || !res.data.dailyUsage) {
      throw new Error(`Invalid calendar response: ${JSON.stringify(res.data)}`);
    }

    if (res.data.department !== 'Assembly' || typeof res.data.maxDailyLeaves !== 'number') {
      throw new Error(`Invalid department or maxDailyLeaves: ${JSON.stringify(res.data)}`);
    }
  });

  // 6. Leave Request Submission
  await test('POST /api/leave-requests creates a pending leave request', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/leave-requests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      employeeId: 'EMP-003',
      leaveType: 'Vacation',
      startDate: '2026-10-01',
      endDate: '2026-10-01',
      reason: 'ไปพักผ่อนต่างจังหวัด'
    });

    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`Failed to create request: ${JSON.stringify(res.data)}`);
    }
  });

  // 6.1 Hourly Leave Request Submission
  await test('POST /api/leave-requests supports hourly leave (10:00 - 11:00)', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/leave-requests',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      employeeId: 'EMP-002',
      leaveType: 'Personal',
      startDate: '2026-10-20',
      durationType: 'HOURLY',
      startTime: '10:00',
      endTime: '11:00',
      reason: 'ไปติดต่อราชการ 1 ชม.'
    });

    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`Failed to create hourly request: ${JSON.stringify(res.data)}`);
    }

    if (res.data.request.duration_type !== 'HOURLY' || String(res.data.request.hours_count) !== '1.00') {
      throw new Error(`Invalid hourly request payload: ${JSON.stringify(res.data)}`);
    }
  });

  // 7. Supervisor Pending List
  await test('GET /api/leave-requests?status=PENDING lists requests', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/leave-requests?status=PENDING',
      method: 'GET'
    });

    if (res.status !== 200 || !Array.isArray(res.data.requests)) {
      throw new Error(`Failed to list pending requests: ${JSON.stringify(res.data)}`);
    }
  });

  // 8. Supervisor Review API (Approve)
  await test('PATCH /api/leave-requests/:id/status allows supervisor to approve', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/leave-requests/1/status',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }
    }, {
      status: 'APPROVED',
      reviewedBy: 'SUP-001'
    });

    if (res.status !== 200 || !res.data.success) {
      throw new Error(`Failed to approve request: ${JSON.stringify(res.data)}`);
    }
  });

  // 9. Supervisor Review API unauthorized check
  await test('PATCH /api/leave-requests/:id/status rejects non-supervisor review', async () => {
    const res = await request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/leave-requests/1/status',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }
    }, {
      status: 'APPROVED',
      reviewedBy: 'EMP-001'
    });

    if (res.status !== 403) {
      throw new Error(`Expected status 403, got ${res.status}`);
    }
  });

  console.log(`\n🏁 Test Results: ${passed}/${total} passed`);
  process.exit(passed === total ? 0 : 1);
}

runTests();
