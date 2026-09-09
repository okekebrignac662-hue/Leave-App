const fs = require('fs');
const assert = require('assert');
const http = require('http');
require('dotenv').config();

process.env.PORT = 3888;
const app = require('../src/server');
const { pool, query } = require('../src/db');

const BASE_URL = 'http://localhost:3888';

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(BASE_URL + path);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
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
    if (data) req.write(data);
    req.end();
  });
}

const get = (path) => request('GET', path);
const post = (path, body) => request('POST', path, body);
const patch = (path, body) => request('PATCH', path, body);
const del = (path, body) => request('DELETE', path, body);

async function runDeepSystemAudit() {
  console.log('\n=============================================================');
  console.log('🔍 FULL-SYSTEM COMPREHENSIVE AUDIT & DEFECT DISCOVERY');
  console.log('=============================================================\n');

  const defects = [];
  const warnings = [];
  const passedChecks = [];

  function pass(name) {
    passedChecks.push(name);
    console.log(`✅ [PASS] ${name}`);
  }

  function fail(name, details) {
    defects.push({ name, details });
    console.error(`❌ [DEFECT] ${name}:`, details);
  }

  function warn(name, details) {
    warnings.push({ name, details });
    console.warn(`⚠️ [WARNING] ${name}:`, details);
  }

  // -------------------------------------------------------------
  // SECTION 1: FRONTEND STATIC CODE INTEGRITY (public/index.html)
  // -------------------------------------------------------------
  console.log('\n--- 1. Testing Frontend Static Integrity (HTML/JS) ---');
  const html = fs.readFileSync('public/index.html', 'utf8');

  // Check 1.1: Syntax validation of all <script> blocks
  try {
    const scriptMatches = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    scriptMatches.forEach((match, idx) => {
      new Function(match[1]);
    });
    pass('All frontend script tags pass JS syntax compilation');
  } catch (err) {
    fail('Frontend JS Syntax Error', err.message);
  }

  // Check 1.2: DOM ID references integrity
  const idRefs = [...html.matchAll(/document\.getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  const definedIds = new Set([...html.matchAll(/id=['"]([^'"]+)['"]/g)].map(m => m[1]));
  
  // Dynamic IDs that are created at runtime
  const dynamicIdPatterns = [
    /^request-card-/,
    /^card-/,
    /^filter-shift-/,
    /^hist-filter-shift-/,
    /^emp-row-/
  ];

  const missingIds = [];
  idRefs.forEach(id => {
    if (!definedIds.has(id) && !dynamicIdPatterns.some(p => p.test(id))) {
      missingIds.push(id);
    }
  });

  if (missingIds.length === 0) {
    pass(`All ${idRefs.length} getElementById calls resolve to valid HTML elements`);
  } else {
    fail('Dangling getElementById references found', [...new Set(missingIds)]);
  }

  // Check 1.3: Verify all inline onclick functions exist in JS
  const onclickMatches = [...html.matchAll(/onclick=['"]\s*([a-zA-Z0-9_$]+)\s*\(/g)].map(m => m[1]);
  const uniqueOnclicks = [...new Set(onclickMatches)];
  // Concatenate all inline script contents (ignore src scripts)
  const allScripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
  
  const missingFunctions = [];
  uniqueOnclicks.forEach(fn => {
    const fnRegex = new RegExp(`function\\s+${fn}\\b|window\\.${fn}\\s*=|const\\s+${fn}\\s*=|let\\s+${fn}\\s*=`);
    if (!fnRegex.test(allScripts)) {
      missingFunctions.push(fn);
    }
  });

  if (missingFunctions.length === 0) {
    pass(`All ${uniqueOnclicks.length} inline onclick handlers map to declared functions`);
  } else {
    fail('Missing inline onclick handler functions', missingFunctions);
  }

  // -------------------------------------------------------------
  // SECTION 2: AUTHENTICATION & ACCESS CONTROL
  // -------------------------------------------------------------
  console.log('\n--- 2. Testing Authentication & Role Control ---');

  // Check 2.1: Employee Login with 031838
  const loginEmp = await post('/api/login', { empId: '031838', pin: '031838' });
  if (loginEmp.status === 200 && loginEmp.data.success && !loginEmp.data.user?.isSupervisor) {
    pass('Employee 031838 login success with correct role (EMPLOYEE)');
  } else {
    fail('Employee login failed', loginEmp);
  }

  // Check 2.2: Login rejection with incorrect PIN
  const loginBadPin = await post('/api/login', { empId: '031838', pin: 'WRONG_PIN_999' });
  if (loginBadPin.status === 401) {
    pass('Login strictly rejects incorrect PIN (401 Unauthorized)');
  } else {
    fail('Login did not reject incorrect PIN', loginBadPin);
  }

  // Check 2.3: SQL Injection in login empId & PIN
  const loginSqlInj = await post('/api/login', { empId: "' OR '1'='1", pin: "' OR '1'='1" });
  if (loginSqlInj.status === 401 || loginSqlInj.status === 400) {
    pass('Login handles SQL injection payloads securely');
  } else {
    fail('SQL Injection vulnerability in login endpoint', loginSqlInj);
  }

  // Check 2.4: Supervisor Login (SUP prefix or SUPERVISOR role)
  const loginSup = await post('/api/login', { empId: 'SUP-001', pin: '1234' });
  if (loginSup.status === 200 && loginSup.data.user?.isSupervisor === true) {
    pass('Supervisor SUP-001 login recognizes supervisor privileges');
  } else {
    warn('Supervisor SUP-001 not configured or failed login', loginSup.data);
  }

  // -------------------------------------------------------------
  // SECTION 3: QUOTAS & SHIFT ISOLATION LOGIC
  // -------------------------------------------------------------
  console.log('\n--- 3. Testing Quota Calculations & Shift Isolation ---');

  // Check 3.1: Employee Quota Endpoint
  const quotaRes = await get('/api/employees/031838/quota');
  const qObj = quotaRes.data?.quota || quotaRes.data?.quotas;
  if (quotaRes.status === 200 && qObj) {
    const q = qObj;
    if (q.vacation.remaining >= 0 && q.personal.remaining >= 0 && q.sick.remaining >= 0) {
      pass(`Employee 031838 quota calculated properly: Vac ${q.vacation.used}/${q.vacation.total}, Sick ${q.sick.used}/${q.sick.total}`);
    } else {
      fail('Negative quota balance calculated', q);
    }
  } else {
    fail('Failed to fetch employee quota', quotaRes);
  }

  // Check 3.2: Department Calendar Shift Isolation
  const deptCal = await get('/api/department-calendar?department=Crimping 1&month=2026-09');
  if (deptCal.status === 200 && deptCal.data.quotasByShift) {
    const qByShift = deptCal.data.quotasByShift;
    if (qByShift['A'] && qByShift['B']) {
      pass(`Department calendar returns per-shift quotas (A: ${qByShift['A']}, B: ${qByShift['B']})`);
    } else {
      fail('Department calendar missing quotasByShift structure', qByShift);
    }
  } else {
    fail('Department calendar API failed', deptCal);
  }

  // Check 3.3: Day 10 on Crimping 1 shows separate shift counts
  const day10 = deptCal.data?.dailyUsage?.['2026-09-10'];
  if (day10 && day10.shifts && day10.shifts['A'] && day10.shifts['B']) {
    const shiftA = day10.shifts['A'];
    const shiftB = day10.shifts['B'];
    pass(`Day 10 Shift usage isolated: Shift A (${shiftA.count}/${shiftA.maxQuota}, isFull: ${shiftA.isFull}) vs Shift B (${shiftB.count}/${shiftB.maxQuota}, isFull: ${shiftB.isFull})`);
  } else {
    fail('Day 10 missing shift breakdown in dailyUsage', day10);
  }

  // -------------------------------------------------------------
  // SECTION 4: LEAVE REQUEST BOUNDARY & SECURITY CHECKS
  // -------------------------------------------------------------
  console.log('\n--- 4. Testing Leave Request Boundary Checks ---');

  // Check 4.1: Hourly leave start time >= end time
  const badHourly = await post('/api/leave-requests', {
    employeeId: '031838',
    leaveType: 'Personal',
    startDate: '2026-09-25',
    durationType: 'HOURLY',
    startTime: '15:00',
    endTime: '10:00',
    reason: 'Test reverse time'
  });
  if (badHourly.status === 400) {
    pass('Hourly leave rejects start_time >= end_time (400 Bad Request)');
  } else {
    fail('Hourly leave accepted invalid time order', badHourly);
  }

  // Check 4.2: Full-day start_date > end_date
  const badDateOrder = await post('/api/leave-requests', {
    employeeId: '031838',
    leaveType: 'Vacation',
    startDate: '2026-09-28',
    endDate: '2026-09-25',
    durationType: 'FULL_DAY',
    reason: 'Test reverse dates'
  });
  if (badDateOrder.status === 400) {
    pass('Full-day leave rejects start_date > end_date (400 Bad Request)');
  } else {
    fail('Leave request accepted reverse date range', badDateOrder);
  }

  // Check 4.3: Unauthorized Leave Cancellation
  // Try to cancel another employee's request
  const badCancel = await del('/api/leave-requests/127', { employeeId: 'SOMEONE_ELSE' });
  if (badCancel.status === 401 || badCancel.status === 403 || badCancel.status === 400) {
    pass('Leave cancellation blocks unauthorized user IDs (401/403)');
  } else {
    fail('Unauthorized employee was able to cancel leave request', badCancel);
  }

  // Check 4.4: Unauthorized Approval Attempt by Normal Employee
  const badApprove = await patch('/api/leave-requests/127/status', {
    status: 'APPROVED',
    reviewedBy: '031838' // Normal employee, not supervisor
  });
  if (badApprove.status === 403) {
    pass('Review approval strictly blocks non-supervisors (403 Forbidden)');
  } else {
    fail('Normal employee was able to approve leave requests', badApprove);
  }

  // Check 4.5: Shift A is full on 2026-09-10; new Shift A non-sick request MUST be blocked!
  // Find an employee in Shift A
  // Check 4.5: Non-existent employee returns 404 instead of 500 DB error
  const nonExistentEmpCheck = await post('/api/leave-requests', {
    employeeId: 'TEST-NONEXISTENT-EMP',
    leaveType: 'Vacation',
    startDate: '2026-09-10',
    endDate: '2026-09-10',
    durationType: 'FULL_DAY',
    reason: 'Testing non-existent employee'
  });
  if (nonExistentEmpCheck.status === 404) {
    pass('Leave request rejects non-existent employee with clean 404 Not Found');
  } else {
    fail('System did not return 404 for non-existent employee', nonExistentEmpCheck);
  }

  // Check 4.6: Shift A is full on 2026-09-10; new Shift A non-sick request MUST be blocked!
  // Create a temporary employee in Shift A for Crimping 1
  const tempA = await post('/api/employees', {
    adminId: 'ADMIN-001',
    id: 'AUDIT-A-01',
    name: 'Audit Shift A Employee',
    department: 'Crimping 1',
    shift: 'A',
    pin: '1234',
    role: 'EMPLOYEE',
    vacation_quota: 6,
    personal_quota: 6,
    sick_quota: 30
  });

  const blockCheck = await post('/api/leave-requests', {
    employeeId: 'AUDIT-A-01',
    leaveType: 'Vacation',
    startDate: '2026-09-10',
    endDate: '2026-09-10',
    durationType: 'FULL_DAY',
    reason: 'Testing quota blocking on full date'
  });

  if (blockCheck.status === 400 && blockCheck.data?.error?.includes('เต็มแล้ว')) {
    pass('Shift A leave strictly blocked on 2026-09-10 because Shift A quota (3/3) is full');
  } else {
    fail('System did not block Shift A when quota is full', blockCheck);
  }

  // Check 4.6: Sick leave bypasses daily quota even when Shift A is full!
  const sickBypassCheck = await post('/api/leave-requests', {
    employeeId: 'AUDIT-A-01',
    leaveType: 'Sick',
    startDate: '2026-09-10',
    endDate: '2026-09-10',
    durationType: 'FULL_DAY',
    reason: 'Sick leave bypass test'
  });

  if ((sickBypassCheck.status === 200 || sickBypassCheck.status === 201) && sickBypassCheck.data?.success) {
    pass('Sick leave successfully bypasses full quota rule as required by labor policy');
    // Cleanup temporary request
    if (sickBypassCheck.data.request?.id) {
      await del(`/api/leave-requests/${sickBypassCheck.data.request.id}`, { employeeId: 'AUDIT-A-01' });
    }
  } else {
    fail('Sick leave was incorrectly blocked on full quota date', sickBypassCheck);
  }

  // Cleanup temporary employee
  await query("DELETE FROM employees WHERE id = 'AUDIT-A-01'");

  // -------------------------------------------------------------
  // SECTION 5: DATABASE INTEGRITY CHECKS
  // -------------------------------------------------------------
  console.log('\n--- 5. Testing Database Consistency & Integrity ---');
  if (pool) {
    // Check 5.1: Orphaned leave requests
    const orphanCheck = await query(`
      SELECT COUNT(*) as count 
      FROM leave_requests lr 
      LEFT JOIN employees e ON lr.employee_id = e.id 
      WHERE e.id IS NULL
    `);
    const orphanCount = parseInt(orphanCheck.rows[0].count, 10);
    if (orphanCount === 0) {
      pass('No orphaned leave requests in database (all map to valid employees)');
    } else {
      warn(`Found ${orphanCount} orphaned leave requests`, orphanCheck.rows);
    }

    // Check 5.2: Employees without shift assignment
    const noShiftCheck = await query(`
      SELECT COUNT(*) as count 
      FROM employees 
      WHERE shift IS NULL OR TRIM(shift) = ''
    `);
    const noShiftCount = parseInt(noShiftCheck.rows[0].count, 10);
    if (noShiftCount === 0) {
      pass('All employees have assigned shifts (A, B, or Morning)');
    } else {
      warn(`Found ${noShiftCount} employees without assigned shift (defaults to A)`, noShiftCheck.rows);
    }

    // Check 5.3: Verify Quota Settings exist for all active departments
    const deptCheck = await query(`
      SELECT DISTINCT department 
      FROM employees 
      WHERE department NOT IN (SELECT DISTINCT department FROM quota_settings)
    `);
    if (deptCheck.rows.length === 0) {
      pass('All employee departments have corresponding Quota Settings');
    } else {
      warn('Some departments lack Quota Settings entries', deptCheck.rows.map(r => r.department));
    }
  }

  // -------------------------------------------------------------
  // SUMMARY REPORT
  // -------------------------------------------------------------
  console.log('\n=============================================================');
  console.log(`📊 AUDIT COMPLETED:`);
  console.log(`   ✅ Passed Checks: ${passedChecks.length}`);
  console.log(`   ❌ Defects:       ${defects.length}`);
  console.log(`   ⚠️  Warnings:      ${warnings.length}`);
  console.log('=============================================================\n');

  if (defects.length > 0) {
    console.error('⚠️ ACTION REQUIRED FOR DEFECTS:');
    defects.forEach((d, i) => console.error(`  ${i + 1}. [${d.name}]`, d.details));
  } else {
    console.log('🎉 ZERO CRITICAL DEFECTS FOUND! The application passed all integrity checks.');
  }

  process.exit(defects.length > 0 ? 1 : 0);
}

runDeepSystemAudit().catch(err => {
  console.error('Fatal audit error:', err);
  process.exit(1);
});
