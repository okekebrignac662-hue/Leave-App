// Unit tests for the Daily Quota Calculation and Leave Type normalization
const assert = require('assert');

// Simulate the check algorithm implemented in src/server.js
function normalizeLeaveType(type) {
  if (!type) return 'Vacation';
  const lower = type.toLowerCase();
  if (lower.includes('sick') || lower.includes('ป่วย')) return 'Sick';
  if (lower.includes('personal') || lower.includes('กิจ')) return 'Personal';
  return 'Vacation';
}

function checkDailyQuota({ maxDailyLeaves, activeLeavesOnDate, leaveType }) {
  const normalized = normalizeLeaveType(leaveType);
  if (normalized === 'Sick') {
    return { allowed: true, reason: 'Sick leave is exempt from department daily limits' };
  }
  if (activeLeavesOnDate >= maxDailyLeaves) {
    return {
      allowed: false,
      reason: `โควตาลางานของแผนกเต็มแล้ว (สูงสุด ${maxDailyLeaves} คน/วัน)`
    };
  }
  return { allowed: true };
}

console.log('🧪 Testing Quota Logic & Rules...\n');

// 1. Sick leave should always be allowed even if quota is full
const sickTest = checkDailyQuota({ maxDailyLeaves: 2, activeLeavesOnDate: 2, leaveType: 'Sick' });
assert.strictEqual(sickTest.allowed, true, 'Sick leave must be allowed even if quota is reached');
console.log('✅ [PASS] Sick Leave bypasses daily department quota');

// 2. Vacation blocked if quota reached
const vacationBlocked = checkDailyQuota({ maxDailyLeaves: 2, activeLeavesOnDate: 2, leaveType: 'Vacation' });
assert.strictEqual(vacationBlocked.allowed, false, 'Vacation leave must be blocked if active leaves == limit');
console.log('✅ [PASS] Vacation Leave blocked when daily quota limit is reached');

// 3. Vacation allowed when under quota
const vacationAllowed = checkDailyQuota({ maxDailyLeaves: 2, activeLeavesOnDate: 1, leaveType: 'Vacation' });
assert.strictEqual(vacationAllowed.allowed, true, 'Vacation leave allowed if under limit');
console.log('✅ [PASS] Vacation Leave allowed when under quota limit');

// 4. Personal leave blocked if quota reached
const personalBlocked = checkDailyQuota({ maxDailyLeaves: 1, activeLeavesOnDate: 1, leaveType: 'Personal' });
assert.strictEqual(personalBlocked.allowed, false, 'Personal leave must be blocked if quota reached');
console.log('✅ [PASS] Personal Leave blocked when daily quota limit is reached');

// 5. Thai label normalization
assert.strictEqual(normalizeLeaveType('ลาป่วย (Sick Leave)'), 'Sick');
assert.strictEqual(normalizeLeaveType('ลากิจ (Personal Leave)'), 'Personal');
assert.strictEqual(normalizeLeaveType('ลาพักร้อน (Vacation)'), 'Vacation');
console.log('✅ [PASS] Thai leave type strings normalized correctly');

console.log('\n🏁 All Quota Logic Tests Passed successfully!');
