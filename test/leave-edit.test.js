/**
 * test/leave-edit.test.js
 * Automated Test Suite for Editing Leave Requests (พนักงานแก้ไขใบลา)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

let app;
let server;
const PORT = 3993;
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
  console.log('\n✏️ Starting Leave Request Edit System Verification Tests...\n');
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
    console.log('1️⃣  Verifying Edit Modal & Functions in public/index.html...');
    const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
    assert(htmlContent.includes('id="edit-leave-modal"'), 'index.html contains #edit-leave-modal');
    assert(htmlContent.includes('id="edit-leave-type"'), 'index.html contains #edit-leave-type');
    assert(htmlContent.includes('id="edit-dates-container"'), 'index.html contains #edit-dates-container');
    assert(htmlContent.includes('id="edit-hourly-container"'), 'index.html contains #edit-hourly-container');
    assert(htmlContent.includes('id="edit-reason"'), 'index.html contains #edit-reason');
    assert(htmlContent.includes('openEditLeaveRequestModal'), 'index.html contains openEditLeaveRequestModal function');
    assert(htmlContent.includes('submitEditLeaveRequest'), 'index.html contains submitEditLeaveRequest function');
    assert(htmlContent.includes('closeEditLeaveRequestModal'), 'index.html contains closeEditLeaveRequestModal function');
    assert(htmlContent.includes('✏️ แก้ไข'), 'index.html contains ✏️ แก้ไข edit button in request cards');

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

    // 3. Create test employee
    console.log('\n3️⃣  Setting up test employee and leave request...');
    const testEmpId = `EMP-ED${Date.now().toString().slice(-4)}`;
    const otherEmpId = `EMP-OT${Date.now().toString().slice(-4)}`;
    const testDept = `EditDept_${Date.now().toString().slice(-4)}`;

    await makeRequest('/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        adminId: 'ADMIN-001',
        empId: testEmpId,
        name: 'สมชาย รักการแก้ไข',
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
        empId: otherEmpId,
        name: 'สมศรี คนอื่น',
        department: testDept,
        shift: 'A',
        role: 'EMPLOYEE',
        pin: '1234',
        vacation_quota: 10,
        personal_quota: 6,
        sick_quota: 30
      }
    });

    // Create a leave request
    const createRes = await makeRequest('/api/leave-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        employeeId: testEmpId,
        leaveType: 'Vacation',
        startDate: '2029-11-10',
        endDate: '2029-11-11',
        durationType: 'FULL_DAY',
        reason: 'ไปต่างจังหวัดก่อนแก้ไข'
      }
    });
    assert(createRes.status === 201 && createRes.json && createRes.json.success, 'Leave request created successfully');
    const createdReqId = createRes.json.request ? createRes.json.request.id : createRes.json.requestId;

    // 4. Test unauthorized edit
    console.log('\n4️⃣  Testing PUT /api/leave-requests/:id security checks...');
    const unauthEditRes = await makeRequest(`/api/leave-requests/${createdReqId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: {
        employeeId: otherEmpId,
        leaveType: 'Vacation',
        startDate: '2029-11-12',
        endDate: '2029-11-13',
        durationType: 'FULL_DAY',
        reason: 'แอบแก้ไขของคนอื่น'
      }
    });
    assert(unauthEditRes.status === 403, 'Unauthorized edit returns 403 Forbidden');

    // 5. Test successful edit of PENDING request
    console.log('\n5️⃣  Testing successful edit of PENDING request...');
    const successfulEditRes = await makeRequest(`/api/leave-requests/${createdReqId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: {
        employeeId: testEmpId,
        leaveType: 'Vacation',
        startDate: '2029-11-15',
        endDate: '2029-11-16',
        durationType: 'FULL_DAY',
        reason: 'ขอแก้ไขวันเนื่องจากติดธุระด่วน',
        attachmentUrl: 'data:image/jpeg;base64,testeditedimage'
      }
    });
    assert(successfulEditRes.status === 200 && successfulEditRes.json && successfulEditRes.json.success, 'PUT /api/leave-requests/:id returns 200 OK');

    // Verify updated record in GET /api/leave-requests?employeeId=...
    const myReqsRes = await makeRequest(`/api/leave-requests?employeeId=${testEmpId}`);
    const updatedReq = myReqsRes.json.requests.find(r => r.id === createdReqId);
    assert(updatedReq !== undefined, 'Request found in employee history');
    assert(updatedReq.reason === 'ขอแก้ไขวันเนื่องจากติดธุระด่วน', 'Reason was updated');
    assert(updatedReq.start_date.includes('2029-11-15'), 'Start date was updated');
    assert(updatedReq.end_date.includes('2029-11-16'), 'End date was updated');
    assert(updatedReq.attachment_url === 'data:image/jpeg;base64,testeditedimage', 'Attachment was updated');
    assert(updatedReq.status === 'PENDING', 'Status remains PENDING');

    // 6. Test blocking edit on APPROVED request
    console.log('\n6️⃣  Testing block on APPROVED request...');
    // Approve it as supervisor
    await makeRequest(`/api/leave-requests/${createdReqId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: {
        status: 'APPROVED',
        reviewedBy: 'SUP-001'
      }
    });

    const editApprovedRes = await makeRequest(`/api/leave-requests/${createdReqId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: {
        employeeId: testEmpId,
        leaveType: 'Vacation',
        startDate: '2029-11-20',
        endDate: '2029-11-21',
        durationType: 'FULL_DAY',
        reason: 'พยายามแก้หลังอนุมัติแล้ว'
      }
    });
    assert(editApprovedRes.status === 400, 'Editing APPROVED request returns 400 Bad Request');
    assert(editApprovedRes.json.error && editApprovedRes.json.error.includes('รออนุมัติ หรือไม่อนุมัติ'), 'Error message specifies allowed statuses');

    // 7. Test editing a REJECTED request resets it to PENDING
    console.log('\n7️⃣  Testing editing a REJECTED request resets status to PENDING...');
    // Create new request and reject it
    const req2Res = await makeRequest('/api/leave-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        employeeId: testEmpId,
        leaveType: 'Personal',
        startDate: '2029-12-01',
        endDate: '2029-12-01',
        durationType: 'FULL_DAY',
        reason: 'จะลาวันที่ 1'
      }
    });
    const req2Id = req2Res.json.request ? req2Res.json.request.id : req2Res.json.requestId;

    await makeRequest(`/api/leave-requests/${req2Id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: {
        status: 'REJECTED',
        reviewedBy: 'SUP-001',
        rejectionReason: 'คนในแผนกขาด'
      }
    });

    // Verify it is rejected
    const checkReject = await makeRequest(`/api/leave-requests?employeeId=${testEmpId}`);
    const rejectedReq = checkReject.json.requests.find(r => r.id === req2Id);
    assert(rejectedReq.status === 'REJECTED', 'Request was marked as REJECTED');
    assert(rejectedReq.rejection_reason === 'คนในแผนกขาด', 'Rejection reason was recorded');

    // Now edit this rejected request with new date
    const editRejectedRes = await makeRequest(`/api/leave-requests/${req2Id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: {
        employeeId: testEmpId,
        leaveType: 'Personal',
        startDate: '2029-12-05',
        endDate: '2029-12-05',
        durationType: 'FULL_DAY',
        reason: 'เปลี่ยนวันเป็นวันที่ 5 ที่คนไม่ขาดแล้วครับ'
      }
    });
    assert(editRejectedRes.status === 200, 'Editing REJECTED request succeeded');

    const checkResubmitted = await makeRequest(`/api/leave-requests?employeeId=${testEmpId}`);
    const resubmittedReq = checkResubmitted.json.requests.find(r => r.id === req2Id);
    assert(resubmittedReq.status === 'PENDING', 'Status was reset to PENDING');
    assert(resubmittedReq.rejection_reason === null, 'Rejection reason was cleared');
    assert(resubmittedReq.start_date.includes('2029-12-05'), 'New start date applied');

    // 8. Test In-App notification was created for edit
    console.log('\n8️⃣  Testing In-App Notification created for edit...');
    const notifsRes = await makeRequest(`/api/notifications?userId=${testEmpId}`);
    const editNotif = notifsRes.json.notifications.find(n => n.title && n.title.includes('แก้ไขคำขอลางาน'));
    assert(editNotif !== undefined, 'Notification generated for leave request edit');

    console.log(`\n=========================================`);
    console.log(`Summary: ${passed}/${total} assertions passed.`);
    console.log(`=========================================\n`);

    if (passed === total) {
      console.log('🎉 All Leave Request Edit Verification Tests PASSED!\n');
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

runTests();
