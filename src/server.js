// Enforce Asia/Bangkok (UTC+7) across entire Node.js runtime
process.env.TZ = 'Asia/Bangkok';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { pool, query, getClient } = require('./db');
const googleSheetsService = require('./googleSheetsService');
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

// Serve Google Apps Script raw template file
app.get('/google-apps-script.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'google-apps-script.js'));
});

// Increase JSON and URL-encoded payload limit for medical certificate / base64 image uploads
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Ensure public/uploads directory exists
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  } catch (e) {
    console.warn('Could not create uploads directory:', e.message);
  }
}

// Serve uploaded attachments directly
app.use('/uploads', express.static(UPLOADS_DIR));

app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (filePath.endsWith('sw.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    } else if (filePath.endsWith('manifest.json') || filePath.endsWith('.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

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

// Helper: Save Base64 or uploaded attachment to disk and return URL
function saveBase64Attachment(dataUrl, prefix = 'cert') {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const trimmed = dataUrl.trim();
  if (!trimmed) return null;

  // If already an existing URL or path
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('/uploads/')) {
    return trimmed;
  }

  // If Base64 Data URL (e.g. data:image/jpeg;base64,...)
  const matches = trimmed.match(/^data:([A-Za-z0-9\-+\/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    return trimmed;
  }

  try {
    const mimeType = matches[1].toLowerCase();
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    let ext = '.jpg';
    if (mimeType.includes('png')) ext = '.png';
    else if (mimeType.includes('webp')) ext = '.webp';
    else if (mimeType.includes('pdf')) ext = '.pdf';

    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }

    const cleanPrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '');
    const uniqueName = `${cleanPrefix}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}${ext}`;
    const filePath = path.join(UPLOADS_DIR, uniqueName);
    fs.writeFileSync(filePath, buffer);

    return `/uploads/${uniqueName}`;
  } catch (err) {
    console.error('Failed to save base64 attachment to disk:', err);
    // Return original dataUrl as fallback so nothing is lost
    return trimmed;
  }
}

// Dedicated Attachment Upload API
app.post('/api/upload-attachment', async (req, res) => {
  try {
    const { dataUrl, filename, prefix } = req.body;
    if (!dataUrl) {
      return res.status(400).json({ error: 'ไม่พบข้อมูลไฟล์ที่ต้องการอัปโหลด' });
    }
    const savedUrl = saveBase64Attachment(dataUrl, prefix || 'cert');
    if (!savedUrl) {
      return res.status(400).json({ error: 'ไม่สามารถบันทึกไฟล์ได้ รูปแบบไฟล์ไม่ถูกต้อง' });
    }
    res.json({
      success: true,
      url: savedUrl,
      filename: filename || path.basename(savedUrl)
    });
  } catch (err) {
    console.error('Upload attachment error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัปโหลดไฟล์: ' + err.message });
  }
});

// Helper: Auto-ensure database schema has unpaid_quota, attachment_url & system_settings
let dbSchemaPromise = null;
async function ensureDatabaseSchema() {
  if (dbSchemaPromise) return dbSchemaPromise;
  dbSchemaPromise = (async () => {
    if (!pool) {
      await googleSheetsService.init(null, null);
      return;
    }
    try {
      await query(`
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS unpaid_quota INT NOT NULL DEFAULT 30;
        ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS attachment_url TEXT;
        CREATE TABLE IF NOT EXISTS system_settings (
          key VARCHAR(100) PRIMARY KEY,
          value TEXT,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await googleSheetsService.init(pool, query);
    } catch (err) {
      console.warn('⚠️ Auto-migration notice:', err.message);
      await googleSheetsService.init(pool, query);
    }
  })();
  return dbSchemaPromise;
}
ensureDatabaseSchema();

// Helper: Normalize Leave Type to standard key
function normalizeLeaveType(type) {
  if (!type) return 'Vacation';
  const lower = type.toLowerCase();
  if (lower.includes('unpaid') || lower.includes('ไม่รับค่าจ้าง')) return 'Unpaid';
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

function normalizeShift(shift) {
  if (!shift) return 'A';
  const s = shift.toString().trim().toUpperCase();
  if (s === 'B' || s.includes('กะ B') || s.includes('กะB') || s === 'NIGHT') return 'B';
  if (s === 'MORNING' || s.includes('เช้า')) return 'Morning';
  return 'A';
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
          shift: emp.shift || 'A',
          role: userRole,
          isSupervisor,
          isAdmin
        }
      });
    }

    // Strict Fallback if database is offline: only allow known demo IDs with PIN 1234
    const validDemoUsers = {
      'EMP-001': { name: 'สมชาย ใจดี', department: 'Assembly', shift: 'A', role: 'EMPLOYEE', pin: '1234' },
      'EMP-002': { name: 'สมหญิง รักงาน', department: 'Assembly', shift: 'B', role: 'EMPLOYEE', pin: '1234' },
      'SUP-001': { name: 'สมศักดิ์ คุมงาน (หัวหน้า)', department: 'Assembly', shift: 'Morning', role: 'SUPERVISOR', pin: '1234' },
      'ADMIN-001': { name: 'ผู้ดูแลระบบ (Admin)', department: 'Management', shift: 'Morning', role: 'ADMIN', pin: '1234' }
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
        shift: demoUser.shift || 'A',
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
    let totalUnpaid = 30;

    let usedVacation = 0;
    let usedPersonal = 0;
    let usedSick = 0;
    let usedUnpaid = 0;

    if (pool) {
      // Get base quota from employee record
      const empRes = await query('SELECT vacation_quota, personal_quota, sick_quota, COALESCE(unpaid_quota, 30) as unpaid_quota FROM employees WHERE UPPER(id) = $1', [empId]);
      if (empRes.rows.length > 0) {
        totalVacation = empRes.rows[0].vacation_quota;
        totalPersonal = empRes.rows[0].personal_quota;
        totalSick = empRes.rows[0].sick_quota;
        totalUnpaid = empRes.rows[0].unpaid_quota !== undefined ? empRes.rows[0].unpaid_quota : 30;
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
        if (type === 'Unpaid') usedUnpaid += days;
      });

      usedVacation = Math.round(usedVacation * 100) / 100;
      usedPersonal = Math.round(usedPersonal * 100) / 100;
      usedSick = Math.round(usedSick * 100) / 100;
      usedUnpaid = Math.round(usedUnpaid * 100) / 100;
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
        },
        unpaid: {
          total: totalUnpaid,
          used: usedUnpaid,
          remaining: Math.max(0, Math.round((totalUnpaid - usedUnpaid) * 100) / 100)
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
    const shift = (req.query.shift || '').trim(); // e.g. 'A' or 'B'
    const month = req.query.month; // e.g. "2026-09"

    let quotasByShift = { 'A': 3, 'B': 3, 'Morning': 2 };
    let maxDailyLeaves = 2;

    if (pool) {
      const quotaSql = 'SELECT shift, max_daily_leaves FROM quota_settings WHERE UPPER(department) = UPPER($1)';
      const quotaRes = await query(quotaSql, [department]);
      if (quotaRes.rows.length > 0) {
        quotaRes.rows.forEach(r => {
          let s = (r.shift || 'A').trim();
          if (s.toUpperCase() === 'DAY') s = 'A';
          if (s.toUpperCase() === 'NIGHT') s = 'B';
          quotasByShift[s] = r.max_daily_leaves;
        });
      }
      if (shift && quotasByShift[shift]) {
        maxDailyLeaves = quotasByShift[shift];
      } else if (quotasByShift['A']) {
        maxDailyLeaves = quotasByShift['A'];
      }
    } else {
      // Demo fallback
      if (department.toLowerCase() === 'crimping 1') {
        quotasByShift = { 'A': 3, 'B': 3, 'Morning': 2 };
      } else if (department.toLowerCase() === 'qc') {
        quotasByShift = { 'A': 1, 'B': 1, 'Morning': 2 };
      } else {
        quotasByShift = { 'A': 2, 'B': 2, 'Morning': 2 };
      }
      maxDailyLeaves = (shift && quotasByShift[shift]) ? quotasByShift[shift] : quotasByShift['A'];
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
      let leavesSql = `
        SELECT 
          lr.id,
          lr.employee_id,
          COALESCE(e.name, lr.employee_id) as employee_name,
          COALESCE(e.shift, 'A') as shift,
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
          AND lr.end_date >= $2
      `;
      const leavesParams = [department, firstDayStr, lastDayStr];
      if (shift) {
        leavesParams.push(shift);
        leavesSql += ` AND UPPER(COALESCE(e.shift, 'A')) = UPPER($${leavesParams.length})`;
      }

      const leavesRes = await query(leavesSql, leavesParams);

      leavesRes.rows.forEach(row => {
        const dates = getDatesInRange(row.start_date, row.end_date);
        dates.forEach(d => {
          if (!dailyUsage[d]) {
            dailyUsage[d] = {
              count: 0,
              shifts: {},
              employees: []
            };
            Object.keys(quotasByShift).forEach(s => {
              dailyUsage[d].shifts[s] = {
                count: 0,
                maxQuota: quotasByShift[s] || 2,
                isFull: false
              };
            });
          }

          let rShift = (row.shift || 'A').trim();
          if (rShift.toUpperCase() === 'B' || rShift.toUpperCase() === 'NIGHT') rShift = 'B';
          else if (rShift.toUpperCase() === 'MORNING') rShift = 'Morning';
          else if (rShift.toUpperCase() === 'A' || rShift.toUpperCase() === 'DAY') rShift = 'A';

          if (!dailyUsage[d].shifts[rShift]) {
            dailyUsage[d].shifts[rShift] = {
              count: 0,
              maxQuota: quotasByShift[rShift] || 2,
              isFull: false
            };
          }

          const isSick = normalizeLeaveType(row.leave_type) === 'Sick';
          if (!isSick) {
            dailyUsage[d].shifts[rShift].count += 1;
            dailyUsage[d].count += 1;
          }

          dailyUsage[d].employees.push({
            id: row.id,
            employeeId: row.employee_id,
            name: row.employee_name,
            shift: rShift,
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
      Object.keys(dailyUsage[d].shifts).forEach(s => {
        const sObj = dailyUsage[d].shifts[s];
        sObj.isFull = sObj.count >= sObj.maxQuota;
      });

      if (shift) {
        const sObj = dailyUsage[d].shifts[shift];
        dailyUsage[d].isFull = sObj ? sObj.isFull : false;
        dailyUsage[d].count = sObj ? sObj.count : 0;
      } else {
        const sValues = Object.values(dailyUsage[d].shifts);
        dailyUsage[d].isFull = sValues.length > 0 && sValues.every(s => s.isFull);
      }
    });

    res.json({
      success: true,
      department,
      shift: shift || 'All',
      maxDailyLeaves,
      quotasByShift,
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
    const { employeeId, leaveType, startDate, endDate, durationType, startTime, endTime, reason, attachmentUrl, attachment_url, attachment } = req.body;

    if (!employeeId || !leaveType || !startDate) {
      return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน (All fields required)' });
    }

    const isHourly = durationType === 'HOURLY';
    let cleanStartTime = null;
    let cleanEndTime = null;
    let cleanHoursCount = null;
    let actualEndDate = endDate || startDate;
    let daysCount = 1;

    // Process attachment (Base64 or URL)
    const rawAttachment = attachmentUrl || attachment_url || attachment || null;
    const cleanAttachmentUrl = rawAttachment ? saveBase64Attachment(rawAttachment, `emp-${employeeId.trim().toUpperCase()}`) : null;

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
      const demoRequest = {
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
        attachment_url: cleanAttachmentUrl,
        status: 'PENDING'
      };
      googleSheetsService.syncLeaveRequestAsync(demoRequest, 'CREATE_LEAVE');
      return res.status(201).json({
        success: true,
        message: 'ส่งคำขอลางานเรียบร้อยแล้ว (Demo mode)',
        request: demoRequest
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
      if (empRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `ไม่พบรหัสพนักงาน "${cleanEmpId}" ในระบบ (Employee not found)` });
      }
      const empRecord = empRes.rows[0];
      const department = empRecord.department;

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
        const totalAllowed = normalizedType === 'Vacation' 
          ? empRecord.vacation_quota 
          : (normalizedType === 'Personal' 
              ? empRecord.personal_quota 
              : (empRecord.unpaid_quota !== undefined ? empRecord.unpaid_quota : 30));
        if (used + daysCount > totalAllowed) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `โควตาวันลาของคุณไม่เพียงพอ (เหลือ ${Math.max(0, Math.round((totalAllowed - used) * 100) / 100)} วัน, ต้องการขอ ${daysCount} วัน)`
          });
        }
      }

      // 4. Daily Department & Shift Quota Check with ROW-LEVEL LOCK
      // "SELECT ... FOR UPDATE" blocks any concurrent transaction in the same department and shift
      // until this transaction commits, eliminating race conditions completely!
      const employeeShift = (empRecord && empRecord.shift) ? empRecord.shift : 'A';

      if (normalizedType !== 'Sick') {
        const quotaRes = await client.query(
          `SELECT max_daily_leaves 
           FROM quota_settings 
           WHERE UPPER(department) = UPPER($1) AND UPPER(COALESCE(shift, 'A')) = UPPER($2) 
           FOR UPDATE`,
          [department, employeeShift]
        );
        const maxDailyLeaves = quotaRes.rows.length > 0 ? quotaRes.rows[0].max_daily_leaves : 2;

        const requestedDates = getDatesInRange(startDate, actualEndDate);

        for (const date of requestedDates) {
          const countRes = await client.query(
            `SELECT COUNT(DISTINCT lr.employee_id) as active_count
             FROM leave_requests lr
             JOIN employees e ON lr.employee_id = e.id
             WHERE UPPER(e.department) = UPPER($1)
               AND UPPER(COALESCE(e.shift, 'A')) = UPPER($2)
               AND lr.status IN ('APPROVED', 'PENDING')
               AND lr.leave_type != 'Sick'
               AND $3 BETWEEN lr.start_date AND lr.end_date
               AND UPPER(lr.employee_id) != $4`,
            [department, employeeShift, date, cleanEmpId]
          );

          const currentOnLeave = parseInt(countRes.rows[0].active_count, 10);

          if (currentOnLeave >= maxDailyLeaves) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: `⚠️ โควตาลางานของแผนก ${department} (กะ ${employeeShift}) เต็มแล้วในวันที่ ${date} (จำกัดไม่เกิน ${maxDailyLeaves} คน/กะ/วัน) ยกเว้นกรณีลาป่วยเท่านั้น`,
              blockedDate: date,
              department,
              shift: employeeShift,
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
           duration_type, start_time, end_time, hours_count, reason, status, attachment_url
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', $11)
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
          reason || '',
          cleanAttachmentUrl
        ]
      );

      // Commit the transaction atomically
      await client.query('COMMIT');

      // Auto-sync leave request to Google Sheets in background
      googleSheetsService.syncLeaveRequestAsync({
        ...insertRes.rows[0],
        employee_name: empRecord ? empRecord.name : cleanEmpId,
        department,
        shift: employeeShift
      }, 'CREATE_LEAVE');

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
      googleSheetsService.syncLeaveRequestAsync({ id: requestId, status: 'CANCELLED' }, 'UPDATE_LEAVE_STATUS');
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

      // Sync cancellation to Google Sheets
      googleSheetsService.syncLeaveRequestAsync(updateRes.rows[0], 'UPDATE_LEAVE_STATUS');

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
    const { status, employee_id, department, supervisor_id, shift } = req.query;

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
          shift: 'A',
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
      if (shift) {
        demoList = demoList.filter(r => r.shift && r.shift.toLowerCase() === shift.toLowerCase());
      }
      return res.json({ success: true, requests: demoList });
    }

    let sql = `
      SELECT 
        lr.id,
        lr.employee_id,
        COALESCE(e.name, lr.employee_id) AS employee_name,
        COALESCE(e.department, 'Assembly') AS department,
        COALESCE(e.shift, 'A') AS shift,
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
        lr.attachment_url,
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

    if (shift) {
      params.push(shift.trim().toUpperCase());
      sql += ` AND UPPER(COALESCE(e.shift, 'A')) = $${params.length}`;
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
    const supervisorId = (reviewedBy || req.body.supervisorId || req.body.supervisor_id || '').trim().toUpperCase();

    if (!supervisorId) {
      return res.status(401).json({ error: 'ต้องระบุรหัสหัวหน้างาน (Supervisor ID) เพื่อดำเนินการ' });
    }

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
      googleSheetsService.syncLeaveRequestAsync({
        id: requestId,
        status: cleanStatus,
        reviewed_by: supervisorId,
        rejection_reason: rejectionReason || null
      }, 'UPDATE_LEAVE_STATUS');
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

      // Fetch reviewer name for clean Google Sheets display
      const supNameRes = await query('SELECT name FROM employees WHERE UPPER(id) = $1', [supervisorId]).catch(() => ({ rows: [] }));
      const reviewerName = (supNameRes.rows && supNameRes.rows.length > 0) ? supNameRes.rows[0].name : supervisorId;

      googleSheetsService.syncLeaveRequestAsync({
        ...updateRes.rows[0],
        reviewer_name: reviewerName
      }, 'UPDATE_LEAVE_STATUS');

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
      shift,
      role = 'EMPLOYEE', 
      pin, 
      vacation_quota, 
      personal_quota, 
      sick_quota,
      unpaid_quota 
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
    const cleanShift = normalizeShift(shift);
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
    const unpQuota = Number.isInteger(Number(unpaid_quota)) && Number(unpaid_quota) >= 0 
      ? Number(unpaid_quota) 
      : 30;

    if (!pool) {
      const demoEmp = {
        id: cleanEmpId,
        name: cleanName,
        department: cleanDept,
        shift: cleanShift,
        role: cleanRole,
        pin: cleanPin,
        vacation_quota: vacQuota,
        personal_quota: perQuota,
        sick_quota: sicQuota,
        unpaid_quota: unpQuota
      };
      googleSheetsService.syncEmployeeAsync(demoEmp);
      return res.status(201).json({
        success: true,
        message: `เพิ่มข้อมูลพนักงาน [${cleanEmpId}] ${cleanName} เรียบร้อยแล้ว (Demo mode)`,
        employee: demoEmp
      });
    }

    // Check duplicate ID
    const dupCheck = await query('SELECT id FROM employees WHERE UPPER(id) = $1', [cleanEmpId]);
    if (dupCheck.rows.length > 0) {
      return res.status(409).json({ error: `รหัสพนักงาน ${cleanEmpId} มีอยู่ในระบบแล้ว` });
    }

    // Insert employee
    const insertRes = await query(`
      INSERT INTO employees (id, name, department, shift, pin, role, vacation_quota, personal_quota, sick_quota, unpaid_quota)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, name, department, shift, role, vacation_quota, personal_quota, sick_quota, unpaid_quota, created_at
    `, [cleanEmpId, cleanName, cleanDept, cleanShift, cleanPin, cleanRole, vacQuota, perQuota, sicQuota, unpQuota]);

    // Ensure department and shift exists in quota_settings
    await query(`
      INSERT INTO quota_settings (department, shift, max_daily_leaves)
      VALUES ($1, $2, 2)
      ON CONFLICT (department, shift) DO NOTHING
    `, [cleanDept, cleanShift]);

    // Sync newly created employee to Google Sheets
    googleSheetsService.syncEmployeeAsync(insertRes.rows[0]);

    res.status(201).json({
      success: true,
      message: `เพิ่มพนักงาน [${cleanEmpId}] ${cleanName} (กะ ${cleanShift}) สำเร็จแล้ว`,
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
    const { department, role, shift, search } = req.query;
    if (pool) {
      let sql = 'SELECT id, name, department, COALESCE(shift, \'A\') AS shift, role, vacation_quota, personal_quota, sick_quota, COALESCE(unpaid_quota, 30) AS unpaid_quota, created_at FROM employees WHERE 1=1';
      const params = [];
      if (department && department !== 'ALL') {
        params.push(department.trim());
        sql += ` AND UPPER(department) = UPPER($${params.length})`;
      }
      if (role && role !== 'ALL') {
        params.push(role.trim().toUpperCase());
        sql += ` AND UPPER(role) = UPPER($${params.length})`;
      }
      if (shift && shift !== 'ALL') {
        params.push(shift.trim().toUpperCase());
        sql += ` AND UPPER(COALESCE(shift, 'A')) = UPPER($${params.length})`;
      }
      if (search) {
        params.push(`%${search.trim().toLowerCase()}%`);
        sql += ` AND (LOWER(id) LIKE $${params.length} OR LOWER(name) LIKE $${params.length})`;
      }
      sql += ' ORDER BY department ASC, shift ASC, role DESC, id ASC';
      const result = await query(sql, params);
      return res.json({ success: true, count: result.rows.length, employees: result.rows });
    }

    // Demo fallback
    res.json({
      success: true,
      count: 4,
      employees: [
        { id: 'ADMIN-001', name: 'ผู้ดูแลระบบ (Admin)', department: 'Management', shift: 'A', role: 'ADMIN', vacation_quota: 10, personal_quota: 6, sick_quota: 30, unpaid_quota: 30 },
        { id: 'SUP-001', name: 'สมศักดิ์ คุมงาน (หัวหน้า)', department: 'Assembly', shift: 'A', role: 'SUPERVISOR', vacation_quota: 10, personal_quota: 6, sick_quota: 30, unpaid_quota: 30 },
        { id: 'EMP-001', name: 'สมชาย สายลุย', department: 'Crimping 1', shift: 'A', role: 'EMPLOYEE', vacation_quota: 6, personal_quota: 6, sick_quota: 30, unpaid_quota: 30 },
        { id: 'EMP-002', name: 'สมหญิง จริงใจ', department: 'Crimping 1', shift: 'B', role: 'EMPLOYEE', vacation_quota: 6, personal_quota: 6, sick_quota: 30, unpaid_quota: 30 }
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
      shift,
      role, 
      pin, 
      vacation_quota, 
      personal_quota, 
      sick_quota,
      unpaid_quota 
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
    const newShift = shift !== undefined ? normalizeShift(shift) : (currentEmp.shift || 'A');
    const newRole = role !== undefined ? role.trim().toUpperCase() : currentEmp.role;
    const newPin = (pin !== undefined && pin.toString().trim() !== '') ? pin.toString().trim() : currentEmp.pin;
    const newVac = Number.isInteger(Number(vacation_quota)) ? Number(vacation_quota) : currentEmp.vacation_quota;
    const newPer = Number.isInteger(Number(personal_quota)) ? Number(personal_quota) : currentEmp.personal_quota;
    const newSic = Number.isInteger(Number(sick_quota)) ? Number(sick_quota) : currentEmp.sick_quota;
    const newUnp = Number.isInteger(Number(unpaid_quota)) ? Number(unpaid_quota) : (currentEmp.unpaid_quota !== undefined ? currentEmp.unpaid_quota : 30);

    const updateRes = await query(`
      UPDATE employees
      SET name = $1,
          department = $2,
          role = $3,
          pin = $4,
          vacation_quota = $5,
          personal_quota = $6,
          sick_quota = $7,
          shift = $8,
          unpaid_quota = $9
      WHERE UPPER(id) = $10
      RETURNING id, name, department, shift, role, vacation_quota, personal_quota, sick_quota, unpaid_quota
    `, [newName, newDept, newRole, newPin, newVac, newPer, newSic, newShift, newUnp, targetId]);

    // Ensure department and shift exists in quota_settings
    if (newDept) {
      await query(`
        INSERT INTO quota_settings (department, shift, max_daily_leaves)
        VALUES ($1, $2, 2)
        ON CONFLICT (department, shift) DO NOTHING
      `, [newDept, newShift]);
    }

    // Sync updated employee to Google Sheets
    googleSheetsService.syncEmployeeAsync(updateRes.rows[0]);

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

// ==========================================
// 12. Google Sheets Integration APIs
// ==========================================

// 12.1 Get Google Sheets Config
app.get('/api/google-sheets/config', async (req, res) => {
  try {
    await ensureDatabaseSchema();
    const config = googleSheetsService.getConfig();
    res.json({
      success: true,
      config
    });
  } catch (err) {
    res.status(500).json({ error: 'ไม่สามารถดึงการตั้งค่า Google Sheets ได้: ' + err.message });
  }
});

// 12.2 Save Google Sheets Config (ADMIN only)
app.post('/api/google-sheets/config', async (req, res) => {
  try {
    await ensureDatabaseSchema();
    const { adminId, webhookUrl, autoSync } = req.body;
    const cleanAdminId = (adminId || '').trim().toUpperCase();

    let isAuthorizedAdmin = cleanAdminId.startsWith('ADMIN');
    if (!isAuthorizedAdmin && pool) {
      const adminCheck = await query('SELECT role FROM employees WHERE UPPER(id) = $1', [cleanAdminId]);
      if (adminCheck.rows.length > 0 && adminCheck.rows[0].role === 'ADMIN') {
        isAuthorizedAdmin = true;
      }
    }

    if (!isAuthorizedAdmin) {
      return res.status(403).json({ error: 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่สามารถเปลี่ยนการตั้งค่า Google Sheets ได้' });
    }

    if (webhookUrl && !webhookUrl.startsWith('https://script.google.com/')) {
      return res.status(400).json({ error: 'URL ไม่ถูกต้อง ต้องเป็น Webhook URL ที่ขึ้นต้นด้วย https://script.google.com/' });
    }

    const updatedConfig = await googleSheetsService.saveConfig({
      webhookUrl: webhookUrl !== undefined ? webhookUrl.trim() : undefined,
      autoSync: autoSync !== undefined ? Boolean(autoSync) : undefined
    });

    res.json({
      success: true,
      message: 'บันทึกการตั้งค่า Google Sheets เรียบร้อยแล้ว',
      config: updatedConfig
    });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกการตั้งค่า: ' + err.message });
  }
});

// 12.3 Test Google Sheets Webhook Connection
app.post('/api/google-sheets/test', async (req, res) => {
  try {
    const { webhookUrl } = req.body;
    const result = await googleSheetsService.testConnection(webhookUrl ? webhookUrl.trim() : null);
    res.json({
      success: true,
      message: result.message || 'เชื่อมต่อ Google Sheets สำเร็จเรียบร้อย!',
      details: result
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: 'การเชื่อมต่อล้มเหลว: ' + err.message
    });
  }
});

// 12.4 Manual Bulk Sync to Google Sheets
app.post('/api/google-sheets/sync', async (req, res) => {
  try {
    const { syncType = 'ALL', requesterId } = req.body;
    const cleanReqId = (requesterId || '').trim().toUpperCase();

    // Verify authorized user (Supervisor or Admin)
    let isAuthorized = cleanReqId.startsWith('ADMIN') || cleanReqId.startsWith('SUP');
    if (!isAuthorized && pool && cleanReqId) {
      const uCheck = await query('SELECT role FROM employees WHERE UPPER(id) = $1', [cleanReqId]);
      if (uCheck.rows.length > 0 && (uCheck.rows[0].role === 'ADMIN' || uCheck.rows[0].role === 'SUPERVISOR')) {
        isAuthorized = true;
      }
    }
    if (cleanReqId && !isAuthorized) {
      return res.status(403).json({ error: 'เฉพาะหัวหน้างาน (Supervisor) หรือผู้ดูแลระบบเท่านั้นที่สามารถกดซิงค์ข้อมูลได้' });
    }

    const cfg = googleSheetsService.getConfig();
    if (!cfg.configured) {
      return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า Google Sheets Webhook URL กรุณาตั้งค่าก่อนซิงค์' });
    }

    let leavesList = [];
    let employeesList = [];

    if (pool) {
      if (syncType === 'ALL' || syncType === 'LEAVES') {
        const lRes = await query(`
          SELECT 
            lr.id,
            lr.employee_id,
            COALESCE(e.name, lr.employee_id) AS employee_name,
            COALESCE(e.department, 'Assembly') AS department,
            COALESCE(e.shift, 'A') AS shift,
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
            lr.attachment_url,
            lr.created_at
          FROM leave_requests lr
          LEFT JOIN employees e ON UPPER(lr.employee_id) = UPPER(e.id)
          LEFT JOIN employees rev ON UPPER(lr.reviewed_by) = UPPER(rev.id)
          ORDER BY lr.id ASC
        `);
        leavesList = lRes.rows;
      }

      if (syncType === 'ALL' || syncType === 'EMPLOYEES') {
        const eRes = await query(`
          SELECT id, name, department, COALESCE(shift, 'A') as shift, role, pin,
                 vacation_quota, personal_quota, sick_quota, COALESCE(unpaid_quota, 30) as unpaid_quota, created_at
          FROM employees
          ORDER BY department ASC, id ASC
        `);
        employeesList = eRes.rows;
      }
    } else {
      // Demo mock lists
      leavesList = [
        {
          id: 101,
          employee_id: 'EMP-001',
          employee_name: 'สมชาย ใจดี',
          department: 'Assembly',
          shift: 'A',
          leave_type: 'Vacation',
          duration_type: 'FULL_DAY',
          start_date: '2026-09-15',
          end_date: '2026-09-15',
          days_count: 1,
          reason: 'พาครอบครัวไปทำธุระ',
          status: 'PENDING',
          created_at: new Date().toISOString()
        }
      ];
      employeesList = [
        { id: 'ADMIN-001', name: 'ผู้ดูแลระบบ (Admin)', department: 'Management', shift: 'Morning', role: 'ADMIN', vacation_quota: 10, personal_quota: 6, sick_quota: 30, unpaid_quota: 30 },
        { id: 'SUP-001', name: 'สมศักดิ์ คุมงาน (หัวหน้า)', department: 'Assembly', shift: 'Morning', role: 'SUPERVISOR', vacation_quota: 10, personal_quota: 6, sick_quota: 30, unpaid_quota: 30 },
        { id: 'EMP-001', name: 'สมชาย ใจดี', department: 'Assembly', shift: 'A', role: 'EMPLOYEE', vacation_quota: 6, personal_quota: 6, sick_quota: 30, unpaid_quota: 30 },
        { id: 'EMP-002', name: 'สมหญิง รักงาน', department: 'Assembly', shift: 'B', role: 'EMPLOYEE', vacation_quota: 6, personal_quota: 6, sick_quota: 30, unpaid_quota: 30 }
      ];
    }

    let syncResult;
    if (syncType === 'LEAVES') {
      syncResult = await googleSheetsService.syncAllLeaves(leavesList);
    } else if (syncType === 'EMPLOYEES') {
      syncResult = await googleSheetsService.syncAllEmployees(employeesList);
    } else {
      syncResult = await googleSheetsService.syncAllData(leavesList, employeesList);
    }

    res.json({
      success: true,
      message: syncResult.message || 'ซิงค์ข้อมูลไปยัง Google Sheets สำเร็จเรียบร้อย',
      syncType,
      leavesCount: leavesList.length,
      employeesCount: employeesList.length,
      details: syncResult
    });
  } catch (err) {
    console.error('Manual sync to Google Sheets error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการซิงค์ข้อมูล: ' + err.message });
  }
});

// ==========================================
// 14. Leave Reports & Export API (Excel / CSV / JSON)
// Designed for HR, Payroll, and Supervisor Auditing
// ==========================================
app.get('/api/reports/leave-export', async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      department,
      shift,
      leaveType,
      status,
      search,
      format = 'json'
    } = req.query;

    let rows = [];

    if (!pool) {
      // Demo mock data for offline / demo mode
      rows = [
        {
          id: 101,
          employee_id: '051057',
          employee_name: 'พรทิพย์ ดวงมณี',
          department: 'Crimping 1',
          shift: 'A',
          leave_type: 'Vacation',
          duration_type: 'FULL_DAY',
          start_date: '2026-09-15',
          end_date: '2026-09-16',
          days_count: 2,
          start_time: null,
          end_time: null,
          hours_count: null,
          reason: 'พักผ่อนประจำปี',
          status: 'APPROVED',
          attachment_url: null,
          reviewed_by: 'SUP-001',
          reviewer_name: 'สมศักดิ์ คุมงาน (หัวหน้า)',
          reviewed_at: '2026-09-14 09:30:00',
          rejection_reason: null,
          created_at: '2026-09-13 14:00:00'
        },
        {
          id: 102,
          employee_id: '031838',
          employee_name: 'วีระพล สว่างจิต',
          department: 'Crimping 1',
          shift: 'A',
          leave_type: 'Sick',
          duration_type: 'HOURLY',
          start_date: '2026-09-18',
          end_date: '2026-09-18',
          days_count: 0.25,
          start_time: '13:00',
          end_time: '15:00',
          hours_count: 2.0,
          reason: 'ไปพบแพทย์ตามนัด',
          status: 'APPROVED',
          attachment_url: '/uploads/cert-sample.jpg',
          reviewed_by: 'SUP-001',
          reviewer_name: 'สมศักดิ์ คุมงาน (หัวหน้า)',
          reviewed_at: '2026-09-17 11:00:00',
          rejection_reason: null,
          created_at: '2026-09-17 08:30:00'
        },
        {
          id: 103,
          employee_id: 'EMP-001',
          employee_name: 'สมชาย ใจดี',
          department: 'Assembly',
          shift: 'A',
          leave_type: 'Personal',
          duration_type: 'FULL_DAY',
          start_date: '2026-09-20',
          end_date: '2026-09-20',
          days_count: 1,
          start_time: null,
          end_time: null,
          hours_count: null,
          reason: 'ทำธุระต่อใบขับขี่',
          status: 'PENDING',
          attachment_url: null,
          reviewed_by: null,
          reviewer_name: null,
          reviewed_at: null,
          rejection_reason: null,
          created_at: '2026-09-19 10:15:00'
        }
      ];

      // Filter demo data in memory
      if (startDate) rows = rows.filter(r => r.end_date >= startDate);
      if (endDate) rows = rows.filter(r => r.start_date <= endDate);
      if (department && department.toUpperCase() !== 'ALL') {
        rows = rows.filter(r => (r.department || '').toUpperCase() === department.toUpperCase());
      }
      if (shift && shift.toUpperCase() !== 'ALL') {
        rows = rows.filter(r => (r.shift || '').toUpperCase() === shift.toUpperCase());
      }
      if (leaveType && leaveType.toUpperCase() !== 'ALL') {
        const norm = normalizeLeaveType(leaveType);
        rows = rows.filter(r => normalizeLeaveType(r.leave_type) === norm);
      }
      if (status && status.toUpperCase() !== 'ALL') {
        rows = rows.filter(r => (r.status || '').toUpperCase() === status.toUpperCase());
      }
      if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        rows = rows.filter(r => 
          (r.employee_id || '').toLowerCase().includes(q) ||
          (r.employee_name || '').toLowerCase().includes(q) ||
          (r.reason || '').toLowerCase().includes(q)
        );
      }
    } else {
      let sql = `
        SELECT 
          lr.id,
          lr.employee_id,
          COALESCE(e.name, lr.employee_id) AS employee_name,
          COALESCE(e.department, 'Assembly') AS department,
          COALESCE(e.shift, 'A') AS shift,
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
          lr.attachment_url,
          lr.reviewed_by,
          COALESCE(rev.name, lr.reviewed_by) AS reviewer_name,
          TO_CHAR(lr.reviewed_at, 'YYYY-MM-DD HH24:MI:SS') AS reviewed_at,
          lr.rejection_reason,
          TO_CHAR(lr.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
        FROM leave_requests lr
        LEFT JOIN employees e ON UPPER(lr.employee_id) = UPPER(e.id)
        LEFT JOIN employees rev ON UPPER(lr.reviewed_by) = UPPER(rev.id)
        WHERE 1=1
      `;
      const params = [];

      if (startDate && startDate.trim()) {
        params.push(startDate.trim());
        sql += ` AND lr.end_date >= $${params.length}::date`;
      }

      if (endDate && endDate.trim()) {
        params.push(endDate.trim());
        sql += ` AND lr.start_date <= $${params.length}::date`;
      }

      if (department && department.trim() && department.toUpperCase() !== 'ALL') {
        params.push(department.trim().toUpperCase());
        sql += ` AND UPPER(COALESCE(e.department, '')) = $${params.length}`;
      }

      if (shift && shift.trim() && shift.toUpperCase() !== 'ALL') {
        params.push(shift.trim().toUpperCase());
        sql += ` AND UPPER(COALESCE(e.shift, 'A')) = $${params.length}`;
      }

      if (leaveType && leaveType.trim() && leaveType.toUpperCase() !== 'ALL') {
        const normType = normalizeLeaveType(leaveType);
        params.push(normType.toUpperCase());
        sql += ` AND UPPER(lr.leave_type) = $${params.length}`;
      }

      if (status && status.trim() && status.toUpperCase() !== 'ALL') {
        params.push(status.trim().toUpperCase());
        sql += ` AND UPPER(lr.status) = $${params.length}`;
      }

      if (search && search.trim()) {
        params.push(`%${search.trim().toUpperCase()}%`);
        const pIndex = params.length;
        sql += ` AND (
          UPPER(lr.employee_id) LIKE $${pIndex}
          OR UPPER(COALESCE(e.name, '')) LIKE $${pIndex}
          OR UPPER(COALESCE(lr.reason, '')) LIKE $${pIndex}
        )`;
      }

      sql += ' ORDER BY lr.start_date DESC, lr.id DESC';

      const result = await query(sql, params);
      rows = result.rows;
    }

    // Calculate Summary Statistics
    let totalRecords = rows.length;
    let totalDays = 0;
    let totalHours = 0;
    let approvedRecords = 0;
    let approvedDays = 0;

    const byType = {
      Vacation: { count: 0, days: 0 },
      Personal: { count: 0, days: 0 },
      Sick: { count: 0, days: 0 },
      Unpaid: { count: 0, days: 0 },
      Other: { count: 0, days: 0 }
    };

    const byStatus = {
      APPROVED: 0,
      PENDING: 0,
      REJECTED: 0,
      CANCELLED: 0
    };

    rows.forEach(r => {
      const dCount = parseFloat(r.days_count) || 0;
      const hCount = parseFloat(r.hours_count) || 0;
      totalDays += dCount;
      totalHours += hCount;

      const st = (r.status || '').toUpperCase();
      if (byStatus[st] !== undefined) {
        byStatus[st]++;
      } else {
        byStatus[st] = 1;
      }

      if (st === 'APPROVED') {
        approvedRecords++;
        approvedDays += dCount;
      }

      const lt = normalizeLeaveType(r.leave_type);
      if (byType[lt]) {
        byType[lt].count++;
        byType[lt].days += dCount;
      } else {
        byType.Other.count++;
        byType.Other.days += dCount;
      }
    });

    const summary = {
      totalRecords,
      totalDays: Number(totalDays.toFixed(2)),
      totalHours: Number(totalHours.toFixed(2)),
      approvedRecords,
      approvedDays: Number(approvedDays.toFixed(2)),
      byType,
      byStatus
    };

    // If CSV export format requested
    if (format.toLowerCase() === 'csv') {
      const csvHeaders = [
        'ลำดับ',
        'เลขที่คำขอ',
        'วันที่ยื่นคำขอ',
        'รหัสพนักงาน',
        'ชื่อ-นามสกุล',
        'แผนก',
        'กะการทำงาน',
        'ประเภทการลา',
        'รูปแบบการลา',
        'วันที่เริ่มลา',
        'วันที่สิ้นสุด',
        'ช่วงเวลา',
        'จำนวนวันลา (วัน)',
        'จำนวนชั่วโมง (ชม.)',
        'เหตุผลการลา',
        'มีเอกสารแนบ',
        'สถานะคำขอ',
        'ผู้อนุมัติ/ตรวจสอบ',
        'วันที่อนุมัติ/พิจารณา',
        'หมายเหตุ/เหตุผลที่ปฏิเสธ'
      ];

      const csvEscape = (val, isEmpId = false) => {
        if (val === null || val === undefined) return '""';
        let str = String(val).trim();
        // If employee ID and consists of digits, format as ="051057" to preserve leading zeros in Excel
        if (isEmpId && /^\d+$/.test(str)) {
          return `="${str}"`;
        }
        return `"${str.replace(/"/g, '""')}"`;
      };

      const formatLeaveTypeThai = (type) => {
        const norm = normalizeLeaveType(type);
        switch (norm) {
          case 'Vacation': return 'ลาพักร้อน (Vacation)';
          case 'Personal': return 'ลากิจ (Personal)';
          case 'Sick': return 'ลาป่วย (Sick)';
          case 'Unpaid': return 'ลาไม่รับค่าจ้าง (Unpaid)';
          default: return type || 'อื่นๆ';
        }
      };

      const formatStatusThai = (status) => {
        const s = (status || '').toUpperCase();
        switch (s) {
          case 'APPROVED': return 'อนุมัติแล้ว (Approved)';
          case 'PENDING': return 'รออนุมัติ (Pending)';
          case 'REJECTED': return 'ปฏิเสธ (Rejected)';
          case 'CANCELLED': return 'ยกเลิก (Cancelled)';
          default: return status || '-';
        }
      };

      const csvLines = [
        csvHeaders.map(h => csvEscape(h)).join(',')
      ];

      rows.forEach((r, idx) => {
        const rowData = [
          idx + 1,
          `REQ-${r.id}`,
          r.created_at || '',
          csvEscape(r.employee_id, true),
          csvEscape(r.employee_name),
          csvEscape(r.department),
          csvEscape(r.shift),
          csvEscape(formatLeaveTypeThai(r.leave_type)),
          csvEscape(r.duration_type === 'HOURLY' ? 'รายชั่วโมง (Hourly)' : 'เต็มวัน (Full Day)'),
          csvEscape(r.start_date),
          csvEscape(r.end_date),
          csvEscape(r.duration_type === 'HOURLY' && r.start_time ? `${r.start_time} - ${r.end_time}` : '-'),
          r.days_count,
          r.hours_count || 0,
          csvEscape(r.reason),
          csvEscape(r.attachment_url ? 'มี' : 'ไม่มี'),
          csvEscape(formatStatusThai(r.status)),
          csvEscape(r.reviewer_name || r.reviewed_by || '-'),
          csvEscape(r.reviewed_at || '-'),
          csvEscape(r.rejection_reason || '-')
        ];

        const line = rowData.map((val, colIdx) => {
          if (colIdx === 3) return val; // already handled with ="..."
          if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) return val;
          return csvEscape(val);
        }).join(',');

        csvLines.push(line);
      });

      const todayStr = new Date().toISOString().split('T')[0];
      const filename = `leave_report_${startDate || 'all'}_to_${endDate || todayStr}.csv`;

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // Prepend UTF-8 BOM (\uFEFF) so Excel on Windows & Mac renders Thai characters properly
      return res.status(200).send('\uFEFF' + csvLines.join('\r\n'));
    }

    // Default JSON response
    res.json({
      success: true,
      summary,
      rows
    });
  } catch (err) {
    console.error('Leave export report error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงรายงาน: ' + err.message });
  }
});



// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Leave Management Server is running on http://localhost:${PORT}`);
});

module.exports = app;
