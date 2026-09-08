const http = require('http');
const assert = require('assert');

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const opts = { ...options, headers: { ...(options.headers || {}) } };
    let payload = null;
    if (data !== null && data !== undefined) {
      payload = typeof data === 'string' ? data : JSON.stringify(data);
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { parsed = body; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runDepartmentIsolationTest() {
  console.log('🧪 Starting Department Isolation & Supervisor Visibility Tests...\n');

  process.env.PORT = 3888;
  const app = require('../src/server.js');
  await new Promise(r => setTimeout(r, 600));

  const host = '127.0.0.1';
  const port = 3888;

  const { pool } = require('../src/db');
  if (pool) {
    await pool.query("DELETE FROM leave_requests WHERE start_date = '2026-11-25'").catch(() => {});
  }

  // 1. Submit a leave request for EMP-002 (Department: Assembly)
  const reqAssembly = await request({
    host, port, path: '/api/leave-requests', method: 'POST'
  }, {
    employeeId: 'EMP-002',
    leaveType: 'Vacation',
    startDate: '2026-11-25',
    endDate: '2026-11-25',
    reason: 'Assembly test vacation'
  });
  console.log('Submit Assembly Request result:', reqAssembly.status);
  assert.strictEqual(reqAssembly.status, 201);

  // 2. Submit a leave request for 051057 (Department: AUTO)
  const reqAuto = await request({
    host, port, path: '/api/leave-requests', method: 'POST'
  }, {
    employeeId: '051057',
    leaveType: 'Vacation',
    startDate: '2026-11-25',
    endDate: '2026-11-25',
    reason: 'AUTO dept test vacation'
  });
  console.log('Submit AUTO Request result:', reqAuto.status);
  assert.strictEqual(reqAuto.status, 201);

  // 3. Test: Supervisor of 'AUTO' queries pending requests with department=AUTO
  const autoSupRes = await request({
    host, port, path: '/api/leave-requests?status=PENDING&department=AUTO', method: 'GET'
  });
  assert.strictEqual(autoSupRes.status, 200);
  assert(Array.isArray(autoSupRes.body.requests));
  const autoRequests = autoSupRes.body.requests;

  // All returned requests must be from AUTO
  autoRequests.forEach(r => {
    assert.strictEqual(r.department.toUpperCase(), 'AUTO', `Expected department AUTO but got ${r.department} for employee ${r.employee_id}`);
  });
  console.log('✅ [PASS] Supervisor in AUTO only sees AUTO department requests');

  // 4. Test: Supervisor of 'Assembly' queries pending requests with department=Assembly
  const assemblySupRes = await request({
    host, port, path: '/api/leave-requests?status=PENDING&department=Assembly', method: 'GET'
  });
  assert.strictEqual(assemblySupRes.status, 200);
  const assemblyRequests = assemblySupRes.body.requests;

  // All returned requests must be from Assembly
  assemblyRequests.forEach(r => {
    assert.strictEqual(r.department.toUpperCase(), 'ASSEMBLY', `Expected department Assembly but got ${r.department} for employee ${r.employee_id}`);
  });
  console.log('✅ [PASS] Supervisor in Assembly only sees Assembly department requests');

  // 5. Test: Supervisor queries with supervisor_id=038012 (DB lookup for AUTO supervisor)
  const supIdRes = await request({
    host, port, path: '/api/leave-requests?status=PENDING&supervisor_id=038012', method: 'GET'
  });
  assert.strictEqual(supIdRes.status, 200);
  supIdRes.body.requests.forEach(r => {
    assert.strictEqual(r.department.toUpperCase(), 'AUTO');
  });
  console.log('✅ [PASS] Query with supervisor_id resolves supervisor department and isolates correctly');

  // 6. Test: Clean up test requests
  if (pool) {
    await pool.query("DELETE FROM leave_requests WHERE start_date = '2026-11-25'").catch(() => {});
  }

  console.log('\n🎉 ALL DEPARTMENT ISOLATION TESTS PASSED 100%!');
  process.exit(0);
}

runDepartmentIsolationTest().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
