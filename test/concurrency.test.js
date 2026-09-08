// Concurrency & Quota Race Condition Simulation Test
const assert = require('assert');

// Simulate the serialized/locking quota allocator logic
class DepartmentLeaveManager {
  constructor(maxQuota = 2) {
    this.maxQuota = maxQuota;
    this.approvedLeaves = [];
    this.mutex = Promise.resolve(); // Simulates PostgreSQL row lock (FOR UPDATE)
  }

  // Atomically check and reserve a leave slot
  async requestLeaveAtomic({ employeeId, date, leaveType }) {
    // Acquire lock (just like 'SELECT ... FOR UPDATE' in transaction)
    return new Promise((resolve) => {
      this.mutex = this.mutex.then(async () => {
        try {
          // 1. Duplicate check
          const existing = this.approvedLeaves.find(
            l => l.employeeId === employeeId && l.date === date
          );
          if (existing) {
            return resolve({
              success: false,
              error: 'มีคำขอลางานในวันนี้อยู่แล้ว (ป้องกันการกดส่งซ้ำ)'
            });
          }

          // 2. Sick leave exception
          if (leaveType === 'Sick') {
            const req = { id: Date.now() + Math.random(), employeeId, date, leaveType, status: 'PENDING' };
            this.approvedLeaves.push(req);
            return resolve({ success: true, request: req });
          }

          // 3. Count non-sick leaves on this date
          const countOnDate = this.approvedLeaves.filter(
            l => l.date === date && l.leaveType !== 'Sick'
          ).length;

          if (countOnDate >= this.maxQuota) {
            return resolve({
              success: false,
              error: `โควตาลางานเต็มแล้ว (${countOnDate}/${this.maxQuota} คน)`
            });
          }

          // 4. Reserve slot
          const req = { id: Date.now() + Math.random(), employeeId, date, leaveType, status: 'PENDING' };
          this.approvedLeaves.push(req);
          return resolve({ success: true, request: req });
        } catch (err) {
          return resolve({ success: false, error: err.message });
        }
      });
    });
  }
}

async function runTests() {
  console.log('🧪 Starting Concurrency & Hardening Test Suite...\n');

  // Test 1: Race condition prevention
  console.log('1️⃣  Simulating 5 employees pressing "Submit" simultaneously for 1 remaining quota slot...');
  const manager = new DepartmentLeaveManager(2);

  // Pre-fill 1 slot
  await manager.requestLeaveAtomic({ employeeId: 'EMP-001', date: '2026-09-15', leaveType: 'Vacation' });

  // 4 other employees press button at the EXACT same millisecond
  const simultaneousRequests = [
    manager.requestLeaveAtomic({ employeeId: 'EMP-002', date: '2026-09-15', leaveType: 'Vacation' }),
    manager.requestLeaveAtomic({ employeeId: 'EMP-003', date: '2026-09-15', leaveType: 'Vacation' }),
    manager.requestLeaveAtomic({ employeeId: 'EMP-004', date: '2026-09-15', leaveType: 'Personal' }),
    manager.requestLeaveAtomic({ employeeId: 'EMP-005', date: '2026-09-15', leaveType: 'Vacation' })
  ];

  const results = await Promise.all(simultaneousRequests);
  const successCount = results.filter(r => r.success).length;
  const failureCount = results.filter(r => !r.success).length;

  console.log(`   - Successful approvals: ${successCount}`);
  console.log(`   - Rejected (Quota Full): ${failureCount}`);

  assert.strictEqual(successCount, 1, 'Only 1 request must succeed when only 1 slot remained');
  assert.strictEqual(failureCount, 3, 'The other 3 simultaneous requests must be rejected');
  assert.strictEqual(manager.approvedLeaves.length, 2, 'Total quota in database must not exceed limit 2');
  console.log('✅ [PASS] Race condition eliminated! Quota never overflows under concurrent load.\n');

  // Test 2: Double-click spam prevention
  console.log('2️⃣  Simulating rapid double-click from the same employee...');
  const doubleClickResults = await Promise.all([
    manager.requestLeaveAtomic({ employeeId: 'EMP-006', date: '2026-09-20', leaveType: 'Vacation' }),
    manager.requestLeaveAtomic({ employeeId: 'EMP-006', date: '2026-09-20', leaveType: 'Vacation' })
  ]);
  const dcSuccess = doubleClickResults.filter(r => r.success).length;
  const dcFail = doubleClickResults.filter(r => !r.success).length;
  assert.strictEqual(dcSuccess, 1, 'First click should succeed');
  assert.strictEqual(dcFail, 1, 'Second duplicate click must be blocked');
  console.log('✅ [PASS] Duplicate submission / double-click prevented successfully.\n');

  // Test 3: Timezone Safety Test (Asia/Bangkok)
  console.log('3️⃣  Testing Asia/Bangkok timezone date consistency...');
  const testDate = new Date('2026-09-15T00:30:00.000Z'); // 07:30 AM Bangkok time on Sept 15
  const bangkokDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(testDate);
  assert.strictEqual(bangkokDateStr, '2026-09-15', 'Date must be 2026-09-15 in Bangkok timezone');
  console.log('✅ [PASS] Bangkok timezone date formatting is accurate.\n');

  console.log('🎉 ALL HARDENING & CONCURRENCY TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
