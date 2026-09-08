const express = require('express');
const cors = require('cors');
const path = require('path');
const { pool, query } = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Helper: Normalize Leave Type to standard key
function normalizeLeaveType(type) {
  if (!type) return 'Vacation';
  const lower = type.toLowerCase();
  if (lower.includes('sick') || lower.includes('ป่วย')) return 'Sick';
  if (lower.includes('personal') || lower.includes('กิจ')) return 'Personal';
  return 'Vacation';
}

// Helper: Generate array of YYYY-MM-DD date strings between start and end date
function getDatesInRange(startDateStr, endDateStr) {
  const dates = [];
  const curr = new Date(startDateStr);
  const end = new Date(endDateStr);
  while (curr <= end) {
    dates.push(curr.toISOString().split('T')[0]);
    curr.setDate(curr.getDate() + 1);
  }
  return dates;
}

// ==========================================
// 1. Health & DB Status Check API
// ==========================================
app.get('/api/health', async (req, res) => {
  let dbStatus = 'disconnected';
  if (pool) {
    try {
      await query('SELECT 1');
      dbStatus = 'connected';
    } catch (err) {
      dbStatus = 'error: ' + err.message;
    }
  }
  res.json({
    status: 'OK',
    serverTime: new Date().toISOString(),
    database: dbStatus
  });
});

// ==========================================
// 2. Login API
// Requirement: If ID starts with 'SUP', return supervisor status
// ==========================================
app.post('/api/login', async (req, res) => {
  try {
    const { empId, pin } = req.body;
    if (!empId || !empId.trim()) {
      return res.status(400).json({ error: 'กรุณากรอกรหัสพนักงาน (Employee ID required)' });
    }
    if (!pin || !pin.trim()) {
      return res.status(400).json({ error: 'กรุณากรอกรหัสผ่าน (PIN required)' });
    }

    const cleanEmpId = empId.trim().toUpperCase();
    const cleanPin = pin.trim();
    const isSupPrefix = cleanEmpId.startsWith('SUP');

    // If database is connected, query employee details
    if (pool) {
      const result = await query('SELECT * FROM employees WHERE UPPER(id) = $1', [cleanEmpId]);
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'ไม่พบรหัสพนักงานนี้ในระบบ (Employee ID not found)' });
      }

      const emp = result.rows[0];
      // Validate PIN strictly
      if (emp.pin !== cleanPin) {
        return res.status(401).json({ error: 'รหัสผ่าน (PIN) ไม่ถูกต้อง (Incorrect PIN)' });
      }

      const isSupervisor = isSupPrefix || emp.role === 'SUPERVISOR';
      return res.json({
        success: true,
        user: {
          id: emp.id,
          name: emp.name,
          department: emp.department,
          role: isSupervisor ? 'SUPERVISOR' : 'EMPLOYEE',
          isSupervisor
        }
      });
    }

    // Strict Fallback if database is offline: only allow known demo IDs with PIN 1234
    const validDemoUsers = {
      'EMP-001': { name: 'สมชาย ใจดี', department: 'Assembly', role: 'EMPLOYEE', pin: '1234' },
      'EMP-002': { name: 'สมหญิง รักงาน', department: 'Assembly', role: 'EMPLOYEE', pin: '1234' },
      'SUP-001': { name: 'สมศักดิ์ คุมงาน (หัวหน้า)', department: 'Assembly', role: 'SUPERVISOR', pin: '1234' }
    };

    const demoUser = validDemoUsers[cleanEmpId];
    if (!demoUser) {
      return res.status(401).json({ error: 'ไม่พบรหัสพนักงานนี้ในระบบ (Employee ID not found)' });
    }
    if (demoUser.pin !== cleanPin) {
      return res.status(401).json({ error: 'รหัสผ่าน (PIN) ไม่ถูกต้อง (Incorrect PIN)' });
    }

    const isSupervisor = isSupPrefix || demoUser.role === 'SUPERVISOR';
    return res.json({
      success: true,
      user: {
        id: cleanEmpId,
        name: demoUser.name,
        department: demoUser.department,
        role: isSupervisor ? 'SUPERVISOR' : 'EMPLOYEE',
        isSupervisor
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ (Server error)' });
  }
});

// ==========================================
// 3. Employee Quota API
// Calculate remaining and total quota for vacation, personal, sick
// ==========================================
app.get('/api/employees/:id/quota', async (req, res) => {
  try {
    const empId = req.params.id.trim().toUpperCase();

    let totalVacation = 6;
    let totalPersonal = 6;
    let totalSick = 30;

    let usedVacation = 0;
    let usedPersonal = 0;
    let usedSick = 0;

    if (pool) {
      // Get base quota from employee record
      const empRes = await query('SELECT vacation_quota, personal_quota, sick_quota FROM employees WHERE UPPER(id) = $1', [empId]);
      if (empRes.rows.length > 0) {
        totalVacation = empRes.rows[0].vacation_quota;
        totalPersonal = empRes.rows[0].personal_quota;
        totalSick = empRes.rows[0].sick_quota;
      }

      // Sum approved/pending days for this employee in current calendar year
      const currentYear = new Date().getFullYear();
      const requestsRes = await query(
        `SELECT leave_type, SUM(days_count) as total_days
         FROM leave_requests
         WHERE UPPER(employee_id) = $1
           AND status IN ('APPROVED', 'PENDING')
           AND EXTRACT(YEAR FROM start_date) = $2
         GROUP BY leave_type`,
        [empId, currentYear]
      );

      requestsRes.rows.forEach(row => {
        const type = normalizeLeaveType(row.leave_type);
        const days = parseInt(row.total_days || 0, 10);
        if (type === 'Vacation') usedVacation += days;
        if (type === 'Personal') usedPersonal += days;
        if (type === 'Sick') usedSick += days;
      });
    }

    res.json({
      success: true,
      quota: {
        vacation: {
          total: totalVacation,
          used: usedVacation,
          remaining: Math.max(0, totalVacation - usedVacation)
        },
        personal: {
          total: totalPersonal,
          used: usedPersonal,
          remaining: Math.max(0, totalPersonal - usedPersonal)
        },
        sick: {
          total: totalSick,
          used: usedSick,
          remaining: Math.max(0, totalSick - usedSick)
        }
      }
    });
  } catch (error) {
    console.error('Fetch quota error:', error);
    res.status(500).json({ error: 'ไม่สามารถโหลดข้อมูลโควตาได้' });
  }
});

// ==========================================
// 4. Leave Request API
// Requirement: Check daily quota from Quota_Settings.
// Block if full (except Sick Leave), otherwise insert to database.
// ==========================================
app.post('/api/leave-requests', async (req, res) => {
  try {
    const { employeeId, leaveType, startDate, endDate, reason } = req.body;

    if (!employeeId || !leaveType || !startDate || !endDate) {
      return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน (All fields required)' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ error: 'รูปแบบวันที่ไม่ถูกต้อง' });
    }

    if (start > end) {
      return res.status(400).json({ error: 'วันเริ่มต้นต้องไม่เกินวันสิ้นสุด (Start date must be before end date)' });
    }

    // Calculate days inclusive
    const diffTime = Math.abs(end - start);
    const daysCount = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;

    const normalizedType = normalizeLeaveType(leaveType);
    const cleanEmpId = employeeId.trim().toUpperCase();

    if (!pool) {
      // In case DB is not yet hooked up, simulate success
      return res.status(201).json({
        success: true,
        message: 'ส่งคำขอลางานเรียบร้อยแล้ว (Demo mode)',
        request: {
          id: Math.floor(Math.random() * 10000),
          employee_id: cleanEmpId,
          leave_type: normalizedType,
          start_date: startDate,
          end_date: endDate,
          days_count: daysCount,
          reason,
          status: 'PENDING'
        }
      });
    }

    // 1. Fetch employee & department
    const empRes = await query('SELECT * FROM employees WHERE UPPER(id) = $1', [cleanEmpId]);
    let department = 'Assembly';
    let empRecord = null;
    if (empRes.rows.length > 0) {
      empRecord = empRes.rows[0];
      department = empRecord.department;
    }

    // 2. Check employee individual remaining balance (Vacation & Personal)
    if (normalizedType !== 'Sick' && empRecord) {
      const currentYear = new Date().getFullYear();
      const usedRes = await query(
        `SELECT COALESCE(SUM(days_count), 0) as used
         FROM leave_requests
         WHERE UPPER(employee_id) = $1
           AND leave_type = $2
           AND status IN ('APPROVED', 'PENDING')
           AND EXTRACT(YEAR FROM start_date) = $3`,
        [cleanEmpId, normalizedType, currentYear]
      );
      const used = parseInt(usedRes.rows[0].used, 10);
      const totalAllowed = normalizedType === 'Vacation' ? empRecord.vacation_quota : empRecord.personal_quota;
      if (used + daysCount > totalAllowed) {
        return res.status(400).json({
          error: `โควตาวันลาของคุณไม่เพียงพอ (เหลือ ${Math.max(0, totalAllowed - used)} วัน, ต้องการขอ ${daysCount} วัน)`
        });
      }
    }

    // 3. Check Daily Quota from Quota_Settings (BLOCK IF FULL, EXCEPT SICK LEAVE)
    if (normalizedType !== 'Sick') {
      // Fetch department daily limit
      const quotaRes = await query('SELECT max_daily_leaves FROM quota_settings WHERE department = $1', [department]);
      const maxDailyLeaves = quotaRes.rows.length > 0 ? quotaRes.rows[0].max_daily_leaves : 2;

      const requestedDates = getDatesInRange(startDate, endDate);

      for (const date of requestedDates) {
        // Count how many people in this department have APPROVED or PENDING leave on this date
        const countRes = await query(
          `SELECT COUNT(DISTINCT lr.employee_id) as active_count
           FROM leave_requests lr
           JOIN employees e ON lr.employee_id = e.id
           WHERE e.department = $1
             AND lr.status IN ('APPROVED', 'PENDING')
             AND lr.leave_type != 'Sick'
             AND $2 BETWEEN lr.start_date AND lr.end_date
             AND UPPER(lr.employee_id) != $3`,
          [department, date, cleanEmpId]
        );

        const currentOnLeave = parseInt(countRes.rows[0].active_count, 10);

        if (currentOnLeave >= maxDailyLeaves) {
          return res.status(400).json({
            error: `⚠️ โควตาลางานของแผนก ${department} เต็มแล้วในวันที่ ${date} (จำกัดไม่เกิน ${maxDailyLeaves} คน/วัน) ยกเว้นกรณีลาป่วยเท่านั้น`,
            blockedDate: date,
            maxDailyLeaves,
            currentOnLeave
          });
        }
      }
    }

    // 4. Insert Leave Request
    const insertRes = await query(
      `INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, days_count, reason, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
       RETURNING *`,
      [cleanEmpId, normalizedType, startDate, endDate, daysCount, reason || '']
    );

    res.status(201).json({
      success: true,
      message: 'ส่งคำขอลางานเรียบร้อยแล้ว (Leave request submitted successfully)',
      request: insertRes.rows[0]
    });
  } catch (error) {
    console.error('Leave request error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกคำขอลางาน: ' + error.message });
  }
});

// ==========================================
// 5. Leave Requests List API
// - status=PENDING (For Supervisor dashboard)
// - employee_id=EMP-001 (For Employee history)
// ==========================================
app.get('/api/leave-requests', async (req, res) => {
  try {
    const { status, employee_id } = req.query;

    if (!pool) {
      // Demo mock responses
      const demoList = [
        {
          id: 101,
          employee_id: 'EMP-001',
          employee_name: 'สมชาย ใจดี',
          department: 'Assembly (ประกอบ)',
          leave_type: 'Vacation',
          start_date: '2026-09-15',
          end_date: '2026-09-15',
          days_count: 1,
          reason: 'พาครอบครัวไปทำธุระ',
          status: 'PENDING',
          created_at: new Date().toISOString()
        }
      ];
      return res.json({ success: true, requests: demoList });
    }

    let sql = `
      SELECT 
        lr.id,
        lr.employee_id,
        COALESCE(e.name, lr.employee_id) AS employee_name,
        COALESCE(e.department, 'Assembly') AS department,
        lr.leave_type,
        TO_CHAR(lr.start_date, 'YYYY-MM-DD') AS start_date,
        TO_CHAR(lr.end_date, 'YYYY-MM-DD') AS end_date,
        lr.days_count,
        lr.reason,
        lr.status,
        lr.reviewed_by,
        lr.reviewed_at,
        lr.created_at
      FROM leave_requests lr
      LEFT JOIN employees e ON lr.employee_id = e.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      params.push(status.toUpperCase());
      sql += ` AND UPPER(lr.status) = $${params.length}`;
    }

    if (employee_id) {
      params.push(employee_id.trim().toUpperCase());
      sql += ` AND UPPER(lr.employee_id) = $${params.length}`;
    }

    sql += ' ORDER BY lr.created_at DESC';

    const result = await query(sql, params);
    res.json({
      success: true,
      requests: result.rows
    });
  } catch (error) {
    console.error('Fetch requests error:', error);
    res.status(500).json({ error: 'ไม่สามารถดึงรายการคำขอลางานได้' });
  }
});

// ==========================================
// 6. Supervisor Approve/Reject API
// Requirement: Implement the Approve/Reject API for supervisors
// ==========================================
app.patch('/api/leave-requests/:id/status', async (req, res) => {
  try {
    const requestId = req.params.id;
    const { status, reviewedBy, rejectionReason } = req.body;

    if (!status || !['APPROVED', 'REJECTED'].includes(status.toUpperCase())) {
      return res.status(400).json({ error: 'สถานะต้องเป็น APPROVED หรือ REJECTED เท่านั้น' });
    }

    const cleanStatus = status.toUpperCase();
    const supervisorId = (reviewedBy || 'SUP-001').trim().toUpperCase();

    // Verify supervisor authorization (starts with SUP)
    if (!supervisorId.startsWith('SUP')) {
      return res.status(403).json({ error: 'เฉพาะหัวหน้างาน (Supervisor) เท่านั้นที่สามารถอนุมัติหรือปฏิเสธคำขอได้' });
    }

    if (!pool) {
      return res.json({
        success: true,
        message: `ดำเนินการ ${cleanStatus === 'APPROVED' ? 'อนุมัติ' : 'ไม่อนุมัติ'} เรียบร้อยแล้ว (Demo mode)`,
        request: { id: requestId, status: cleanStatus, reviewed_by: supervisorId }
      });
    }

    const updateRes = await query(
      `UPDATE leave_requests
       SET status = $1,
           reviewed_by = $2,
           reviewed_at = CURRENT_TIMESTAMP,
           rejection_reason = $3
       WHERE id = $4
       RETURNING *`,
      [cleanStatus, supervisorId, rejectionReason || null, requestId]
    );

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบคำขอลางานนี้' });
    }

    res.json({
      success: true,
      message: `ดำเนินการ ${cleanStatus === 'APPROVED' ? 'อนุมัติ' : 'ไม่อนุมัติ'} คำขอเรียบร้อยแล้ว`,
      request: updateRes.rows[0]
    });
  } catch (error) {
    console.error('Review leave request error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัปเดตสถานะคำขอ: ' + error.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Leave Management Server is running on http://localhost:${PORT}`);
});
