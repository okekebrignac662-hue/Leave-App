/**
 * test/notifications.test.js
 * Automated Test Suite for In-App Notification Bell & Notification Center
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

let app;
let server;
const PORT = 3991;
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

async function runTests() {
  console.log('\n🔔 Starting In-App Notification Bell System Verification Tests...\n');
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
    // 1. Verify frontend UI elements exist in index.html
    console.log('1️⃣  Verifying UI Components in public/index.html...');
    const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
    assert(htmlContent.includes('id="btn-notif-bell"'), 'index.html contains #btn-notif-bell');
    assert(htmlContent.includes('id="notif-dropdown"'), 'index.html contains #notif-dropdown');
    assert(htmlContent.includes('id="notif-badge-count"'), 'index.html contains #notif-badge-count');
    assert(htmlContent.includes('id="notif-badge-ping"'), 'index.html contains #notif-badge-ping');
    assert(htmlContent.includes('id="notif-list-container"'), 'index.html contains #notif-list-container');
    assert(htmlContent.includes('toggleNotificationDropdown'), 'index.html contains toggleNotificationDropdown function');
    assert(htmlContent.includes('loadNotifications'), 'index.html contains loadNotifications function');

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

    // 3. Test GET /api/notifications validation
    console.log('\n3️⃣  Testing GET /api/notifications validation...');
    const noUserRes = await makeRequest('/api/notifications');
    assert(noUserRes.status === 400, 'GET /api/notifications without userId returns 400 Bad Request');

    const testEmpId = `EMP-N${Date.now().toString().slice(-4)}`;
    // Create dedicated employee for test
    await makeRequest('/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        adminId: 'ADMIN-001',
        empId: testEmpId,
        name: 'พนักงานทดสอบ แจ้งเตือน',
        department: 'Assembly',
        shift: 'A',
        role: 'EMPLOYEE',
        pin: '1234',
        vacation_quota: 10,
        personal_quota: 6,
        sick_quota: 30
      }
    });

    const empNotifRes = await makeRequest(`/api/notifications?userId=${testEmpId}`);
    assert(empNotifRes.status === 200, 'GET /api/notifications returns 200 OK');
    assert(empNotifRes.json && empNotifRes.json.success === true, 'Response contains success: true');
    assert(empNotifRes.json && Array.isArray(empNotifRes.json.notifications), 'Response contains notifications array');
    assert(empNotifRes.json && typeof empNotifRes.json.unreadCount === 'number', 'Response contains numeric unreadCount');

    // 4. Test In-App Notification Trigger on Leave Submission
    console.log('\n4️⃣  Testing Leave Request Submission triggering notifications...');
    const testDate = `2026-12-${String(Math.floor(Math.random() * 25) + 1).padStart(2, '0')}`;
    const leaveRes = await makeRequest('/api/leave-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        employeeId: testEmpId,
        leaveType: 'Vacation',
        startDate: testDate,
        endDate: testDate,
        durationType: 'FULL_DAY',
        reason: 'ทดสอบระบบแจ้งเตือนกระดิ่ง'
      }
    });

    assert(leaveRes.status === 201, `POST /api/leave-requests succeeded (Status: ${leaveRes.status})`);
    const createdRequestId = leaveRes.json?.request?.id;

    // Check employee notification
    const checkEmpNotif = await makeRequest(`/api/notifications?userId=${testEmpId}`);
    assert(checkEmpNotif.status === 200, 'Employee can fetch notifications');
    const empNotifs = checkEmpNotif.json.notifications || [];
    const empSubmittedNotif = empNotifs.find(n => n.type === 'LEAVE_SUBMITTED' && n.reference_id == createdRequestId);
    assert(Boolean(empSubmittedNotif), 'Employee received LEAVE_SUBMITTED notification for created request');
    assert(empSubmittedNotif && empSubmittedNotif.is_read === false, 'Notification is marked unread initially');

    // Check supervisor notification (SUP-001 is supervisor of Assembly)
    const checkSupNotif = await makeRequest('/api/notifications?userId=SUP-001');
    const supNotifs = checkSupNotif.json.notifications || [];
    const supReceivedNotif = supNotifs.find(n => n.type === 'LEAVE_SUBMITTED' && n.reference_id == createdRequestId);
    assert(Boolean(supReceivedNotif), 'Supervisor received LEAVE_SUBMITTED notification for new request');

    // 5. Test Notification Trigger on Supervisor Review (Approval)
    console.log('\n5️⃣  Testing Supervisor Review triggering approval notification...');
    const approveRes = await makeRequest(`/api/leave-requests/${createdRequestId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: {
        status: 'APPROVED',
        reviewedBy: 'SUP-001'
      }
    });
    assert(approveRes.status === 200, 'PATCH /api/leave-requests/:id/status returns 200');

    // Check employee received LEAVE_APPROVED notification
    const checkEmpApproved = await makeRequest(`/api/notifications?userId=${testEmpId}`);
    const empApprovedNotifs = checkEmpApproved.json.notifications || [];
    const approvedNotif = empApprovedNotifs.find(n => n.type === 'LEAVE_APPROVED' && n.reference_id == createdRequestId);
    assert(Boolean(approvedNotif), 'Employee received LEAVE_APPROVED notification with checkmark title');

    // 6. Test Mark Single Notification as Read
    console.log('\n6️⃣  Testing Mark Single Notification as Read (PATCH /api/notifications/:id/read)...');
    if (approvedNotif) {
      const readRes = await makeRequest(`/api/notifications/${approvedNotif.id}/read`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: { userId: testEmpId }
      });
      assert(readRes.status === 200, 'PATCH /api/notifications/:id/read returns 200');

      const recheck = await makeRequest(`/api/notifications?userId=${testEmpId}`);
      const updatedItem = recheck.json.notifications.find(n => n.id === approvedNotif.id);
      assert(updatedItem && updatedItem.is_read === true, 'Notification is now marked as is_read: true');
    }

    // 7. Test Mark All Notifications as Read
    console.log('\n7️⃣  Testing Mark All Notifications as Read (PATCH /api/notifications/read-all)...');
    const markAllRes = await makeRequest('/api/notifications/read-all', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: { userId: testEmpId }
    });
    assert(markAllRes.status === 200, 'PATCH /api/notifications/read-all returns 200');

    const checkAllRead = await makeRequest(`/api/notifications?userId=${testEmpId}`);
    assert(checkAllRead.json.unreadCount === 0, 'unreadCount is 0 after mark-all-read');

    // 8. Test Delete / Dismiss Notification
    console.log('\n8️⃣  Testing Delete Notification (DELETE /api/notifications/:id)...');
    if (approvedNotif) {
      const delRes = await makeRequest(`/api/notifications/${approvedNotif.id}?userId=${testEmpId}`, {
        method: 'DELETE'
      });
      assert(delRes.status === 200, 'DELETE /api/notifications/:id returns 200');

      const recheckDeleted = await makeRequest(`/api/notifications?userId=${testEmpId}`);
      const stillExists = recheckDeleted.json.notifications.some(n => n.id === approvedNotif.id);
      assert(!stillExists, 'Deleted notification no longer appears in user notifications list');
    }

    console.log('\n========================================');
    console.log(`Notification Center Tests: ${passed}/${total} passed`);
    console.log('========================================\n');

  } catch (err) {
    console.error('Test execution failed:', err);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.close();
    }
    process.exit(process.exitCode || 0);
  }
}

runTests();
