// Enforce Asia/Bangkok (UTC+7) across entire Node.js runtime
process.env.TZ = 'Asia/Bangkok';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { pool, query, getClient } = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());

// =========================================================================
// Public Health Check Endpoint (UptimeRobot / Keep-Alive / Cold-Start prevention)
// 100% Public: Placed before body parsing, static files, and any auth/session checks
// =========================================================================
app.get('/ping', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'pong' });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Extended diagnostics ping endpoint
app.get('/api/ping', (req, res) => {
  res.json({
    pong: true,
    status: 'ALIVE',
    serverTime: new Date().toISOString(),
    thaiTime: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
    timezone: 'Asia/Bangkok'
  });
});

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
  const [sy, sm, sd] = startDateStr.split('-').map(Number);
  const [ey, em, ed] = endDateStr.split('-').map(Number);
  const curr = new Date(Date.UTC(sy, sm - 1, sd));
  const end = new Date(Date.UTC(ey, em - 1, ed));
  while (curr <= end) {
    dates.push(curr.toISOString().split('T')[0]);
    curr.setUTCDate(curr.getUTCDate() + 1);
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
    const isAdminPrefix = cleanEmpId.startsWith('ADMIN');

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

      const isAdmin = isAdminPrefix || emp.role === 'ADMIN';
      const isSupervisor = isSupPrefix || emp.role === 'SUPERVISOR' || isAdmin;
      const userRole = isAdmin ? 'ADMIN' : (isSupervisor ? 'SUPERVISOR' : 'EMPLOYEE');
      return res.json({
        success: true,
        user: {
          id: emp.id,
          name: emp.name,
          department: emp.department,
          role: userRole,
          isSupervisor,
          isAdmin
        }
      });
    }

    // Strict Fallback if database is offline: only allow known demo IDs with PIN 1234
    const validDemoUsers = {
      'EMP-001': { name: 'สมชาย ใจดี', department: 'Assembly', role: 'EMPLOYEE', pin: '1234' },
      'EMP-002': { name: 'สมหญิง รักงาน', department: 'Assembly', role: 'EMPLOYEE', pin: '1234' },
      'SUP-001': { name: 'สมศักดิ์ คุมงาน (หัวหน้า)', department: 'Assembly', role: 'SUPERVISOR', pin: '1234' },
      'ADMIN-001': { name: 'ผู้ดูแลระบบ (Admin)', department: 'Management', role: 'ADMIN', pin: '1234' }
    };

    const demoUser = validDemoUsers[cleanEmpId];
    if (!demoUser) {
      return res.status(401).json({ error: 'ไม่พบรหัสพนักงานนี้ในระบบ (Employee ID not found)' });
    }
    if (demoUser.pin !== cleanPin) {
      return res.status(401).json({ error: 'รหัสผ่าน (PIN) ไม่ถูกต้อง (Incorrect PIN)' });
    }

    const isAdmin = isAdminPrefix || demoUser.role === 'ADMIN';
    const isSupervisor = isSupPrefix || demoUser.role === 'SUPERVISOR' || isAdmin;
    const userRole = isAdmin ? 'ADMIN' : (isSupervisor ? 'SUPERVISOR' : 'EMPLOYEE');
    return res.json({
      success: true,
      user: {
        id: cleanEmpId,
        name: demoUser.name,
        department: demoUser.department,
        role: userRole,
        isSupervisor,
        isAdmin
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
        const days = parseFloat(row.total_days || 0);
        if (type === 'Vacation') usedVacation += days;
        if (type === 'Personal') usedPersonal += days;
        if (type === 'Sick') usedSick += days;
      });

      usedVacation = Math.round(usedVacation * 100) / 100;
      usedPersonal = Math.round(usedPersonal * 100) / 100;
      usedSick = Math.round(usedSick * 100) / 100;
    }

    res.json({
      success: true,
      quota: {
        vacation: {
          total: totalVacation,
          used: usedVacation,
          remaining: Math.max(0, Math.round((totalVacation - usedVacation) * 100) / 100)
        },
        personal: {
          total: totalPersonal,
          used: usedPersonal,
          remaining: Math.max(0, Math.round((totalPersonal - usedPersonal) * 100) / 100)
        },
        sick: {
          total: totalSick,
          used: usedSick,
          remaining: Math.max(0, Math.round((totalSick - usedSick) * 100) / 100)
        }
      }
    });
  } catch (error) {
    console.error('Fetch quota error:', error);
    res.status(500).json({ error: 'ไม่สามารถโหลดข้อมูลโควตาได้' });
  }
});

// ==========================================
// 3.1 Department Calendar & Quota Usage API
// Returns active leaves per day for the department
// ==========================================
app.get('/api/department-calendar', async (req, res) => {
  try {
    const department = req.query.department || 'Assembly';
    const month = req.query.month; // e.g. "2026-09"

    let maxDailyLeaves = 2;
    if (pool) {
      const quotaRes = await query('SELECT max_daily_leaves FROM quota_settings WHERE UPPER(department) = UPPER($1)', [department]);
      if (quotaRes.rows.length > 0) {
        maxDailyLeaves = quotaRes.rows[0].max_daily_leaves;
      }
    }

    let year, m;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const parts = month.split('-').map(Number);
      year = parts[0];
      m = parts[1] - 1;
    } else {
      const now = new Date();
      year = now.getFullYear();
      m = now.getMonth();
    }
    const pad = (n) => String(n).padStart(2, '0');
    const firstDayStr = `${year}-${pad(m + 1)}-01`;
    const totalDays = new Date(year, m + 1, 0).getDate();
    const lastDayStr = `${year}-${pad(m + 1)}-${pad(totalDays)}`;

    const dailyUsage = {};

    if (pool) {
      const leavesRes = await query(
        `SELECT 
           lr.id,
           lr.employee_id,
           COALESCE(e.name, lr.employee_id) as employee_name,
           lr.leave_type,
           TO_CHAR(lr.start_date, 'YYYY-MM-DD') as start_date,
           TO_CHAR(lr.end_date, 'YYYY-MM-DD') as end_date,
           lr.duration_type,
           lr.start_time,
           lr.end_time,
           lr.hours_count,
           lr.status
         FROM leave_requests lr
         JOIN employees e ON lr.employee_id = e.id
         WHERE UPPER(e.department) = UPPER($1)
           AND lr.status IN ('APPROVED', 'PENDING')
           AND lr.start_date <= $3
           AND lr.end_date >= $2`,
        [department, firstDayStr, lastDayStr]
      );

      leavesRes.rows.forEach(row => {
        const dates = getDatesInRange(row.start_date, row.end_date);
        dates.forEach(d => {
          if (!dailyUsage[d]) {
            dailyUsage[d] = { count: 0, employees: [] };
          }
          const isSick = normalizeLeaveType(row.leave_type) === 'Sick';
          if (!isSick) {
            dailyUsage[d].count += 1;
          }
          dailyUsage[d].employees.push({
            name: row.employee_name,
            type: normalizeLeaveType(row.leave_type),
            status: row.status,
            durationType: row.duration_type || 'FULL_DAY',
            startTime: row.start_time || null,
            endTime: row.end_time || null,
            hoursCount: row.hours_count ? parseFloat(row.hours_count) : null
          });
        });
      });
    }

    Object.keys(dailyUsage).forEach(d => {
      dailyUsage[d].isFull = dailyUsage[d].count >= maxDailyLeaves;
    });

    res.json({
      success: true,
      department,
      maxDailyLeaves,
      firstDay: firstDayStr,
      lastDay: lastDayStr,
      dailyUsage
    });
  } catch (error) {
    console.error('Department calendar error:', error);
    res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลปฏิทินแผนกได้' });
  }
});

// ==========================================
// 4. Leave Request API
// Requirement: Check daily quota from Quota_Settings.
// Block if full (except Sick Leave), otherwise insert to database.
// ==========================================
app.post('/api/leave-requests', async (req, res) => {
  try {
    const { employeeId, leaveType, startDate, endDate, durationType, startTime, endTime, reason } = req.body;

    if (!employeeId || !leaveType || !startDate) {
      return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน (All fields required)' });
    }

    const isHourly = durationType === 'HOURLY';
    let cleanStartTime = null;
    let cleanEndTime = null;
    let cleanHoursCount = null;
    let actualEndDate = endDate || startDate;
    let daysCount = 1;

    if (isHourly) {
      if (!startTime || !endTime) {
        return res.status(400).json({ error: 'กรุณาระบุเวลาเริ่มต้นและเวลาสิ้นสุดสำหรับการลารายชั่วโมง' });
      }
      const [sh, sm] = startTime.split(':').map(Number);
      const [eh, em] = endTime.split(':').map(Number);
      const startMinutes = sh * 60 + sm;
      const endMinutes = eh * 60 + em;
      if (endMinutes <= startMinutes) {
        return res.status(400).json({ error: 'เวลาเริ่มต้นต้องน้อยกว่าเวลาสิ้นสุด (Start time must be before end time)' });
      }
      cleanStartTime = startTime;
      cleanEndTime = endTime;
      cleanHoursCount = Math.round(((endMinutes - startMinutes) / 60) * 100) / 100;
      daysCount = Math.round((cleanHoursCount / 8) * 100) / 100;
      actualEndDate = startDate;
    } else {
      if (!endDate) {
        return res.status(400).json({ error: 'กรุณาระบุวันสิ้นสุด' });
      }
      const start = new Date(startDate);
      const end = new Date(endDate);

      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return res.status(400).json({ error: 'รูปแบบวันที่ไม่ถูกต้อง' });
      }

      if (start > end) {
        return res.status(400).json({ error: 'วันเริ่มต้นต้องไม่เกินวันสิ้นสุด (Start date must be before end date)' });
      }

      const diffTime = Math.abs(end - start);
      daysCount = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
      actualEndDate = endDate;
    }

    const normalizedType = normalizeLeaveType(leaveType);
    const cleanEmpId = employeeId.trim().toUpperCase();

    // Business Rule Validation: Past Date Restrictions
    const todayBangkok = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());

    if (normalizedType !== 'Sick') {
      if (startDate < todayBangkok) {
        return res.status(400).json({
          error: 'การลาพักร้อนและลากิจต้องยื่นล่วงหน้า ไม่สามารถเลือกวันที่ในอดีตได้'
        });
      }
    } else {
      // Sick leave: allow maximum 3 calendar days in the past
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      const minSickDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(threeDaysAgo);

      if (startDate < minSickDate) {
        return res.status(400).json({
          error: 'การยื่นขอลาป่วยย้อนหลังสามารถทำได้ไม่เกิน 3 วันทำการ'
        });
      }
    }

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
          end_date: actualEndDate,
          days_count: daysCount,
          duration_type: isHourly ? 'HOURLY' : 'FULL_DAY',
          start_time: cleanStartTime,
          end_time: cleanEndTime,
          hours_count: cleanHoursCount,
          reason,
          status: 'PENDING'
        }
      });
    }

    // =========================================================================
    // RACE CONDITION & ATOMIC TRANSACTION PROTECTION
    // Use an exclusive transaction with FOR UPDATE row locking on quota_settings
    // This serializes concurrent requests for the same department, guaranteeing
    // that two simultaneous requests cannot both read quota=1 and both pass!
    // =========================================================================
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // 1. Fetch employee & department
      const empRes = await client.query('SELECT * FROM employees WHERE UPPER(id) = $1', [cleanEmpId]);
      let department = 'Assembly';
      let empRecord = null;
      if (empRes.rows.length > 0) {
        empRecord = empRes.rows[0];
        department = empRecord.department;
      }

      // 2. Duplicate Request / Double-Click Guard:
      // Prevent accidental duplicate submission for overlapping dates
      const dupRes = await client.query(
        `SELECT id, leave_type, TO_CHAR(start_date, 'YYYY-MM-DD') as start_date, 
                TO_CHAR(end_date, 'YYYY-MM-DD') as end_date, status
         FROM leave_requests
         WHERE UPPER(employee_id) = $1
           AND status IN ('PENDING', 'APPROVED')
           AND start_date <= $2 AND end_date >= $3
         LIMIT 1`,
        [cleanEmpId, actualEndDate, startDate]
      );

      if (dupRes.rows.length > 0) {
        await client.query('ROLLBACK');
        const dup = dupRes.rows[0];
        return res.status(400).json({
          error: `⚠️ คุณมีคำขอลางาน (${dup.leave_type}) ในช่วงวันที่ดังกล่าวอยู่แล้ว (${dup.start_date} ถึง ${dup.end_date}, สถานะ: ${dup.status}) กรุณาอย่าส่งซ้ำ`
        });
      }

      // 3. Check employee individual remaining balance (Vacation & Personal)
      if (normalizedType !== 'Sick' && empRecord) {
        const currentYear = new Date().getFullYear();
        const usedRes = await client.query(
          `SELECT COALESCE(SUM(days_count), 0) as used
           FROM leave_requests
           WHERE UPPER(employee_id) = $1
             AND leave_type = $2
             AND status IN ('APPROVED', 'PENDING')
             AND EXTRACT(YEAR FROM start_date) = $3`,
          [cleanEmpId, normalizedType, currentYear]
        );
        const used = parseFloat(usedRes.rows[0].used || 0);
        const totalAllowed = normalizedType === 'Vacation' ? empRecord.vacation_quota : empRecord.personal_quota;
        if (used + daysCount > totalAllowed) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `โควตาวันลาของคุณไม่เพียงพอ (เหลือ ${Math.max(0, Math.round((totalAllowed - used) * 100) / 100)} วัน, ต้องการขอ ${daysCount} วัน)`
          });
        }
      }

      // 4. Daily Department Quota Check with ROW-LEVEL LOCK
      // "SELECT ... FOR UPDATE" blocks any concurrent transaction in the same department
      // until this transaction commits, eliminating race conditions completely!
      if (normalizedType !== 'Sick') {
        const quotaRes = await client.query(
          'SELECT max_daily_leaves FROM quota_settings WHERE UPPER(department) = UPPER($1) FOR UPDATE',
          [department]
        );
        const maxDailyLeaves = quotaRes.rows.length > 0 ? quotaRes.rows[0].max_daily_leaves : 2;

        const requestedDates = getDatesInRange(startDate, actualEndDate);

        for (const date of requestedDates) {
          const countRes = await client.query(
            `SELECT COUNT(DISTINCT lr.employee_id) as active_count
             FROM leave_requests lr
             JOIN employees e ON lr.employee_id = e.id
             WHERE UPPER(e.department) = UPPER($1)
               AND lr.status IN ('APPROVED', 'PENDING')
               AND lr.leave_type != 'Sick'
               AND $2 BETWEEN lr.start_date AND lr.end_date
               AND UPPER(lr.employee_id) != $3`,
            [department, date, cleanEmpId]
          );

          const currentOnLeave = parseInt(countRes.rows[0].active_count, 10);

          if (currentOnLeave >= maxDailyLeaves) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: `⚠️ โควตาลางานของแผนก ${department} เต็มแล้วในวันที่ ${date} (จำกัดไม่เกิน ${maxDailyLeaves} คน/วัน) ยกเว้นกรณีลาป่วยเท่านั้น`,
              blockedDate: date,
              maxDailyLeaves,
              currentOnLeave
            });
          }
        }
      }

      // 5. Insert Leave Request
      const insertRes = await client.query(
        `INSERT INTO leave_requests (
           employee_id, leave_type, start_date, end_date, days_count,
           duration_type, start_time, end_time, hours_count, reason, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING')
         RETURNING *`,
        [
          cleanEmpId,
          normalizedType,
          startDate,
          actualEndDate,
          daysCount,
          isHourly ? 'HOURLY' : 'FULL_DAY',
          cleanStartTime,
          cleanEndTime,
          cleanHoursCount,
          reason || ''
        ]
      );

      // Commit the transaction atomically
      await client.query('COMMIT');

      res.status(201).json({
        success: true,
        message: isHourly 
          ? `ส่งคำขอลางานรายชั่วโมง (${cleanStartTime} - ${cleanEndTime} น. • ${cleanHoursCount} ชม.) เรียบร้อยแล้ว`
          : 'ส่งคำขอลางานเรียบร้อยแล้ว (Leave request submitted successfully)',
        request: insertRes.rows[0]
      });
    } catch (txError) {
      await client.query('ROLLBACK').catch(() => {});
      throw txError;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Leave request error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกคำขอลางาน: ' + error.message });
  }
});

// ==========================================
// 4.1 Cancel Leave Request API (Employee Self-Service & Supervisor)
// Allows employee to withdraw their own PENDING request
// ==========================================
app.delete('/api/leave-requests/:id', async (req, res) => {
  try {
    const requestId = req.params.id;
    const employeeId = (req.body && req.body.employeeId) || req.query.employeeId;

    if (!pool) {
      return res.json({
        success: true,
        message: 'ยกเลิกคำขอลางานเรียบร้อยแล้ว (Demo mode)',
        id: requestId
      });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      const reqRes = await client.query(
        'SELECT * FROM leave_requests WHERE id = $1 FOR UPDATE',
        [requestId]
      );

      if (reqRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'ไม่พบคำขอลางานนี้' });
      }

      const leaveReq = reqRes.rows[0];

      // Authorization check: employee must be owner or supervisor
      if (!employeeId) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'กรุณาระบุรหัสพนักงานผู้ขอยกเลิกคำขอ' });
      }

      const cleanEmpId = employeeId.trim().toUpperCase();
      const isOwner = leaveReq.employee_id.toUpperCase() === cleanEmpId;
      let isSupervisor = cleanEmpId.startsWith('SUP');
      if (!isSupervisor) {
        const empRoleRes = await client.query('SELECT role FROM employees WHERE UPPER(id) = $1', [cleanEmpId]);
        if (empRoleRes.rows.length > 0 && empRoleRes.rows[0].role === 'SUPERVISOR') {
          isSupervisor = true;
        }
      }
      if (!isOwner && !isSupervisor) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ยกเลิกคำขอนี้' });
      }

      if (leaveReq.status !== 'PENDING') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `ไม่สามารถยกเลิกได้ เนื่องจากคำขอนี้ได้รับการพิจารณาเป็น "${leaveReq.status}" แล้ว`
        });
      }

      const updateRes = await client.query(
        `UPDATE leave_requests
         SET status = 'CANCELLED',
             reviewed_at = CURRENT_TIMESTAMP,
             rejection_reason = 'ยกเลิกโดยผู้ยื่นคำขอ'
         WHERE id = $1
         RETURNING *`,
        [requestId]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'ยกเลิกคำขอลางานเรียบร้อยแล้ว โควตาถูกคืนเข้าระบบทันที',
        request: updateRes.rows[0]
      });
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Cancel leave request error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการยกเลิกคำขอ: ' + error.message });
  }
});

// ==========================================
// 5. Leave Requests List API
// - status=PENDING (For Supervisor pending queue)
// - status=HISTORY (For Supervisor resolved history)
// - employee_id=EMP-001 (For Employee history)
// - department=Assembly (Filter by Department)
// - supervisor_id=SUP-001 (Filter by Supervisor's Department)
// ==========================================
app.get('/api/leave-requests', async (req, res) => {
  try {
    const { status, employee_id, department, supervisor_id } = req.query;

    let targetDept = (department || '').trim();
    if (!targetDept && supervisor_id && pool) {
      const supDeptRes = await query('SELECT department FROM employees WHERE UPPER(id) = $1', [supervisor_id.trim().toUpperCase()]);
      if (supDeptRes.rows.length > 0) {
        targetDept = supDeptRes.rows[0].department;
      }
    }

    if (!pool) {
      // Demo mock responses
      let demoList = [
        {
          id: 101,
          employee_id: 'EMP-001',
          employee_name: 'สมชาย ใจดี',
          department: 'Assembly',
          leave_type: 'Vacation',
          start_date: '2026-09-15',
          end_date: '2026-09-15',
          days_count: 1,
          reason: 'พาครอบครัวไปทำธุระ',
          status: 'PENDING',
          rejection_reason: null,
          created_at: new Date().toISOString()
        }
      ];
      if (targetDept) {
        demoList = demoList.filter(r => r.department && r.department.toLowerCase() === targetDept.toLowerCase());
      }
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
        lr.duration_type,
        lr.start_time,
        lr.end_time,
        lr.hours_count,
        lr.reason,
        lr.status,
        lr.reviewed_by,
        COALESCE(rev.name, lr.reviewed_by) AS reviewer_name,
        lr.reviewed_at,
        lr.rejection_reason,
        lr.created_at
      FROM leave_requests lr
      JOIN employees e ON lr.employee_id = e.id
      LEFT JOIN employees rev ON UPPER(lr.reviewed_by) = UPPER(rev.id)
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      const s = status.toUpperCase();
      if (s === 'HISTORY') {
        sql += " AND UPPER(lr.status) IN ('APPROVED', 'REJECTED', 'CANCELLED')";
      } else {
        params.push(s);
        sql += ` AND UPPER(lr.status) = $${params.length}`;
      }
    }

    if (employee_id) {
      params.push(employee_id.trim().toUpperCase());
      sql += ` AND UPPER(lr.employee_id) = $${params.length}`;
    }

    if (targetDept) {
      params.push(targetDept.toUpperCase());
      sql += ` AND UPPER(e.department) = $${params.length}`;
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

    // Verify supervisor/admin authorization (starts with SUP/ADMIN or role is SUPERVISOR/ADMIN in DB)
    let isAuthorizedSupervisor = supervisorId.startsWith('SUP') || supervisorId.startsWith('ADMIN');
    if (!isAuthorizedSupervisor && pool) {
      const supCheck = await query('SELECT role FROM employees WHERE UPPER(id) = $1', [supervisorId]);
      if (supCheck.rows.length > 0 && (supCheck.rows[0].role === 'SUPERVISOR' || supCheck.rows[0].role === 'ADMIN')) {
        isAuthorizedSupervisor = true;
      }
    }
    if (!isAuthorizedSupervisor) {
      return res.status(403).json({ error: 'เฉพาะหัวหน้างาน (Supervisor) หรือผู้ดูแลระบบเท่านั้นที่สามารถอนุมัติหรือปฏิเสธคำขอได้' });
    }

    if (!pool) {
      return res.json({
        success: true,
        message: `ดำเนินการ ${cleanStatus === 'APPROVED' ? 'อนุมัติ' : 'ไม่อนุมัติ'} เรียบร้อยแล้ว (Demo mode)`,
        request: { id: requestId, status: cleanStatus, reviewed_by: supervisorId }
      });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Check current status with lock to avoid race conditions between approvals
      const currentRes = await client.query('SELECT status FROM leave_requests WHERE id = $1 FOR UPDATE', [requestId]);
      if (currentRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'ไม่พบคำขอลางานนี้' });
      }

      const currentStatus = currentRes.rows[0].status;
      if (currentStatus !== 'PENDING') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `คำขอนี้ได้รับการพิจารณาไปแล้ว (สถานะปัจจุบัน: ${currentStatus}) ไม่สามารถแก้ไขซ้ำได้`
        });
      }

      const updateRes = await client.query(
        `UPDATE leave_requests
         SET status = $1,
             reviewed_by = $2,
             reviewed_at = CURRENT_TIMESTAMP,
             rejection_reason = $3
         WHERE id = $4
         RETURNING *`,
        [cleanStatus, supervisorId, rejectionReason || null, requestId]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        message: `ดำเนินการ ${cleanStatus === 'APPROVED' ? 'อนุมัติ' : 'ไม่อนุมัติ'} คำขอเรียบร้อยแล้ว`,
        request: updateRes.rows[0]
      });
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Review leave request error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัปเดตสถานะคำขอ: ' + error.message });
  }
});

// ==========================================
// 8. Departments API
// Returns distinct departments list for dropdowns
// ==========================================
app.get('/api/departments', async (req, res) => {
  try {
    if (pool) {
      const qsRes = await query('SELECT department, max_daily_leaves FROM quota_settings ORDER BY department ASC');
      const empRes = await query('SELECT DISTINCT department FROM employees WHERE department IS NOT NULL');
      
      const deptMap = new Map();
      qsRes.rows.forEach(r => {
        deptMap.set(r.department.trim(), { name: r.department.trim(), maxDailyLeaves: r.max_daily_leaves });
      });
      empRes.rows.forEach(r => {
        const name = r.department.trim();
        if (!deptMap.has(name)) {
          deptMap.set(name, { name, maxDailyLeaves: 2 });
        }
      });

      const departments = Array.from(deptMap.values()).sort((a, b) => a.name.localeCompare(b.name));
      return res.json({ success: true, departments });
    }

    // Demo fallback
    res.json({
      success: true,
      departments: [
        { name: 'Assembly', maxDailyLeaves: 2 },
        { name: 'Crimping 1', maxDailyLeaves: 5 },
        { name: 'QC', maxDailyLeaves: 1 }
      ]
    });
  } catch (error) {
    console.error('Fetch departments error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงรายชื่อแผนก' });
  }
});

// ==========================================
// 9. Admin Employee Management API
// Add new employee to the database (ADMIN exclusive)
// ==========================================
app.post('/api/employees', async (req, res) => {
  try {
    const { 
      adminId, 
      id, 
      name, 
      department, 
      role = 'EMPLOYEE', 
      pin, 
      vacation_quota, 
      personal_quota, 
      sick_quota 
    } = req.body;

    // Check admin authorization
    const cleanAdminId = (adminId || '').trim().toUpperCase();
    if (!cleanAdminId) {
      return res.status(403).json({ error: 'กรุณาระบุรหัสผู้ดูแลระบบ (Admin ID required)' });
    }

    let isAuthorizedAdmin = cleanAdminId.startsWith('ADMIN');
    if (!isAuthorizedAdmin && pool) {
      const adminCheck = await query('SELECT role FROM employees WHERE UPPER(id) = $1', [cleanAdminId]);
      if (adminCheck.rows.length > 0 && adminCheck.rows[0].role === 'ADMIN') {
        isAuthorizedAdmin = true;
      }
    }

    if (!isAuthorizedAdmin) {
      return res.status(403).json({ error: 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่สามารถเพิ่มพนักงานใหม่ได้' });
    }

    // Validation
    const cleanEmpId = (id || '').trim().toUpperCase();
    const cleanName = (name || '').trim();
    const cleanDept = (department || '').trim();
    const cleanRole = (role || 'EMPLOYEE').trim().toUpperCase();
    const cleanPin = (pin ? pin.toString().trim() : cleanEmpId); // Default PIN is employee ID

    if (!cleanEmpId || !cleanName || !cleanDept) {
      return res.status(400).json({ error: 'กรุณากรอกรหัสพนักงาน ชื่อ-นามสกุล และแผนกให้ครบถ้วน' });
    }

    if (!['EMPLOYEE', 'SUPERVISOR', 'ADMIN'].includes(cleanRole)) {
      return res.status(400).json({ error: 'บทบาทต้องเป็น EMPLOYEE, SUPERVISOR หรือ ADMIN' });
    }

    const vacQuota = Number.isInteger(Number(vacation_quota)) && Number(vacation_quota) >= 0 
      ? Number(vacation_quota) 
      : (cleanRole === 'SUPERVISOR' || cleanRole === 'ADMIN' ? 10 : 6);
    const perQuota = Number.isInteger(Number(personal_quota)) && Number(personal_quota) >= 0 
      ? Number(personal_quota) 
      : 6;
    const sicQuota = Number.isInteger(Number(sick_quota)) && Number(sick_quota) >= 0 
      ? Number(sick_quota) 
      : 30;

    if (!pool) {
      return res.status(201).json({
        success: true,
        message: `เพิ่มข้อมูลพนักงาน [${cleanEmpId}] ${cleanName} เรียบร้อยแล้ว (Demo mode)`,
        employee: {
          id: cleanEmpId,
          name: cleanName,
          department: cleanDept,
          role: cleanRole,
          pin: cleanPin,
          vacation_quota: vacQuota,
          personal_quota: perQuota,
          sick_quota: sicQuota
        }
      });
    }

    // Check duplicate ID
    const dupCheck = await query('SELECT id FROM employees WHERE UPPER(id) = $1', [cleanEmpId]);
    if (dupCheck.rows.length > 0) {
      return res.status(409).json({ error: `รหัสพนักงาน ${cleanEmpId} มีอยู่ในระบบแล้ว` });
    }

    // Insert employee
    const insertRes = await query(`
      INSERT INTO employees (id, name, department, pin, role, vacation_quota, personal_quota, sick_quota)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, name, department, role, vacation_quota, personal_quota, sick_quota, created_at
    `, [cleanEmpId, cleanName, cleanDept, cleanPin, cleanRole, vacQuota, perQuota, sicQuota]);

    // Ensure department exists in quota_settings
    await query(`
      INSERT INTO quota_settings (department, max_daily_leaves)
      VALUES ($1, 2)
      ON CONFLICT (department) DO NOTHING
    `, [cleanDept]);

    res.status(201).json({
      success: true,
      message: `เพิ่มพนักงาน [${cleanEmpId}] ${cleanName} สำเร็จแล้ว`,
      employee: insertRes.rows[0]
    });

  } catch (error) {
    console.error('Error adding employee:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการเพิ่มพนักงาน: ' + error.message });
  }
});

// ==========================================
// 10. Get Employees List API (For Admin Directory)
// ==========================================
app.get('/api/employees', async (req, res) => {
  try {
    const { department, role, search } = req.query;
    if (pool) {
      let sql = 'SELECT id, name, department, role, vacation_quota, personal_quota, sick_quota, created_at FROM employees WHERE 1=1';
      const params = [];
      if (department && department !== 'ALL') {
        params.push(department.trim());
        sql += ` AND UPPER(department) = UPPER($${params.length})`;
      }
      if (role && role !== 'ALL') {
        params.push(role.trim().toUpperCase());
        sql += ` AND UPPER(role) = UPPER($${params.length})`;
      }
      if (search) {
        params.push(`%${search.trim().toLowerCase()}%`);
        sql += ` AND (LOWER(id) LIKE $${params.length} OR LOWER(name) LIKE $${params.length})`;
      }
      sql += ' ORDER BY department ASC, role DESC, id ASC';
      const result = await query(sql, params);
      return res.json({ success: true, count: result.rows.length, employees: result.rows });
    }

    // Demo fallback
    res.json({
      success: true,
      count: 4,
      employees: [
        { id: 'ADMIN-001', name: 'ผู้ดูแลระบบ (Admin)', department: 'Management', role: 'ADMIN' },
        { id: 'SUP-001', name: 'สมศักดิ์ คุมงาน (หัวหน้า)', department: 'Assembly', role: 'SUPERVISOR' },
        { id: 'EMP-001', name: 'สมชาย สายลุย', department: 'Crimping 1', role: 'EMPLOYEE' },
        { id: 'EMP-002', name: 'สมหญิง จริงใจ', department: 'Crimping 1', role: 'EMPLOYEE' }
      ]
    });
  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลพนักงาน: ' + error.message });
  }
});

// ==========================================
// 11. Edit Employee API (ADMIN exclusive)
// ==========================================
app.put('/api/employees/:id', async (req, res) => {
  try {
    const targetId = (req.params.id || '').trim().toUpperCase();
    const { 
      adminId, 
      name, 
      department, 
      role, 
      pin, 
      vacation_quota, 
      personal_quota, 
      sick_quota 
    } = req.body;

    // Check admin authorization
    const cleanAdminId = (adminId || '').trim().toUpperCase();
    if (!cleanAdminId) {
      return res.status(403).json({ error: 'กรุณาระบุรหัสผู้ดูแลระบบ (Admin ID required)' });
    }

    let isAuthorizedAdmin = cleanAdminId.startsWith('ADMIN');
    if (!isAuthorizedAdmin && pool) {
      const adminCheck = await query('SELECT role FROM employees WHERE UPPER(id) = $1', [cleanAdminId]);
      if (adminCheck.rows.length > 0 && adminCheck.rows[0].role === 'ADMIN') {
        isAuthorizedAdmin = true;
      }
    }

    if (!isAuthorizedAdmin) {
      return res.status(403).json({ error: 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่สามารถแก้ไขข้อมูลพนักงานได้' });
    }

    if (!pool) {
      return res.json({
        success: true,
        message: `แก้ไขข้อมูลพนักงาน [${targetId}] สำเร็จแล้ว (Demo mode)`
      });
    }

    // Check if employee exists
    const empCheck = await query('SELECT * FROM employees WHERE UPPER(id) = $1', [targetId]);
    if (empCheck.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบข้อมูลพนักงานรหัสนี้ในระบบ' });
    }

    const currentEmp = empCheck.rows[0];
    const newName = name !== undefined ? name.trim() : currentEmp.name;
    const newDept = department !== undefined ? department.trim() : currentEmp.department;
    const newRole = role !== undefined ? role.trim().toUpperCase() : currentEmp.role;
    const newPin = (pin !== undefined && pin.toString().trim() !== '') ? pin.toString().trim() : currentEmp.pin;
    const newVac = Number.isInteger(Number(vacation_quota)) ? Number(vacation_quota) : currentEmp.vacation_quota;
    const newPer = Number.isInteger(Number(personal_quota)) ? Number(personal_quota) : currentEmp.personal_quota;
    const newSic = Number.isInteger(Number(sick_quota)) ? Number(sick_quota) : currentEmp.sick_quota;

    const updateRes = await query(`
      UPDATE employees
      SET name = $1,
          department = $2,
          role = $3,
          pin = $4,
          vacation_quota = $5,
          personal_quota = $6,
          sick_quota = $7
      WHERE UPPER(id) = $8
      RETURNING id, name, department, role, vacation_quota, personal_quota, sick_quota
    `, [newName, newDept, newRole, newPin, newVac, newPer, newSic, targetId]);

    // Ensure department exists in quota_settings
    if (newDept) {
      await query(`
        INSERT INTO quota_settings (department, max_daily_leaves)
        VALUES ($1, 2)
        ON CONFLICT (department) DO NOTHING
      `, [newDept]);
    }

    res.json({
      success: true,
      message: `แก้ไขข้อมูลพนักงาน [${targetId}] ${newName} สำเร็จแล้ว`,
      employee: updateRes.rows[0]
    });
  } catch (error) {
    console.error('Error updating employee:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการแก้ไขข้อมูลพนักงาน: ' + error.message });
  }
});


// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Leave Management Server is running on http://localhost:${PORT}`);
});

module.exports = app;
