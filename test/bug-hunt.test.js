/**
 * test/bug-hunt.test.js
 * Comprehensive Bug-Hunting & Edge-Case Verification Suite
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

let app;
let server;
const PORT = 3996;
const BASE_URL = `http://localhost:${PORT}`;

function makeRequest(reqPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${reqPath}`;
    const parsed = new URL(url);

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(reqOptions, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch (e) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          json
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      const data = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      req.write(data);
    }
    req.end();
  });
}

async function runBugHuntTests() {
  console.log('\n🐛 Starting Comprehensive Bug-Hunting & Edge-Case Verification Suite...\n');
  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${message}`);
      process.exitCode = 1;
    }
  }

  try {
    // 1. Static code verification on index.html
    console.log('1️⃣  Static DOM & JavaScript Function Linkage Verification...');
    const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
    assert(!htmlContent.includes('openAttachmentModal'), 'Bug Fixed: openAttachmentModal undefined function removed');
    assert(htmlContent.includes('id="sheets-badge-status"'), 'Bug Fixed: #sheets-badge-status ID is present on status dot');

    // 2. Start server
    console.log('\n2️⃣  Starting test server on port ' + PORT + '...');
    process.env.PORT = PORT;
    const googleSheetsService = require('../src/googleSheetsService');
    googleSheetsService.syncLeaveRequestAsync = () => {};
    googleSheetsService.syncEmployeeAsync = () => {};

    const serverModule = require('../src/server.js');
    app = serverModule.app;
    server = serverModule.server;
    await new Promise((r) => setTimeout(r, 1000));

    // 3. Setup test employee
    console.log('\n3️⃣  Setting up test employee in isolated department...');
    const testEmpId = `EMP-BH${Date.now().toString().slice(-4)}`;
    const testTarId = `EMP-BHT${Date.now().toString().slice(-4)}`;
    const testDept = `BugDept_${Date.now().toString().slice(-4)}`;

    await makeRequest('/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        adminId: 'ADMIN-001',
        empId: testEmpId,
        name: 'สมปอง ทดสอบบัค',
        department: testDept,
        shift: 'A',
        role: 'EMPLOYEE',
        pin: '1234',
        vacation_quota: 10,
        personal_quota: 6,
        sick_quota: 30
      }
    });

    await makeRequest('/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        adminId: 'ADMIN-001',
        empId: testTarId,
        name: 'สมชาย เพื่อนร่วมงาน',
        department: testDept,
        shift: 'B',
        role: 'EMPLOYEE',
        pin: '1234',
        vacation_quota: 10,
        personal_quota: 6,
        sick_quota: 30
      }
    });

    // Create a valid future leave request
    const createReqRes = await makeRequest('/api/leave-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        employeeId: testEmpId,
        leaveType: 'Vacation',
        startDate: '2029-06-10',
        endDate: '2029-06-11',
        durationType: 'FULL_DAY',
        reason: 'ลาพักร้อนล่วงหน้า'
      }
    });
    assert(createReqRes.status === 201 && createReqRes.json && createReqRes.json.success, 'Initial leave request created');
    const leaveId = createReqRes.json.request.id;

    // 4. Test Bug Fix: Attempt to edit Vacation leave to a past date
    console.log('\n4️⃣  Testing Past Date Injection via PUT /api/leave-requests/:id...');
    const pastEditRes = await makeRequest(`/api/leave-requests/${leaveId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: {
        employeeId: testEmpId,
        leaveType: 'Vacation',
        startDate: '2020-01-01',
        endDate: '2020-01-02',
        durationType: 'FULL_DAY',
        reason: 'พยายามแก้ไขเป็นวันที่ในอดีต'
      }
    });
    assert(pastEditRes.status === 400, 'Editing Vacation leave to past date returns 400 Bad Request');
    assert(pastEditRes.json.error && pastEditRes.json.error.includes('อดีต'), 'Error explains past dates cannot be selected for Vacation');

    // 5. Test Bug Fix: Attempt to edit leave with invalid date format
    console.log('\n5️⃣  Testing Invalid Date Syntax via PUT /api/leave-requests/:id...');
    const invalidDateRes = await makeRequest(`/api/leave-requests/${leaveId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: {
        employeeId: testEmpId,
        leaveType: 'Vacation',
        startDate: 'not-a-valid-date',
        endDate: 'invalid-date',
        durationType: 'FULL_DAY',
        reason: 'ทดสอบใส่วันที่ผิดรูปแบบ'
      }
    });
    assert(invalidDateRes.status === 400, 'Editing leave with invalid date format returns 400 Bad Request');

    // 6. Test Bug Fix: Shift swap with past date blocked
    console.log('\n6️⃣  Testing Shift Swap Past Date Validation...');
    const pastSwapRes = await makeRequest('/api/shift-swaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        requesterId: testEmpId,
        targetEmployeeId: testTarId,
        requesterDate: '2020-05-01',
        requesterShift: 'A',
        targetDate: '2020-05-02',
        targetShift: 'B',
        reason: 'แลกกะย้อนหลัง'
      }
    });
    assert(pastSwapRes.status === 400, 'Shift swap with past dates returns 400 Bad Request');
    assert(pastSwapRes.json.error && pastSwapRes.json.error.includes('อดีต'), 'Error explains past dates cannot be swapped');

    // 7. Test Bug Fix: Shift swap on same date and same shift blocked
    console.log('\n7️⃣  Testing Shift Swap on Same Date and Same Shift...');
    const sameSwapRes = await makeRequest('/api/shift-swaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        requesterId: testEmpId,
        targetEmployeeId: testTarId,
        requesterDate: '2029-07-15',
        requesterShift: 'A',
        targetDate: '2029-07-15',
        targetShift: 'A',
        reason: 'แลกกะกะเดียวกันวันเดียวกัน'
      }
    });
    assert(sameSwapRes.status === 400, 'Same day same shift swap returns 400 Bad Request');

    // 8. Test Bug Fix: Shift swap conflict with active leave
    console.log('\n8️⃣  Testing Shift Swap conflict when colleague has active leave...');
    // testEmpId has approved leave on 2029-06-10
    // Try to swap targetDate to 2029-06-10 (which testEmpId cannot work because of leave)
    const conflictSwapRes = await makeRequest('/api/shift-swaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        requesterId: testEmpId,
        targetEmployeeId: testTarId,
        requesterDate: '2029-07-20',
        requesterShift: 'A',
        targetDate: '2029-06-10', // testEmpId is already on leave!
        targetShift: 'B',
        reason: 'ขอแลกกะในวันที่ตัวเองลาอยู่'
      }
    });
    assert(conflictSwapRes.status === 400, 'Shift swap on a date with active leave returns 400 Bad Request');
    assert(conflictSwapRes.json.error && conflictSwapRes.json.error.includes('ลางาน'), 'Error explains colleague/employee is on leave');

    console.log(`\n=========================================`);
    console.log(`Summary: ${passed}/${total} assertions passed.`);
    console.log(`=========================================\n`);

    if (passed === total) {
      console.log('🎉 All Bug-Hunting & Edge-Case Verification Tests PASSED!\n');
    } else {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('Test error:', err);
    process.exitCode = 1;
  } finally {
    if (server && server.close) {
      server.close();
    }
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  }
}

runBugHuntTests();
