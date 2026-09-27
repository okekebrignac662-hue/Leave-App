/**
 * test/shift-swap.test.js
 * Automated Test Suite for Shift Swap Request System (ระบบสลับกะ/แลกกะการทำงาน)
 */

const http = require('http');

let app;
const PORT = 3994;
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
  console.log('\n🔄 Starting Shift Swap System Verification Tests...\n');
  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`  ✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
      process.exitCode = 1;
    }
  }

  try {
    process.env.PORT = PORT;
    app = require('../src/server.js');
    await new Promise((r) => setTimeout(r, 600));

    // Clean up old test swaps if PostgreSQL is active
    const { pool } = require('../src/db');
    if (pool) {
      await pool.query("DELETE FROM shift_swap_requests WHERE reason LIKE 'TEST_SWAP_%'").catch(() => {});
    }

    // 1. Test GET /api/shift-swaps
    console.log('1️⃣  Testing GET /api/shift-swaps listing...');
    const listRes = await makeRequest('/api/shift-swaps');
    assert(listRes.status === 200, 'GET /api/shift-swaps returns 200 OK');
    assert(listRes.json && Array.isArray(listRes.json.swaps), 'Returns swaps array');

    // 2. Validation: Empty or incomplete body
    console.log('\n2️⃣  Testing Validation: Incomplete payload...');
    const incompleteRes = await makeRequest('/api/shift-swaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { requesterId: 'EMP-001' }
    });
    assert(incompleteRes.status === 400, 'Rejects incomplete request with 400 Bad Request');

    // 3. Validation: Self-swap attempt
    console.log('\n3️⃣  Testing Validation: Attempting to swap with oneself...');
    const selfRes = await makeRequest('/api/shift-swaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        requesterId: 'EMP-001',
        targetEmployeeId: 'EMP-001',
        requesterDate: '2026-10-15',
        requesterShift: 'A',
        targetDate: '2026-10-16',
        targetShift: 'B',
        reason: 'TEST_SWAP_SELF'
      }
    });
    assert(selfRes.status === 400, 'Rejects self-swap with 400 Bad Request');

    // 4. Validation: Cross-department swap attempt (EMP-002: Assembly, EMP-001: Crimping 1)
    console.log('\n4️⃣  Testing Validation: Cross-department swap attempt...');
    const crossDeptRes = await makeRequest('/api/shift-swaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        requesterId: 'EMP-002',
        targetEmployeeId: 'EMP-001',
        requesterDate: '2026-10-15',
        requesterShift: 'A',
        targetDate: '2026-10-16',
        targetShift: 'B',
        reason: 'TEST_SWAP_CROSS'
      }
    });
    assert(crossDeptRes.status === 400, 'Rejects cross-department swap with 400 Bad Request');

    // 5. Creation: Valid Shift Swap Request (EMP-002 <-> EMP-N8096, Assembly)
    console.log('\n5️⃣  Testing Creation: Valid Shift Swap Request...');
    const createRes = await makeRequest('/api/shift-swaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        requesterId: 'EMP-002',
        targetEmployeeId: 'EMP-N8096',
        requesterDate: '2026-10-20',
        requesterShift: 'A',
        targetDate: '2026-10-21',
        targetShift: 'B',
        reason: 'TEST_SWAP_SUCCESS_1'
      }
    });
    assert(createRes.status === 201, 'POST /api/shift-swaps returns 201 Created');
    assert(createRes.json && createRes.json.swap && createRes.json.swap.id, 'Returns created swap with ID');
    assert(createRes.json.swap.status === 'PENDING_PEER', 'Initial status is PENDING_PEER');
    const swap1Id = createRes.json.swap.id;

    // 6. Colleague Unauthorized Peer Response: EMP-003 tries to respond to EMP-N8096's request
    console.log('\n6️⃣  Testing Security: Unauthorized employee tries to respond...');
    const unauthPeerRes = await makeRequest(`/api/shift-swaps/${swap1Id}/peer-response`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: {
        employeeId: 'EMP-003',
        action: 'ACCEPT'
      }
    });
    assert(unauthPeerRes.status === 403, 'Unauthorized peer response returns 403 Forbidden');

    // 7. Colleague Rejection Flow (Create swap 2 and have EMP-N8096 reject it)
    console.log('\n7️⃣  Testing Colleague Rejection Flow (REJECT_BY_PEER)...');
    const createRes2 = await makeRequest('/api/shift-swaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        requesterId: 'EMP-002',
        targetEmployeeId: 'EMP-N8096',
        requesterDate: '2026-10-22',
        requesterShift: 'A',
        targetDate: '2026-10-23',
        targetShift: 'B',
        reason: 'TEST_SWAP_REJECT_PEER'
      }
    });
    const swap2Id = createRes2.json.swap.id;

    const peerRejectRes = await makeRequest(`/api/shift-swaps/${swap2Id}/peer-response`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: {
        employeeId: 'EMP-N8096',
        action: 'REJECT',
        reason: 'ไม่สะดวกในวันดังกล่าว'
      }
    });
    assert(peerRejectRes.status === 200, 'Peer reject returns 200 OK');
    assert(peerRejectRes.json.status === 'REJECTED_BY_PEER', 'Status updated to REJECTED_BY_PEER');

    // 8. Colleague Acceptance Flow: EMP-N8096 accepts swap1Id -> PENDING_SUPERVISOR
    console.log('\n8️⃣  Testing Colleague Acceptance Flow (ACCEPT -> PENDING_SUPERVISOR)...');
    const peerAcceptRes = await makeRequest(`/api/shift-swaps/${swap1Id}/peer-response`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: {
        employeeId: 'EMP-N8096',
        action: 'ACCEPT'
      }
    });
    assert(peerAcceptRes.status === 200, 'Peer accept returns 200 OK');
    assert(peerAcceptRes.json.status === 'PENDING_SUPERVISOR', 'Status moves to PENDING_SUPERVISOR');

    // 9. Supervisor Review: Non-supervisor tries to approve
    console.log('\n9️⃣  Testing Security: Non-supervisor employee tries to approve...');
    const nonSupReviewRes = await makeRequest(`/api/shift-swaps/${swap1Id}/supervisor-review`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: {
        supervisorId: 'EMP-002',
        action: 'APPROVE'
      }
    });
    assert(nonSupReviewRes.status === 403, 'Non-supervisor review returns 403 Forbidden');

    // 10. Supervisor Approval Flow: SUP-001 approves swap1Id -> APPROVED
    console.log('\n🔟 Testing Supervisor Approval Flow (APPROVE -> APPROVED)...');
    const supApproveRes = await makeRequest(`/api/shift-swaps/${swap1Id}/supervisor-review`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: {
        supervisorId: 'SUP-001',
        action: 'APPROVE'
      }
    });
    assert(supApproveRes.status === 200, 'Supervisor approve returns 200 OK');
    assert(supApproveRes.json.status === 'APPROVED', 'Status updated to APPROVED');

    // 11. Cancellation Flow: Create swap 3 and requester cancels it
    console.log('\n1️⃣1️⃣ Testing Cancellation Flow: Requester cancels pending swap...');
    const createRes3 = await makeRequest('/api/shift-swaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        requesterId: 'EMP-002',
        targetEmployeeId: 'EMP-N8096',
        requesterDate: '2026-10-25',
        requesterShift: 'A',
        targetDate: '2026-10-26',
        targetShift: 'B',
        reason: 'TEST_SWAP_CANCEL'
      }
    });
    const swap3Id = createRes3.json.swap.id;

    const cancelRes = await makeRequest(`/api/shift-swaps/${swap3Id}/cancel`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: { employeeId: 'EMP-002' }
    });
    assert(cancelRes.status === 200, 'Requester cancel returns 200 OK');
    assert(cancelRes.json.success === true, 'Cancellation success response');

    // 12. Filtering: Query by employeeId and department
    console.log('\n1️⃣2️⃣ Testing Shift Swaps Filtering (employeeId & department)...');
    const filterRes = await makeRequest('/api/shift-swaps?employeeId=EMP-002&department=Assembly');
    assert(filterRes.status === 200, 'Filter query returns 200 OK');
    assert(filterRes.json && filterRes.json.swaps.length >= 2, 'Filtered swaps contain the created items');

    console.log(`\n========================================`);
    console.log(`🔄 Shift Swap Test Results: ${passed}/${total} assertions passed.`);
    console.log(`========================================\n`);

    if (passed === total) {
      console.log('🎉 All Shift Swap System tests passed perfectly!\n');
    }
  } catch (err) {
    console.error('Shift swap test execution error:', err);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode || 0);
  }
}

runTests();
