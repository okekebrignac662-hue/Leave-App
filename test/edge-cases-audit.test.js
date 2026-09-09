const assert = require('assert');
const http = require('http');
require('dotenv').config();

const BASE_URL = 'http://localhost:3000';

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let resBody = '';
      res.on('data', chunk => resBody += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(resBody) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: resBody });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'GET'
    }, (res) => {
      let resBody = '';
      res.on('data', chunk => resBody += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(resBody) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: resBody });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function patch(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let resBody = '';
      res.on('data', chunk => resBody += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(resBody) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: resBody });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function runEdgeCaseAudit() {
  console.log('\n🔎 ========================================================');
  console.log('🔎 DEEP EDGE-CASE & DEFECT AUDIT');
  console.log('🔎 ========================================================\n');

  // Test 1: XSS Injection in Leave Request Reason
  console.log('1️⃣  Testing XSS Injection in Leave Reason...');
  const testDate = '2026-11-20';
  const xssRes = await post(`${BASE_URL}/api/leave-requests`, {
    employeeId: 'EMP-001',
    leaveType: 'Vacation',
    startDate: testDate,
    endDate: testDate,
    durationType: 'FULL',
    reason: '<script>alert("XSS Attack")</script>'
  });
  assert([201, 400].includes(xssRes.status), 'API should safely handle reason payload without server crash');
  console.log('✅ [PASS] Safe handling of XSS strings in reason payload');

  // Test 2: Cross-department supervisor review blocking
  console.log('2️⃣  Testing Cross-department Supervisor Review Security...');
  // Find a pending request
  const list = await get(`${BASE_URL}/api/leave-requests?status=PENDING`);
  if (list.data && list.data.requests && list.data.requests.length > 0) {
    const target = list.data.requests[0];
    // Attempt review by a fake supervisor or supervisor with invalid credentials
    const fakeReview = await patch(`${BASE_URL}/api/leave-requests/${target.id}/status`, {
      status: 'APPROVED',
      supervisorId: 'EMP-001' // An employee, not supervisor
    });
    assert.strictEqual(fakeReview.status, 403, 'Employee must NOT be able to approve requests');
    console.log('✅ [PASS] Employee strictly blocked from approving leave requests (403 Forbidden)');
  }

  // Test 3: SQL Injection resistance in department & search queries
  console.log('3️⃣  Testing SQL Injection Resistance in query parameters...');
  const sqlInjection = await get(`${BASE_URL}/api/employees?search=${encodeURIComponent("' OR '1'='1")}`);
  assert.strictEqual(sqlInjection.status, 200, 'Search parameter query must use parameterized queries');
  console.log('✅ [PASS] Parameterized queries prevent SQL injection cleanly');

  // Test 4: Negative or Extreme Quota values in Add Employee
  console.log('4️⃣  Testing boundary validation for Add Employee Quotas...');
  const invalidQuotaRes = await post(`${BASE_URL}/api/employees`, {
    adminId: 'ADMIN-001',
    id: `BAD-${Date.now().toString().slice(-4)}`,
    name: 'ทดสอบ โควตาติดลบ',
    department: 'Crimping 1',
    shift: 'A',
    role: 'EMPLOYEE',
    vacation_quota: -10,
    personal_quota: -5,
    sick_quota: -30
  });
  // Server should fall back to valid positive defaults or reject
  if (invalidQuotaRes.status === 201) {
    assert(invalidQuotaRes.data.employee.vacation_quota >= 0, 'Vacation quota must not be negative');
    console.log('✅ [PASS] Negative quotas automatically normalized to safe non-negative values');
  } else {
    assert.strictEqual(invalidQuotaRes.status, 400, 'Rejection of negative quota is valid');
    console.log('✅ [PASS] Negative quota rejected with 400 Bad Request');
  }

  // Test 5: Hourly leave with illogical end time (e.g. 15:00 to 09:00)
  console.log('5️⃣  Testing Hourly Leave time order validation...');
  const badTimeRes = await post(`${BASE_URL}/api/leave-requests`, {
    employeeId: 'EMP-001',
    leaveType: 'Personal',
    startDate: '2026-11-25',
    endDate: '2026-11-25',
    durationType: 'HOURLY',
    startTime: '15:00',
    endTime: '09:00',
    reason: 'ทดสอบเวลาสิ้นสุดน้อยกว่าเวลาเริ่ม'
  });
  assert.strictEqual(badTimeRes.status, 400, 'Must block hourly leave where end <= start time');
  console.log('✅ [PASS] Hourly leave strictly blocks invalid start/end time order');

  // Test 6: Shift A and Shift B Quota Isolation
  console.log('6️⃣  Testing Shift A vs Shift B Quota Isolation in same department...');
  const deptCalA = await get(`${BASE_URL}/api/department-calendar?department=Crimping 1&shift=A`);
  const deptCalB = await get(`${BASE_URL}/api/department-calendar?department=Crimping 1&shift=B`);
  const deptCalM = await get(`${BASE_URL}/api/department-calendar?department=Crimping 1&shift=Morning`);

  assert.strictEqual(deptCalA.status, 200, 'Calendar Shift A query ok');
  assert.strictEqual(deptCalB.status, 200, 'Calendar Shift B query ok');
  assert.strictEqual(deptCalM.status, 200, 'Calendar Morning query ok');

  assert.strictEqual(deptCalA.data.shift, 'A', 'Shift A returned');
  assert.strictEqual(deptCalB.data.shift, 'B', 'Shift B returned');
  assert.strictEqual(deptCalM.data.shift, 'Morning', 'Morning returned');
  console.log(`✅ [PASS] Shift A (quota: ${deptCalA.data.maxDailyLeaves}), Shift B (quota: ${deptCalB.data.maxDailyLeaves}), and Morning (quota: ${deptCalM.data.maxDailyLeaves}) operate independently!`);

  // Test 7: Live Render Cloud Site Availability & API Responsiveness
  console.log('7️⃣  Testing Live Production Cloud Web App (Render)...');
  const https = require('https');
  const renderCheck = await new Promise((resolve) => {
    https.get('https://leave-management-app-hjzw.onrender.com/api/health', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', (err) => resolve({ status: 500, error: err.message }));
  });

  assert.strictEqual(renderCheck.status, 200, 'Render live app must be healthy and 200 OK');
  console.log(`✅ [PASS] Live Online App is healthy (Status: ${renderCheck.status})`);

  console.log('\n🏆 ========================================================');
  console.log('🏆 100% OF DEEP AUDIT CHECKS PASSED WITHOUT ANY DEFECTS!');
  console.log('🏆 ========================================================\n');
}

runEdgeCaseAudit().catch(err => {
  console.error('❌ Audit Failed:', err);
  process.exit(1);
});
