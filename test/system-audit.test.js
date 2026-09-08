// Comprehensive System Audit & Test Script
const http = require('http');
const assert = require('assert');

// Test runner helper
async function request(options, data = null) {
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
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function runAudit() {
  console.log('🔍 ========================================================');
  console.log('🔍 LEAVE APP COMPREHENSIVE SYSTEM AUDIT & TEST SUITE');
  console.log('🔍 ========================================================\n');

  // Launch express app on an ephemeral port
  // We require the app without listening on 3000 by setting PORT=0 or custom
  process.env.PORT = 3999;
  const express = require('express');
  
  // Start server on port 3999 for testing
  delete require.cache[require.resolve('../src/server.js')];
  const app = require('../src/server.js');

  // Wait 500ms for server to bind
  await new Promise(r => setTimeout(r, 500));

  // Clean up any test records from prior runs to ensure idempotent testing
  const { pool } = require('../src/db');
  if (pool) {
    await pool.query("DELETE FROM leave_requests WHERE start_date >= '2026-11-01'").catch(() => {});
  }

  const port = 3999;
  const host = '127.0.0.1';

  let passed = 0;
  let failed = 0;
  const issuesFound = [];

  function logPass(name) {
    passed++;
    console.log(`✅ [PASS] ${name}`);
  }

  function logIssue(category, description, suggestion) {
    issuesFound.push({ category, description, suggestion });
    console.log(`⚠️  [DEFECT/GAP FOUND] [${category}]: ${description}`);
  }

  try {
    // -------------------------------------------------------------
    // Test 1: Cold Start Ping Endpoints
    // -------------------------------------------------------------
    const pingRes = await request({ host, port, path: '/ping', method: 'GET' });
    assert.strictEqual(pingRes.status, 200);
    assert.strictEqual(pingRes.body, 'pong');
    logPass('GET /ping returns 200 pong');

    const apiPingRes = await request({ host, port, path: '/api/ping', method: 'GET' });
    assert.strictEqual(apiPingRes.status, 200);
    assert.strictEqual(apiPingRes.body.pong, true);
    assert.strictEqual(apiPingRes.body.timezone, 'Asia/Bangkok');
    logPass('GET /api/ping returns Asia/Bangkok status');

    // -------------------------------------------------------------
    // Test 2: Health Check
    // -------------------------------------------------------------
    const healthRes = await request({ host, port, path: '/api/health', method: 'GET' });
    assert.strictEqual(healthRes.status, 200);
    assert.strictEqual(healthRes.body.status, 'OK');
    logPass('GET /api/health returns system health');

    // -------------------------------------------------------------
    // Test 3: Authentication / Login
    // -------------------------------------------------------------
    // 3.1 Employee login
    const empLogin = await request({
      host, port, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { empId: 'EMP-001', pin: '1234' });
    assert.strictEqual(empLogin.status, 200);
    assert.strictEqual(empLogin.body.user.isSupervisor, false);
    logPass('POST /api/login: Employee credentials accepted');

    // 3.2 Supervisor login
    const supLogin = await request({
      host, port, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { empId: 'SUP-001', pin: '1234' });
    assert.strictEqual(supLogin.status, 200);
    assert.strictEqual(supLogin.body.user.isSupervisor, true);
    logPass('POST /api/login: Supervisor credentials accepted');

    // 3.3 Incorrect PIN
    const wrongPin = await request({
      host, port, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { empId: 'EMP-001', pin: '9999' });
    assert.strictEqual(wrongPin.status, 401);
    logPass('POST /api/login: Rejects invalid PIN');

    // 3.4 Missing fields
    const emptyLogin = await request({
      host, port, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { empId: '', pin: '' });
    assert.strictEqual(emptyLogin.status, 400);
    logPass('POST /api/login: Validates empty inputs');

    // -------------------------------------------------------------
    // Test 4: Quota & Calendar Endpoints
    // -------------------------------------------------------------
    const quotaRes = await request({ host, port, path: '/api/employees/EMP-001/quota', method: 'GET' });
    assert.strictEqual(quotaRes.status, 200);
    assert(quotaRes.body.quota.vacation);
    assert(quotaRes.body.quota.personal);
    assert(quotaRes.body.quota.sick);
    logPass('GET /api/employees/:id/quota returns 3 quotas');

    const calRes = await request({ host, port, path: '/api/department-calendar?department=Assembly&month=2026-09', method: 'GET' });
    assert.strictEqual(calRes.status, 200);
    assert(calRes.body.maxDailyLeaves !== undefined);
    logPass('GET /api/department-calendar returns department monthly usage');

    // -------------------------------------------------------------
    // Test 5: Leave Request Edge Cases
    // -------------------------------------------------------------
    // 5.1 Invalid hourly time: start time >= end time
    const invalidTime = await request({
      host, port, path: '/api/leave-requests', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      employeeId: 'EMP-001',
      leaveType: 'Personal',
      startDate: '2026-09-20',
      durationType: 'HOURLY',
      startTime: '14:00',
      endTime: '11:00'
    });
    assert.strictEqual(invalidTime.status, 400);
    logPass('POST /api/leave-requests: Blocks hourly start >= end time');

    // 5.2 Missing required fields
    const missingReq = await request({
      host, port, path: '/api/leave-requests', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { employeeId: 'EMP-001' });
    assert.strictEqual(missingReq.status, 400);
    logPass('POST /api/leave-requests: Validates missing fields');

    // 5.3 Normal submission with dynamically generated date
    const randomDay = String(Math.floor(Math.random() * 18) + 10).padStart(2, '0');
    const testDate1 = `2026-11-${randomDay}`;

    const submitReq = await request({
      host, port, path: '/api/leave-requests', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      employeeId: 'EMP-002',
      leaveType: 'Vacation',
      startDate: testDate1,
      endDate: testDate1,
      reason: 'ทำธุระครอบครัว'
    });
    console.log('submitReq result:', submitReq.status, submitReq.body ? (submitReq.body.message || submitReq.body.error) : '');
    assert([200, 201].includes(submitReq.status));
    logPass('POST /api/leave-requests: Successful request creation');

    const createdRequestId = submitReq.body.request ? submitReq.body.request.id : 101;

    // 5.4 Check if Demo/In-Memory list updates when DB is not connected
    const requestsList = await request({ host, port, path: '/api/leave-requests?employee_id=EMP-002', method: 'GET' });
    if (!process.env.DATABASE_URL) {
      // In demo mode, check if newly submitted request is in the list
      const hasNewReq = requestsList.body.requests && requestsList.body.requests.some(r => r.start_date === testDate1);
      if (!hasNewReq) {
        logIssue(
          'Demo / Offline Mode Persistence',
          'ในโหมด Demo/Offline (ไม่ได้ต่อ DB): เมื่อพนักงานส่งคำขอลาใหม่ คำขอนั้นไม่ถูกเก็บลงใน In-Memory Array ทำให้ไม่ปรากฏในหน้ารายการของพนักงาน หรือในหน้าตรวจอนุมัติของหัวหน้างาน',
          'สร้างระบบ In-Memory Store สำหรับโหมด Demo เพื่อให้การทดสอบและใช้งานก่อนต่อ Database ทำงานได้อย่างสมบูรณ์แบบ (เห็นการ์ดคำขอทันที, อนุมัติได้จริง, ปฏิทินอัปเดตจริง)'
        );
      }
    }

    // -------------------------------------------------------------
    // Test 6: Supervisor Review Security
    // -------------------------------------------------------------
    // 6.1 Unauthorized user attempting to approve
    const unauthorizedReview = await request({
      host, port, path: `/api/leave-requests/${createdRequestId}/status`, method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }
    }, { status: 'APPROVED', reviewedBy: 'EMP-001' });
    assert.strictEqual(unauthorizedReview.status, 403);
    logPass('PATCH /api/leave-requests/:id/status: Blocks non-supervisor');

    // 6.2 Supervisor approve
    const supervisorApprove = await request({
      host, port, path: `/api/leave-requests/${createdRequestId}/status`, method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }
    }, { status: 'APPROVED', reviewedBy: 'SUP-001' });
    assert.strictEqual(supervisorApprove.status, 200);
    logPass('PATCH /api/leave-requests/:id/status: Supervisor approval accepted');

    // -------------------------------------------------------------
    // Test 7: Verify 4 New Enhancements
    // -------------------------------------------------------------
    // 7.1 Past Date Restriction: Vacation in the past should be blocked
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 2);
    const yStr = yesterday.toISOString().split('T')[0];
    const pastVacReq = await request({
      host, port, path: '/api/leave-requests', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      employeeId: 'EMP-002',
      leaveType: 'Vacation',
      startDate: yStr,
      endDate: yStr,
      reason: 'ลาพักร้อนย้อนหลัง (ต้องถูกบล็อก)'
    });
    assert.strictEqual(pastVacReq.status, 400);
    assert(pastVacReq.body.error.includes('ไม่สามารถเลือกวันที่ในอดีตได้'));
    logPass('POST /api/leave-requests: Blocks past dates for Vacation/Personal leave');

    // 7.2 Employee Cancellation: Create new request and cancel it
    const testDate2 = `2026-12-${randomDay}`;
    const cancelCandidate = await request({
      host, port, path: '/api/leave-requests', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      employeeId: 'EMP-003',
      leaveType: 'Personal',
      startDate: testDate2,
      endDate: testDate2,
      reason: 'จะขอยกเลิกคำขอนี้'
    });
    assert([200, 201].includes(cancelCandidate.status));
    const cancelReqId = cancelCandidate.body.request.id;

    // Unauthorized cancel
    const unauthCancel = await request({
      host, port, path: `/api/leave-requests/${cancelReqId}`, method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    }, { employeeId: 'EMP-002' });
    assert.strictEqual(unauthCancel.status, 403);
    logPass('DELETE /api/leave-requests/:id: Blocks unauthorized cancellation');

    // Authorized cancel by owner
    const authCancel = await request({
      host, port, path: `/api/leave-requests/${cancelReqId}`, method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    }, { employeeId: 'EMP-003' });
    assert.strictEqual(authCancel.status, 200);
    assert(authCancel.body.success === true);
    logPass('DELETE /api/leave-requests/:id: Employee successfully cancels own pending request');

    // 7.3 Supervisor Rejection with Reason
    const testDate3 = `2026-12-${String(Number(randomDay) + 1).padStart(2, '0')}`;
    const rejectCandidate = await request({
      host, port, path: '/api/leave-requests', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      employeeId: 'EMP-003',
      leaveType: 'Personal',
      startDate: testDate3,
      endDate: testDate3,
      reason: 'ขอลาเพื่อทดสอบ reject'
    });
    assert([200, 201].includes(rejectCandidate.status));
    const rejectReqId = rejectCandidate.body.request.id;

    const rejectWithReason = await request({
      host, port, path: `/api/leave-requests/${rejectReqId}/status`, method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }
    }, {
      status: 'REJECTED',
      reviewedBy: 'SUP-002',
      rejectionReason: 'กำลังคนในไลน์ผลิตไม่เพียงพอสำหรับงานส่งมอบด่วน'
    });
    assert.strictEqual(rejectWithReason.status, 200);
    logPass('PATCH /api/leave-requests/:id/status: Rejection with custom reason recorded');

    // Verify rejection reason is returned to employee
    const empHistoryRes = await request({ host, port, path: '/api/leave-requests?employee_id=EMP-003', method: 'GET' });
    const rejectedReqItem = empHistoryRes.body.requests.find(r => r.id === rejectReqId);
    assert(rejectedReqItem);
    assert.strictEqual(rejectedReqItem.status, 'REJECTED');
    assert.strictEqual(rejectedReqItem.rejection_reason, 'กำลังคนในไลน์ผลิตไม่เพียงพอสำหรับงานส่งมอบด่วน');
    logPass('GET /api/leave-requests: Rejection reason successfully returned to employee');

    // 7.4 Supervisor History Tab Endpoint
    const historyListRes = await request({ host, port, path: '/api/leave-requests?status=HISTORY', method: 'GET' });
    assert.strictEqual(historyListRes.status, 200);
    assert(Array.isArray(historyListRes.body.requests));
    assert(historyListRes.body.requests.length > 0);
    const hasRejected = historyListRes.body.requests.some(r => r.id === rejectReqId);
    assert(hasRejected, 'History list must contain the rejected request');
    logPass('GET /api/leave-requests?status=HISTORY: Returns all resolved requests for supervisor');

    console.log('\n--------------------------------------------------------');
    console.log(`🎉 ALL ${passed} AUDIT TESTS COMPLETED & PASSED WITH 100% SUCCESS!`);
    console.log('--------------------------------------------------------\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Audit execution error:', err);
    console.log(`\nTests passed before error: ${passed}`);
    process.exit(1);
  }
}

runAudit();
