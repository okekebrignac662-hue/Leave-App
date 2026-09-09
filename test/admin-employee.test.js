const assert = require('assert');
const http = require('http');

process.env.PORT = 3777;
const app = require('../src/server');
const { pool } = require('../src/db');

function request(options, postData = null) {
  return new Promise((resolve, reject) => {
    const opts = { ...options, headers: { ...(options.headers || {}) } };
    let payload = null;
    if (postData !== null && postData !== undefined) {
      payload = typeof postData === 'string' ? postData : JSON.stringify(postData);
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function runAdminEmployeeTest() {
  console.log('🧪 Testing Admin & Add Employee Functionality...');
  await new Promise(r => setTimeout(r, 600));

  const host = '127.0.0.1';
  const port = 3777;

  try {
    // 1. Test GET /api/departments
    console.log('1️⃣  Testing GET /api/departments...');
    const deptRes = await request({ host, port, path: '/api/departments', method: 'GET' });
    assert.strictEqual(deptRes.status, 200);
    assert.strictEqual(deptRes.body.success, true);
    assert(Array.isArray(deptRes.body.departments));
    const deptNames = deptRes.body.departments.map(d => d.name);
    console.log('   Found departments:', deptNames);
    assert(deptNames.includes('Crimping 1'), 'Expected departments to include Crimping 1');
    console.log('✅ [PASS] GET /api/departments returns departments including Crimping 1');

    // 2. Test Admin Login
    console.log('2️⃣  Testing Admin Login (ADMIN-001)...');
    const adminLoginRes = await request({ host, port, path: '/api/login', method: 'POST' }, {
      empId: 'ADMIN-001',
      pin: '1234'
    });
    assert.strictEqual(adminLoginRes.status, 200);
    assert.strictEqual(adminLoginRes.body.success, true);
    assert.strictEqual(adminLoginRes.body.user.isAdmin, true);
    assert.strictEqual(adminLoginRes.body.user.isSupervisor, true);
    assert.strictEqual(adminLoginRes.body.user.role, 'ADMIN');
    console.log('✅ [PASS] Admin login returns isAdmin=true and role=ADMIN');

    // 3. Test Non-Admin cannot add employee
    console.log('3️⃣  Testing Non-Admin cannot add employee...');
    const forbiddenRes = await request({ host, port, path: '/api/employees', method: 'POST' }, {
      adminId: 'EMP-001',
      id: 'TEST-EMP-999',
      name: 'Test Employee',
      department: 'Crimping 1'
    });
    assert.strictEqual(forbiddenRes.status, 403);
    console.log('✅ [PASS] Non-Admin blocked with 403 Forbidden');

    // 4. Test Admin can add new employee with department Crimping 1
    console.log('4️⃣  Testing Admin adding new employee with department Crimping 1...');
    const testEmpId = 'TEST-EMP-001';
    if (pool) {
      await pool.query('DELETE FROM employees WHERE UPPER(id) = $1', [testEmpId]).catch(() => {});
    }

    const addEmpRes = await request({ host, port, path: '/api/employees', method: 'POST' }, {
      adminId: 'ADMIN-001',
      id: testEmpId,
      name: 'นายทดสอบ ระบบใหม่',
      department: 'Crimping 1',
      role: 'EMPLOYEE',
      pin: '5678',
      vacation_quota: 6,
      personal_quota: 6,
      sick_quota: 30
    });
    assert.strictEqual(addEmpRes.status, 201);
    assert.strictEqual(addEmpRes.body.success, true);
    assert.strictEqual(addEmpRes.body.employee.id, testEmpId);
    assert.strictEqual(addEmpRes.body.employee.department, 'Crimping 1');
    console.log('✅ [PASS] Admin successfully added employee into Crimping 1');

    // 5. Test New Employee can Login
    console.log('5️⃣  Testing new employee login...');
    const newEmpLogin = await request({ host, port, path: '/api/login', method: 'POST' }, {
      empId: testEmpId,
      pin: '5678'
    });
    assert.strictEqual(newEmpLogin.status, 200);
    assert.strictEqual(newEmpLogin.body.user.name, 'นายทดสอบ ระบบใหม่');
    assert.strictEqual(newEmpLogin.body.user.department, 'Crimping 1');
    console.log('✅ [PASS] Newly added employee logged in successfully');

    // 6. Test Duplicate Employee ID blocked
    console.log('6️⃣  Testing Duplicate Employee ID rejection...');
    const dupRes = await request({ host, port, path: '/api/employees', method: 'POST' }, {
      adminId: 'ADMIN-001',
      id: testEmpId,
      name: 'Duplicate Test',
      department: 'Crimping 1'
    });
    assert.strictEqual(dupRes.status, 409);
    console.log('✅ [PASS] Duplicate employee ID rejected with 409 Conflict');

    // Clean up
    if (pool) {
      await pool.query('DELETE FROM employees WHERE UPPER(id) = $1', [testEmpId]).catch(() => {});
    }

    console.log('\n🎉 ALL ADMIN & EMPLOYEE MANAGEMENT TESTS PASSED 100%!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  }
}

runAdminEmployeeTest();
