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

function put(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'PUT',
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

async function runTests() {
  console.log('\n🧪 Testing Shift-Based Quota & Management...\n');

  // 1. Test Login returns shift
  const loginRes = await post(`${BASE_URL}/api/login`, { empId: 'EMP-001', pin: '1234' });
  assert.strictEqual(loginRes.status, 200, 'Login should succeed');
  assert(loginRes.data.user.shift !== undefined, 'User object must contain shift');
  console.log(`✅ [PASS] POST /api/login returns user shift: ${loginRes.data.user.shift}`);

  // 2. Test Admin create employee with Shift B
  const testShiftBId = `SHIFTB-${Date.now().toString().slice(-4)}`;
  const addRes = await post(`${BASE_URL}/api/employees`, {
    adminId: 'ADMIN-001',
    id: testShiftBId,
    name: 'สมชาย กะ B',
    department: 'Crimping 1',
    shift: 'B',
    role: 'EMPLOYEE',
    pin: '1234',
    vacation_quota: 6,
    personal_quota: 6,
    sick_quota: 30
  });
  assert.strictEqual(addRes.status, 201, 'Should create employee in Shift B');
  assert.strictEqual(addRes.data.employee.shift, 'B', 'Created employee must have shift=B');
  console.log(`✅ [PASS] POST /api/employees creates employee [${testShiftBId}] with shift=B`);

  // 3. Test Admin edit employee to Shift A
  const editRes = await put(`${BASE_URL}/api/employees/${testShiftBId}`, {
    adminId: 'ADMIN-001',
    name: 'สมชาย กะ A (ย้ายกะ)',
    department: 'Crimping 1',
    shift: 'A',
    role: 'EMPLOYEE',
    vacation_quota: 6,
    personal_quota: 6,
    sick_quota: 30
  });
  assert.strictEqual(editRes.status, 200, 'Should update employee');
  assert.strictEqual(editRes.data.employee.shift, 'A', 'Updated employee must have shift=A');
  console.log(`✅ [PASS] PUT /api/employees/:id successfully switches employee shift to A`);

  // 3.1 Test Admin create supervisor with Morning shift (เช้าตลอด)
  const testSupId = `SUP-${Date.now().toString().slice(-4)}`;
  const addSupRes = await post(`${BASE_URL}/api/employees`, {
    adminId: 'ADMIN-001',
    id: testSupId,
    name: 'สมเกียรติ เช้าตลอด (หัวหน้างาน)',
    department: 'Crimping 1',
    shift: 'Morning',
    role: 'SUPERVISOR',
    pin: '1234',
    vacation_quota: 10,
    personal_quota: 6,
    sick_quota: 30
  });
  assert.strictEqual(addSupRes.status, 201, 'Should create supervisor with Morning shift');
  assert.strictEqual(addSupRes.data.employee.shift, 'Morning', 'Created supervisor must have shift=Morning');
  console.log(`✅ [PASS] POST /api/employees creates supervisor [${testSupId}] with shift=Morning (เช้าตลอด)`);

  // 4. Test GET /api/employees lists shift
  const listRes = await get(`${BASE_URL}/api/employees?department=Crimping 1`);
  assert.strictEqual(listRes.status, 200, 'Should list employees');
  const found = listRes.data.employees.find(e => e.id === testShiftBId);
  assert(found && found.shift === 'A', 'Listed employee must have shift attribute');
  console.log(`✅ [PASS] GET /api/employees includes shift attribute`);

  // 5. Test Leave Requests return shift
  const reqsRes = await get(`${BASE_URL}/api/leave-requests?status=ALL`);
  assert.strictEqual(reqsRes.status, 200, 'Should list requests');
  if (reqsRes.data.requests.length > 0) {
    assert(reqsRes.data.requests[0].shift !== undefined, 'Leave request must include shift');
    console.log(`✅ [PASS] GET /api/leave-requests returns shift on requests`);
  }

  // 6. Test Department Calendar with Shift B
  const calRes = await get(`${BASE_URL}/api/department-calendar?department=Crimping 1&shift=B`);
  assert.strictEqual(calRes.status, 200, 'Should return department calendar');
  assert.strictEqual(calRes.data.shift, 'B', 'Calendar response must reflect queried shift');
  console.log(`✅ [PASS] GET /api/department-calendar handles shift=B query param`);

  console.log('\n🎉 ALL SHIFT-BASED QUOTA TESTS PASSED 100%!\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
