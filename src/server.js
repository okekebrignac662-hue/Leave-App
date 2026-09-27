// Enforce Asia/Bangkok (UTC+7) across entire Node.js runtime
process.env.TZ = 'Asia/Bangkok';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { pool, query, getClient } = require('./db');
const googleSheetsService = require('./googleSheetsService');
const webpush = require('web-push');
require('dotenv').config();

// Web Push VAPID Configuration
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BDcdkNHQweCBzSLmakxYhZrBdIaOeIXBC9KJHWPcajJkAwz76-l7zP4fSF9GylNrgn0MsyAA8m7FgjDvh1mPUME';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '995tWV0BYjiyOKbF-sPZDyDk3D04ZaGhvQevU2fz_qM';
const VAPID_MAILTO = process.env.VAPID_MAILTO || 'mailto:admin@leaveapp.internal';

try {
  webpush.setVapidDetails(VAPID_MAILTO, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} catch (err) {
  console.warn('VAPID setup notice:', err.message);
}

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

  // For platforms with ephemeral filesystems (like Render), 
  // it's better to store the base64 string directly in the database (since the column is TEXT)
  // rather than saving to the local disk which will be wiped on restart/scaling.
  return trimmed;
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
        CREATE TABLE IF NOT EXISTS notifications (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(50) NOT NULL,
          title VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          type VARCHAR(50) NOT NULL DEFAULT 'SYSTEM',
          reference_id INT,
          is_read BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id, is_read, created_at DESC);
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(50) NOT NULL,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          user_agent TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_push_sub_user_id ON push_subscriptions (user_id);
        CREATE TABLE IF NOT EXISTS shift_swap_requests (
          id SERIAL PRIMARY KEY,
          requester_id VARCHAR(20) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          target_employee_id VARCHAR(20) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          department VARCHAR(50) NOT NULL,
          requester_date DATE NOT NULL,
          requester_shift VARCHAR(20) NOT NULL,
          target_date DATE NOT NULL,
          target_shift VARCHAR(20) NOT NULL,
          reason TEXT,
          status VARCHAR(30) NOT NULL DEFAULT 'PENDING_PEER',
          peer_responded_at TIMESTAMP WITH TIME ZONE,
          peer_rejection_reason TEXT,
          reviewed_by VARCHAR(20) REFERENCES employees(id) ON DELETE SET NULL,
          reviewed_at TIMESTAMP WITH TIME ZONE,
          supervisor_rejection_reason TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_shift_swap_requester ON shift_swap_requests (requester_id);
        CREATE INDEX IF NOT EXISTS idx_shift_swap_target ON shift_swap_requests (target_employee_id);
        CREATE INDEX IF NOT EXISTS idx_shift_swap_dept_status ON shift_swap_requests (department, status);
        INSERT INTO quota_settings (department, shift, max_daily_leaves)
        VALUES ('HR', 'Morning', 2)
        ON CONFLICT (department, shift) DO NOTHING;
        INSERT INTO employees (id, name, department, shift, pin, role, vacation_quota, personal_quota, sick_quota, unpaid_quota)
        VALUES ('HR-001', 'เจ้าหน้าที่ฝ่ายบุคคล (HR)', 'HR', 'Morning', '1234', 'HR', 10, 6, 30, 30)
        ON CONFLICT (id) DO NOTHING;
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

// In-Memory Notifications store for fallback / testing without database connection
let demoNotifications = [];
let nextDemoNotifId = 1;
let demoPushSubscriptions = [];
let nextDemoPushSubId = 1;
let demoShiftSwaps = [];
let nextDemoShiftSwapId = 1;

/**
 * Send Web Push Notification to user's registered devices
 */
async function sendWebPushNotification(userId, payload = {}) {
  if (!userId) return;
  const cleanUserId = userId.toString().trim().toUpperCase();
  const pushPayload = JSON.stringify({
    title: payload.title || 'ระบบแจ้งเตือนการลางาน',
    body: payload.body || payload.message || '',
    icon: payload.icon || '/icons/icon-192.png',
    badge: payload.badge || '/icons/icon.svg',
    url: payload.url || '/',
    data: {
      url: payload.url || '/',
      referenceId: payload.referenceId || null,
      type: payload.type || 'SYSTEM'
    }
  });

  let subs = [];
  if (!pool) {
    subs = demoPushSubscriptions.filter(s => s.user_id === cleanUserId);
  } else {
    try {
      const res = await query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [cleanUserId]);
      subs = res.rows;
    } catch (e) {
      console.warn('Fetch push subscriptions error:', e.message);
    }
  }

  for (const sub of subs) {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth
      }
    };
    try {
      await webpush.sendNotification(pushSubscription, pushPayload);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        if (!pool) {
          demoPushSubscriptions = demoPushSubscriptions.filter(s => s.endpoint !== sub.endpoint);
        } else {
          query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]).catch(() => {});
        }
      } else {
        console.warn('Push delivery notice:', err.message);
      }
    }
  }
}

/**
 * Create In-App Notification (Database or In-Memory fallback)
 * Automatically triggers Web Push to the user
 */
async function createNotification(userId, title, message, type = 'SYSTEM', referenceId = null) {
  if (!userId) return null;
  const cleanUserId = userId.toString().trim().toUpperCase();
  let createdRecord = null;
  try {
    if (!pool) {
      const notif = {
        id: nextDemoNotifId++,
        user_id: cleanUserId,
        title,
        message,
        type,
        reference_id: referenceId,
        is_read: false,
        created_at: new Date().toISOString()
      };
      demoNotifications.unshift(notif);
      createdRecord = notif;
    } else {
      const res = await query(
        `INSERT INTO notifications (user_id, title, message, type, reference_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [cleanUserId, title, message, type, referenceId]
      );
      createdRecord = res.rows[0];
    }

    // Automatically trigger Web Push to user's devices
    sendWebPushNotification(cleanUserId, {
      title,
      body: message,
      referenceId,
      type
    }).catch(e => {
      console.warn('Push dispatch error:', e.message);
    });

    return createdRecord;
  } catch (err) {
    console.error('Failed to create in-app notification:', err.message);
    return null;
  }
}

// Helper: Normalize Leave Type to standard key
function normalizeLeaveType(type) {
  if (!type) return 'Vacation';
  const lower = type.toLowerCase();
  if (lower.includes('unpaid') || lower.includes('ไม่รับค่าจ้าง')) return 'Unpaid';
  if (lower.includes('sick') || lower.includes('ป่วย')) return 'Sick';
  if (lower.includes('personal') || lower.includes('กิจ')) return 'Personal';
  return 'Vacation';
}

function formatLeaveTypeThai(type) {
  const norm = normalizeLeaveType(type);
  switch (norm) {
    case 'Vacation': return 'ลาพักร้อน';
    case 'Personal': return 'ลากิจ';
    case 'Sick': return 'ลาป่วย';
    case 'Unpaid': return 'ลาไม่รับค่าจ้าง';
    default: return type || 'อื่นๆ';
  }
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
    const isHRPrefix = cleanEmpId.startsWith('HR');

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
      const isHR = isHRPrefix || emp.role === 'HR';
      const isSupervisor = isSupPrefix || emp.role === 'SUPERVISOR' || isAdmin || isHR;
      const userRole = isAdmin ? 'ADMIN' : (isHR ? 'HR' : (emp.role === 'SUPERVISOR' || isSupPrefix ? 'SUPERVISOR' : 'EMPLOYEE'));
      return res.json({
        success: true,
        user: {
          id: emp.id,
          name: emp.name,
          department: emp.department,
          shift: emp.shift || 'A',
          role: userRole,
          isSupervisor,
          isAdmin,
          isHR
        }
      });
    }

    // Strict Fallback if database is offline: only allow known demo IDs with PIN 1234
    const validDemoUsers = {
      'EMP-001': { name: 'สมชาย ใจดี', department: 'Assembly', shift: 'A', role: 'EMPLOYEE', pin: '1234' },
      'EMP-002': { name: 'สมหญิง รักงาน', department: 'Assembly', shift: 'B', role: 'EMPLOYEE', pin: '1234' },
      'SUP-001': { name: 'สมศักดิ์ คุมงาน (หัวหน้า)', department: 'Assembly', shift: 'Morning', role: 'SUPERVISOR', pin: '1234' },
      'ADMIN-001': { name: 'ผู้ดูแลระบบ (Admin)', department: 'Management', shift: 'Morning', role: 'ADMIN', pin: '1234' },
      'HR-001': { name: 'เจ้าหน้าที่ฝ่ายบุคคล (HR)', department: 'HR', shift: 'Morning', role: 'HR', pin: '1234' }
    };

    const demoUser = validDemoUsers[cleanEmpId];
    if (!demoUser) {
      return res.status(401).json({ error: 'ไม่พบรหัสพนักงานนี้ในระบบ (Employee ID not found)' });
    }
    if (demoUser.pin !== cleanPin) {
      return res.status(401).json({ error: 'รหัสผ่าน (PIN) ไม่ถูกต้อง (Incorrect PIN)' });
    }

    const isAdmin = isAdminPrefix || demoUser.role === 'ADMIN';
    const isHR = isHRPrefix || demoUser.role === 'HR';
    const isSupervisor = isSupPrefix || demoUser.role === 'SUPERVISOR' || isAdmin || isHR;
    const userRole = isAdmin ? 'ADMIN' : (isHR ? 'HR' : (demoUser.role === 'SUPERVISOR' || isSupPrefix ? 'SUPERVISOR' : 'EMPLOYEE'));
    return res.json({
      success: true,
      user: {
        id: cleanEmpId,
        name: demoUser.name,
        department: demoUser.department,
        shift: demoUser.shift || 'A',
        role: userRole,
        isSupervisor,
        isAdmin,
        isHR
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

      // Create In-App Notification for employee
      const thaiLeaveType = formatLeaveTypeThai(normalizedType);
      const leaveDurationStr = isHourly 
        ? `${startDate} (${cleanStartTime} - ${cleanEndTime} น.)` 
        : (startDate === actualEndDate ? startDate : `${startDate} ถึง ${actualEndDate}`);
      
      await createNotification(
        cleanEmpId,
        `ยื่นคำขอลางานสำเร็จ (${thaiLeaveType})`,
        `คำขอลา ${thaiLeaveType} วันที่ ${leaveDurationStr} จำนวน ${daysCount} วัน ถูกส่งไปยังหัวหน้างานเรียบร้อยแล้ว`,
        'LEAVE_SUBMITTED',
        insertRes.rows[0].id
      );

      // Create In-App Notification for department supervisors & HR & Admin
      try {
        const empName = empRecord ? empRecord.name : cleanEmpId;
        if (pool) {
          const supRes = await query(
            `SELECT id FROM employees 
             WHERE (UPPER(department) = UPPER($1) AND UPPER(role) = 'SUPERVISOR')
                OR UPPER(role) IN ('ADMIN', 'HR')`,
            [department]
          );
          for (const sup of supRes.rows) {
            if (sup.id.toUpperCase() !== cleanEmpId) {
              await createNotification(
                sup.id,
                `คำขอลางานใหม่: ${empName}`,
                `${empName} (${department} - กะ ${employeeShift}) ขอลา ${thaiLeaveType} (${leaveDurationStr})`,
                'LEAVE_SUBMITTED',
                insertRes.rows[0].id
              );
            }
          }
        } else {
          await createNotification(
            'SUP-001',
            `คำขอลางานใหม่: ${empName}`,
            `${empName} (${department}) ขอลา ${thaiLeaveType} (${leaveDurationStr})`,
            'LEAVE_SUBMITTED',
            insertRes.rows[0].id
          );
        }
      } catch (e) {
        console.warn('Supervisor notification failed:', e.message);
      }

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

      // Create In-App Notification for employee
      await createNotification(
        cleanEmpId,
        'ยกเลิกคำขอลางานเรียบร้อย',
        `คำขอลา ${formatLeaveTypeThai(leaveReq.leave_type)} วันที่ ${leaveReq.start_date} ถูกยกเลิกแล้ว โควตาถูกคืนเข้าระบบทันที`,
        'LEAVE_CANCELLED',
        requestId
      );

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
      const supDeptRes = await query('SELECT department, role FROM employees WHERE UPPER(id) = $1', [supervisor_id.trim().toUpperCase()]);
      if (supDeptRes.rows.length > 0) {
        const sup = supDeptRes.rows[0];
        const isHRUser = sup.role === 'HR' || supervisor_id.trim().toUpperCase().startsWith('HR');
        const isAdminUser = sup.role === 'ADMIN' || supervisor_id.trim().toUpperCase().startsWith('ADMIN');
        if (!isHRUser && !isAdminUser) {
          targetDept = sup.department;
        }
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
      if (targetDept && targetDept.toUpperCase() !== 'ALL') {
        demoList = demoList.filter(r => r.department && r.department.toLowerCase() === targetDept.toLowerCase());
      }
      if (shift && shift.toUpperCase() !== 'ALL') {
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

    if (targetDept && targetDept.toUpperCase() !== 'ALL') {
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

    // Verify supervisor/admin/HR authorization (starts with SUP/ADMIN/HR or role is SUPERVISOR/ADMIN/HR in DB)
    let isAuthorizedSupervisor = supervisorId.startsWith('SUP') || supervisorId.startsWith('ADMIN') || supervisorId.startsWith('HR');
    if (!isAuthorizedSupervisor && pool) {
      const supCheck = await query('SELECT role FROM employees WHERE UPPER(id) = $1', [supervisorId]);
      if (supCheck.rows.length > 0 && ['SUPERVISOR', 'ADMIN', 'HR'].includes(supCheck.rows[0].role)) {
        isAuthorizedSupervisor = true;
      }
    }
    if (!isAuthorizedSupervisor) {
      return res.status(403).json({ error: 'เฉพาะหัวหน้างาน (Supervisor), ฝ่ายบุคคล (HR) หรือผู้ดูแลระบบเท่านั้นที่สามารถอนุมัติหรือปฏิเสธคำขอได้' });
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

      // Create In-App Notification for employee
      const targetEmpId = updateRes.rows[0].employee_id;
      const targetLeaveType = formatLeaveTypeThai(updateRes.rows[0].leave_type);
      const targetStartDate = updateRes.rows[0].start_date;
      
      if (cleanStatus === 'APPROVED') {
        await createNotification(
          targetEmpId,
          `คำขอลางานได้รับอนุมัติแล้ว ✅`,
          `คำขอลา ${targetLeaveType} (วันที่ ${targetStartDate}) ได้รับการอนุมัติแล้วโดย ${reviewerName}`,
          'LEAVE_APPROVED',
          updateRes.rows[0].id
        );
      } else {
        await createNotification(
          targetEmpId,
          `คำขอลางานไม่ได้รับการอนุมัติ ❌`,
          `คำขอลา ${targetLeaveType} (วันที่ ${targetStartDate}) ไม่ได้รับการอนุมัติโดย ${reviewerName}${rejectionReason ? ' (เหตุผล: ' + rejectionReason + ')' : ''}`,
          'LEAVE_REJECTED',
          updateRes.rows[0].id
        );
      }

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
        { name: 'HR', maxDailyLeaves: 2 },
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
      empId,
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
    const cleanEmpId = (id || empId || '').trim().toUpperCase();
    const cleanName = (name || '').trim();
    const cleanDept = (department || '').trim();
    const cleanShift = normalizeShift(shift);
    const cleanRole = (role || 'EMPLOYEE').trim().toUpperCase();
    const cleanPin = (pin ? pin.toString().trim() : cleanEmpId); // Default PIN is employee ID

    if (!cleanEmpId || !cleanName || !cleanDept) {
      return res.status(400).json({ error: 'กรุณากรอกรหัสพนักงาน ชื่อ-นามสกุล และแผนกให้ครบถ้วน' });
    }

    if (!['EMPLOYEE', 'SUPERVISOR', 'ADMIN', 'HR'].includes(cleanRole)) {
      return res.status(400).json({ error: 'บทบาทต้องเป็น EMPLOYEE, SUPERVISOR, HR หรือ ADMIN' });
    }

    const vacQuota = Number.isInteger(Number(vacation_quota)) && Number(vacation_quota) >= 0 
      ? Number(vacation_quota) 
      : (cleanRole === 'SUPERVISOR' || cleanRole === 'ADMIN' || cleanRole === 'HR' ? 10 : 6);
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
          employee_id: '099998',
          employee_name: 'ตัวอย่าง พนักงานทดสอบ',
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
          employee_id: '099999',
          employee_name: 'ตัวอย่าง ระบบจำลอง',
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



// ==========================================
// In-App Notification Center APIs
// ==========================================

// GET /api/notifications - Fetch user notifications and unread count
app.get('/api/notifications', async (req, res) => {
  try {
    const userId = (req.query.userId || req.query.user_id || '').trim().toUpperCase();
    if (!userId) {
      return res.status(400).json({ error: 'กรุณาระบุรหัสผู้ใช้งาน (userId required)' });
    }

    if (!pool) {
      const userNotifs = demoNotifications.filter(n => n.user_id === userId);
      const unreadCount = userNotifs.filter(n => !n.is_read).length;
      return res.json({
        success: true,
        unreadCount,
        notifications: userNotifs.slice(0, 40)
      });
    }

    const notifRes = await query(
      `SELECT id, user_id, title, message, type, reference_id, is_read, 
              TO_CHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
       FROM notifications
       WHERE UPPER(user_id) = $1
       ORDER BY created_at DESC
       LIMIT 40`,
      [userId]
    );

    const countRes = await query(
      `SELECT COUNT(*)::int AS unread_count
       FROM notifications
       WHERE UPPER(user_id) = $1 AND is_read = FALSE`,
      [userId]
    );

    const unreadCount = countRes.rows[0] ? countRes.rows[0].unread_count : 0;

    res.json({
      success: true,
      unreadCount,
      notifications: notifRes.rows
    });
  } catch (error) {
    console.error('Fetch notifications error:', error);
    res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลการแจ้งเตือนได้: ' + error.message });
  }
});

// PATCH /api/notifications/:id/read - Mark single notification as read
app.patch('/api/notifications/:id/read', async (req, res) => {
  try {
    const notifId = req.params.id;
    const userId = (req.body.userId || req.body.user_id || req.query.userId || '').trim().toUpperCase();

    if (!pool) {
      const item = demoNotifications.find(n => n.id == notifId && (!userId || n.user_id === userId));
      if (item) item.is_read = true;
      return res.json({ success: true, message: 'ทำเครื่องหมายว่าอ่านแล้ว' });
    }

    if (userId) {
      await query(
        `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND UPPER(user_id) = $2`,
        [notifId, userId]
      );
    } else {
      await query(
        `UPDATE notifications SET is_read = TRUE WHERE id = $1`,
        [notifId]
      );
    }

    res.json({ success: true, message: 'ทำเครื่องหมายว่าอ่านแล้ว' });
  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({ error: 'ไม่สามารถอัปเดตสถานะการแจ้งเตือนได้: ' + error.message });
  }
});

// PATCH /api/notifications/read-all - Mark all user notifications as read
app.patch('/api/notifications/read-all', async (req, res) => {
  try {
    const userId = (req.body.userId || req.body.user_id || req.query.userId || '').trim().toUpperCase();
    if (!userId) {
      return res.status(400).json({ error: 'กรุณาระบุรหัสผู้ใช้งาน (userId required)' });
    }

    if (!pool) {
      demoNotifications.forEach(n => {
        if (n.user_id === userId) n.is_read = true;
      });
      return res.json({ success: true, message: 'ทำเครื่องหมายอ่านทั้งหมดเรียบร้อยแล้ว' });
    }

    await query(
      `UPDATE notifications SET is_read = TRUE WHERE UPPER(user_id) = $1 AND is_read = FALSE`,
      [userId]
    );

    res.json({ success: true, message: 'ทำเครื่องหมายอ่านทั้งหมดเรียบร้อยแล้ว' });
  } catch (error) {
    console.error('Mark all notifications read error:', error);
    res.status(500).json({ error: 'ไม่สามารถอัปเดตสถานะการแจ้งเตือนได้: ' + error.message });
  }
});

// DELETE /api/notifications/:id - Dismiss / Delete notification
app.delete('/api/notifications/:id', async (req, res) => {
  try {
    const notifId = req.params.id;
    const userId = (req.body?.userId || req.query.userId || '').trim().toUpperCase();

    if (!pool) {
      demoNotifications = demoNotifications.filter(n => !(n.id == notifId && (!userId || n.user_id === userId)));
      return res.json({ success: true, message: 'ลบการแจ้งเตือนเรียบร้อยแล้ว' });
    }

    if (userId) {
      await query(
        `DELETE FROM notifications WHERE id = $1 AND UPPER(user_id) = $2`,
        [notifId, userId]
      );
    } else {
      await query(
        `DELETE FROM notifications WHERE id = $1`,
        [notifId]
      );
    }

    res.json({ success: true, message: 'ลบการแจ้งเตือนเรียบร้อยแล้ว' });
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({ error: 'ไม่สามารถลบการแจ้งเตือนได้: ' + error.message });
  }
});

// ==========================================
// 11. Analytics & Visual Charts API
// ==========================================
app.get('/api/analytics/summary', async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const department = (req.query.department || 'ALL').trim();
    const shift = (req.query.shift || 'ALL').trim();

    const thaiMonthNames = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
    const thaiDayNames = ['วันอาทิตย์', 'วันจันทร์', 'วันอังคาร', 'วันพุธ', 'วันพฤหัสบดี', 'วันศุกร์', 'วันเสาร์'];

    if (!pool) {
      // Demo analytics response
      const demoMonths = thaiMonthNames.map((name, idx) => ({
        month: idx + 1,
        monthName: name,
        approvedDays: [2, 3, 5, 8, 4, 3, 2, 4, 6, 3, 5, 7][idx],
        approvedCount: [2, 2, 4, 6, 3, 2, 2, 3, 4, 2, 4, 5][idx],
        pendingCount: idx === 8 ? 2 : 0
      }));

      return res.json({
        success: true,
        year,
        department,
        shift,
        summary: {
          totalApprovedDays: 52,
          totalApprovedRequests: 39,
          pendingRequests: 2,
          sickLeaveRate: 23.1,
          peakDayOfWeek: 'วันศุกร์',
          peakMonth: 'เม.ย.'
        },
        monthlyTrend: demoMonths,
        byType: {
          Vacation: { days: 24, count: 18, percentage: 46.2 },
          Personal: { days: 12, count: 10, percentage: 23.1 },
          Sick: { days: 12, count: 8, percentage: 23.1 },
          Unpaid: { days: 4, count: 3, percentage: 7.7 }
        },
        byDayOfWeek: [
          { dayName: 'วันจันทร์', days: 12, count: 9 },
          { dayName: 'วันอังคาร', days: 6, count: 4 },
          { dayName: 'วันพุธ', days: 5, count: 4 },
          { dayName: 'วันพฤหัสบดี', days: 7, count: 5 },
          { dayName: 'วันศุกร์', days: 18, count: 14 },
          { dayName: 'วันเสาร์', days: 4, count: 3 },
          { dayName: 'วันอาทิตย์', days: 0, count: 0 }
        ],
        byDepartment: [
          { department: 'Assembly', days: 28, count: 21 },
          { department: 'Crimping 1', days: 14, count: 10 },
          { department: 'QC', days: 6, count: 5 },
          { department: 'HR', days: 4, count: 3 }
        ],
        byShift: [
          { shift: 'A', days: 26, count: 19 },
          { shift: 'B', days: 20, count: 15 },
          { shift: 'Morning', days: 6, count: 5 }
        ]
      });
    }

    // Dynamic SQL Query with filters
    let sql = `
      SELECT 
        lr.id,
        lr.leave_type,
        TO_CHAR(lr.start_date, 'YYYY-MM-DD') AS start_date,
        TO_CHAR(lr.end_date, 'YYYY-MM-DD') AS end_date,
        EXTRACT(MONTH FROM lr.start_date)::int AS leave_month,
        EXTRACT(DOW FROM lr.start_date)::int AS day_of_week,
        lr.days_count,
        lr.duration_type,
        lr.hours_count,
        lr.status,
        COALESCE(e.department, 'Assembly') AS department,
        COALESCE(e.shift, 'A') AS shift,
        e.name AS employee_name
      FROM leave_requests lr
      JOIN employees e ON lr.employee_id = e.id
      WHERE EXTRACT(YEAR FROM lr.start_date) = $1
    `;
    const params = [year];

    if (department && department.toUpperCase() !== 'ALL') {
      params.push(department.toUpperCase());
      sql += ` AND UPPER(e.department) = $${params.length}`;
    }

    if (shift && shift.toUpperCase() !== 'ALL') {
      params.push(shift.trim().toUpperCase());
      sql += ` AND UPPER(COALESCE(e.shift, 'A')) = $${params.length}`;
    }

    const { rows } = await query(sql, params);

    // Calculate aggregated metrics
    const monthlyMap = {};
    for (let m = 1; m <= 12; m++) {
      monthlyMap[m] = {
        month: m,
        monthName: thaiMonthNames[m - 1],
        approvedDays: 0,
        approvedCount: 0,
        pendingCount: 0
      };
    }

    const typeMap = {
      Vacation: { days: 0, count: 0 },
      Personal: { days: 0, count: 0 },
      Sick: { days: 0, count: 0 },
      Unpaid: { days: 0, count: 0 }
    };

    const dowMap = {};
    for (let d = 0; d < 7; d++) {
      dowMap[d] = { dayIndex: d, dayName: thaiDayNames[d], days: 0, count: 0 };
    }

    const deptMap = {};
    const shiftMap = {};

    let totalApprovedDays = 0;
    let totalApprovedRequests = 0;
    let pendingRequests = 0;

    rows.forEach(r => {
      const days = parseFloat(r.days_count) || 0;
      const m = r.leave_month;
      const dow = r.day_of_week;
      const normType = normalizeLeaveType(r.leave_type);
      const isApproved = (r.status || '').toUpperCase() === 'APPROVED';
      const isPending = (r.status || '').toUpperCase() === 'PENDING';

      if (isPending) {
        pendingRequests++;
        if (monthlyMap[m]) monthlyMap[m].pendingCount++;
      }

      if (isApproved) {
        totalApprovedDays += days;
        totalApprovedRequests++;

        if (monthlyMap[m]) {
          monthlyMap[m].approvedDays += days;
          monthlyMap[m].approvedCount++;
        }

        if (typeMap[normType]) {
          typeMap[normType].days += days;
          typeMap[normType].count++;
        }

        if (dowMap[dow]) {
          dowMap[dow].days += days;
          dowMap[dow].count++;
        }

        // Dept Map
        const dName = r.department || 'Other';
        if (!deptMap[dName]) deptMap[dName] = { department: dName, days: 0, count: 0 };
        deptMap[dName].days += days;
        deptMap[dName].count++;

        // Shift Map
        const sName = (r.shift || 'A').toUpperCase() === 'B' ? 'B' : ((r.shift || '').toUpperCase() === 'MORNING' ? 'Morning' : 'A');
        if (!shiftMap[sName]) shiftMap[sName] = { shift: sName, days: 0, count: 0 };
        shiftMap[sName].days += days;
        shiftMap[sName].count++;
      }
    });

    // Rounding & Percentage Calculations
    totalApprovedDays = Number(totalApprovedDays.toFixed(2));
    Object.keys(monthlyMap).forEach(m => {
      monthlyMap[m].approvedDays = Number(monthlyMap[m].approvedDays.toFixed(2));
    });

    const byType = {};
    Object.keys(typeMap).forEach(t => {
      const d = Number(typeMap[t].days.toFixed(2));
      const pct = totalApprovedDays > 0 ? Number(((d / totalApprovedDays) * 100).toFixed(1)) : 0;
      byType[t] = { days: d, count: typeMap[t].count, percentage: pct };
    });

    const byDayOfWeek = Object.values(dowMap).map(d => ({
      ...d,
      days: Number(d.days.toFixed(2))
    }));

    const byDepartment = Object.values(deptMap).map(d => ({
      ...d,
      days: Number(d.days.toFixed(2))
    })).sort((a, b) => b.days - a.days);

    const byShift = Object.values(shiftMap).map(s => ({
      ...s,
      days: Number(s.days.toFixed(2))
    })).sort((a, b) => b.days - a.days);

    // Peak insights
    const sickDays = byType.Sick ? byType.Sick.days : 0;
    const sickLeaveRate = totalApprovedDays > 0 ? Number(((sickDays / totalApprovedDays) * 100).toFixed(1)) : 0;

    let peakDayOfWeek = '-';
    let maxDowDays = -1;
    byDayOfWeek.forEach(d => {
      if (d.days > maxDowDays && d.days > 0) {
        maxDowDays = d.days;
        peakDayOfWeek = d.dayName;
      }
    });

    let peakMonth = '-';
    let maxMonthDays = -1;
    Object.values(monthlyMap).forEach(m => {
      if (m.approvedDays > maxMonthDays && m.approvedDays > 0) {
        maxMonthDays = m.approvedDays;
        peakMonth = m.monthName;
      }
    });

    res.json({
      success: true,
      year,
      department,
      shift,
      summary: {
        totalApprovedDays,
        totalApprovedRequests,
        pendingRequests,
        sickLeaveRate,
        peakDayOfWeek,
        peakMonth
      },
      monthlyTrend: Object.values(monthlyMap),
      byType,
      byDayOfWeek,
      byDepartment,
      byShift
    });
  } catch (error) {
    console.error('Analytics summary error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลสถิติ: ' + error.message });
  }
});

// ==========================================
// WEB PUSH NOTIFICATIONS API
// ==========================================

// GET /api/push/vapid-public-key - Get VAPID Public Key for client subscription
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({
    success: true,
    publicKey: VAPID_PUBLIC_KEY
  });
});

// POST /api/push/subscribe - Register or update a user's web push subscription
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { userId, subscription, userAgent } = req.body;
    if (!userId || !subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ error: 'ข้อมูลการสมัครรับแจ้งเตือนไม่ครบถ้วน (userId and subscription required)' });
    }

    const cleanUserId = userId.toString().trim().toUpperCase();
    const endpoint = subscription.endpoint;
    const p256dh = subscription.keys.p256dh;
    const auth = subscription.keys.auth;
    const agent = userAgent || req.headers['user-agent'] || '';

    if (!pool) {
      const existingIdx = demoPushSubscriptions.findIndex(s => s.endpoint === endpoint);
      if (existingIdx >= 0) {
        demoPushSubscriptions[existingIdx] = {
          ...demoPushSubscriptions[existingIdx],
          user_id: cleanUserId,
          p256dh,
          auth,
          user_agent: agent,
          updated_at: new Date().toISOString()
        };
      } else {
        demoPushSubscriptions.push({
          id: nextDemoPushSubId++,
          user_id: cleanUserId,
          endpoint,
          p256dh,
          auth,
          user_agent: agent,
          created_at: new Date().toISOString()
        });
      }
      return res.json({ success: true, message: 'ลงทะเบียนรับการแจ้งเตือนสำเร็จ (Demo)' });
    }

    await query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, updated_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent,
         updated_at = CURRENT_TIMESTAMP`,
      [cleanUserId, endpoint, p256dh, auth, agent]
    );

    res.json({ success: true, message: 'ลงทะเบียนรับการแจ้งเตือนบนอุปกรณ์นี้สำเร็จ' });
  } catch (error) {
    console.error('Push subscribe error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการลงทะเบียนการแจ้งเตือน: ' + error.message });
  }
});

// POST /api/push/unsubscribe - Unregister a web push subscription
app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const { userId, endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: 'ต้องระบุ endpoint ที่ต้องการยกเลิก' });
    }

    if (!pool) {
      demoPushSubscriptions = demoPushSubscriptions.filter(s => s.endpoint !== endpoint);
      return res.json({ success: true, message: 'ยกเลิกการแจ้งเตือนสำเร็จ' });
    }

    await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
    res.json({ success: true, message: 'ยกเลิกการแจ้งเตือนบนอุปกรณ์นี้สำเร็จ' });
  } catch (error) {
    console.error('Push unsubscribe error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการยกเลิกการแจ้งเตือน: ' + error.message });
  }
});

// POST /api/push/test - Send a test push notification to user's registered devices
app.post('/api/push/test', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'ต้องระบุ userId สำหรับทดสอบ' });
    }

    const cleanUserId = userId.toString().trim().toUpperCase();
    await sendWebPushNotification(cleanUserId, {
      title: '🔔 ทดสอบการแจ้งเตือน Web Push สำเร็จ!',
      body: 'อุปกรณ์ของคุณเชื่อมต่อกับระบบลางานเรียบร้อยแล้ว จะได้รับแจ้งเตือนทันทีเมื่อมีรายการใหม่',
      url: '/'
    });

    res.json({ success: true, message: 'ส่งการแจ้งเตือนทดสอบเรียบร้อยแล้ว' });
  } catch (error) {
    console.error('Push test error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการส่งข้อความทดสอบ: ' + error.message });
  }
});

// ==========================================
// SHIFT SWAP REQUESTS API (ระบบสลับกะ/แลกกะการทำงาน)
// ==========================================

// GET /api/shift-swaps - List shift swap requests
app.get('/api/shift-swaps', async (req, res) => {
  try {
    const { employeeId, department, status } = req.query;

    if (!pool) {
      let filtered = [...demoShiftSwaps];
      if (employeeId) {
        const cleanEmpId = employeeId.trim().toUpperCase();
        filtered = filtered.filter(s => s.requester_id === cleanEmpId || s.target_employee_id === cleanEmpId);
      }
      if (department && department.toUpperCase() !== 'ALL') {
        filtered = filtered.filter(s => (s.department || '').toUpperCase() === department.toUpperCase());
      }
      if (status && status.toUpperCase() !== 'ALL') {
        filtered = filtered.filter(s => (s.status || '').toUpperCase() === status.toUpperCase());
      }
      return res.json({ success: true, swaps: filtered });
    }

    let sql = `
      SELECT 
        sw.id,
        sw.requester_id,
        req_emp.name AS requester_name,
        req_emp.shift AS requester_current_shift,
        sw.target_employee_id,
        tar_emp.name AS target_employee_name,
        tar_emp.shift AS target_current_shift,
        sw.department,
        TO_CHAR(sw.requester_date, 'YYYY-MM-DD') AS requester_date,
        sw.requester_shift,
        TO_CHAR(sw.target_date, 'YYYY-MM-DD') AS target_date,
        sw.target_shift,
        sw.reason,
        sw.status,
        sw.peer_responded_at,
        sw.peer_rejection_reason,
        sw.reviewed_by,
        rev_emp.name AS reviewer_name,
        sw.reviewed_at,
        sw.supervisor_rejection_reason,
        sw.created_at
      FROM shift_swap_requests sw
      LEFT JOIN employees req_emp ON sw.requester_id = req_emp.id
      LEFT JOIN employees tar_emp ON sw.target_employee_id = tar_emp.id
      LEFT JOIN employees rev_emp ON sw.reviewed_by = rev_emp.id
      WHERE 1=1
    `;
    const params = [];

    if (employeeId) {
      params.push(employeeId.trim().toUpperCase());
      sql += ` AND (sw.requester_id = $${params.length} OR sw.target_employee_id = $${params.length})`;
    }

    if (department && department.toUpperCase() !== 'ALL') {
      params.push(department.trim().toUpperCase());
      sql += ` AND UPPER(sw.department) = $${params.length}`;
    }

    if (status && status.toUpperCase() !== 'ALL') {
      params.push(status.trim().toUpperCase());
      sql += ` AND UPPER(sw.status) = $${params.length}`;
    }

    sql += ` ORDER BY sw.created_at DESC`;

    const { rows } = await query(sql, params);
    res.json({ success: true, swaps: rows });
  } catch (error) {
    console.error('Fetch shift swaps error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลการแลกกะ: ' + error.message });
  }
});

// POST /api/shift-swaps - Submit a new shift swap request
app.post('/api/shift-swaps', async (req, res) => {
  try {
    const { requesterId, targetEmployeeId, requesterDate, requesterShift, targetDate, targetShift, reason } = req.body;

    if (!requesterId || !targetEmployeeId || !requesterDate || !requesterShift || !targetDate || !targetShift) {
      return res.status(400).json({ error: 'กรุณากรอกข้อมูลการแลกกะให้ครบถ้วน' });
    }

    const cleanReqId = requesterId.trim().toUpperCase();
    const cleanTarId = targetEmployeeId.trim().toUpperCase();

    if (cleanReqId === cleanTarId) {
      return res.status(400).json({ error: 'ไม่สามารถยื่นขอแลกกะกับตัวเองได้' });
    }

    // Check employees in database or demo
    let reqEmp = null;
    let tarEmp = null;

    if (!pool) {
      reqEmp = { id: cleanReqId, name: 'พนักงานผู้ขอ', department: 'Assembly' };
      tarEmp = { id: cleanTarId, name: 'เพื่อนร่วมงาน', department: 'Assembly' };
    } else {
      const eRes = await query('SELECT id, name, department, shift FROM employees WHERE id IN ($1, $2)', [cleanReqId, cleanTarId]);
      reqEmp = eRes.rows.find(r => r.id === cleanReqId);
      tarEmp = eRes.rows.find(r => r.id === cleanTarId);
    }

    if (!reqEmp || !tarEmp) {
      return res.status(404).json({ error: 'ไม่พบข้อมูลพนักงานผู้ขอ หรือเพื่อนร่วมงานในระบบ' });
    }

    if (reqEmp.department && tarEmp.department && reqEmp.department.toUpperCase() !== tarEmp.department.toUpperCase()) {
      return res.status(400).json({ error: 'สามารถแลกกะได้เฉพาะเพื่อนร่วมงานในแผนกเดียวกันเท่านั้น' });
    }

    const dept = reqEmp.department || 'Assembly';

    let createdSwap = null;
    if (!pool) {
      createdSwap = {
        id: nextDemoShiftSwapId++,
        requester_id: cleanReqId,
        requester_name: reqEmp.name,
        target_employee_id: cleanTarId,
        target_employee_name: tarEmp.name,
        department: dept,
        requester_date: requesterDate,
        requester_shift: requesterShift,
        target_date: targetDate,
        target_shift: targetShift,
        reason: reason || '',
        status: 'PENDING_PEER',
        created_at: new Date().toISOString()
      };
      demoShiftSwaps.unshift(createdSwap);
    } else {
      const insRes = await query(
        `INSERT INTO shift_swap_requests 
         (requester_id, target_employee_id, department, requester_date, requester_shift, target_date, target_shift, reason, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING_PEER')
         RETURNING *`,
        [cleanReqId, cleanTarId, dept, requesterDate, requesterShift, targetDate, targetShift, reason || '']
      );
      createdSwap = insRes.rows[0];
    }

    // Send In-App & Web Push Notification to target colleague
    await createNotification(
      cleanTarId,
      `🔄 มีคำขอแลกกะจาก ${reqEmp.name}`,
      `ขอยื่นแลกกะวันที่ ${requesterDate} (${requesterShift}) กับกะของคุณวันที่ ${targetDate} (${targetShift}) เหตุผล: ${reason || '-'}`,
      'SHIFT_SWAP_REQUESTED',
      createdSwap.id
    );

    // Send confirmation to requester
    await createNotification(
      cleanReqId,
      '📤 ยื่นคำขอแลกกะเรียบร้อยแล้ว',
      `คำขอแลกกะกับ ${tarEmp.name} (วันที่ ${requesterDate} ⇄ ${targetDate}) อยู่ในสถานะรอเพื่อนร่วมงานตอบรับ`,
      'SHIFT_SWAP_SUBMITTED',
      createdSwap.id
    );

    res.status(201).json({
      success: true,
      message: 'ยื่นคำขอแลกกะเรียบร้อยแล้ว รอเพื่อนร่วมงานตอบรับ',
      swap: createdSwap
    });
  } catch (error) {
    console.error('Create shift swap error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการยื่นขอแลกกะ: ' + error.message });
  }
});

// PATCH /api/shift-swaps/:id/peer-response - Colleague responds (ACCEPT or REJECT)
app.patch('/api/shift-swaps/:id/peer-response', async (req, res) => {
  try {
    const swapId = parseInt(req.params.id, 10);
    const { employeeId, action, reason } = req.body;

    if (!employeeId || !action || !['ACCEPT', 'REJECT'].includes(action.toUpperCase())) {
      return res.status(400).json({ error: 'ข้อมูลการตอบรับไม่ถูกต้อง (employeeId and action: ACCEPT/REJECT required)' });
    }

    const cleanEmpId = employeeId.trim().toUpperCase();
    const cleanAction = action.toUpperCase();

    let swap = null;
    if (!pool) {
      swap = demoShiftSwaps.find(s => s.id === swapId);
    } else {
      const q = await query(`
        SELECT sw.*, req.name as requester_name, tar.name as target_name 
        FROM shift_swap_requests sw
        JOIN employees req ON sw.requester_id = req.id
        JOIN employees tar ON sw.target_employee_id = tar.id
        WHERE sw.id = $1
      `, [swapId]);
      swap = q.rows[0];
    }

    if (!swap) {
      return res.status(404).json({ error: 'ไม่พบรายการคำขอแลกกะนี้' });
    }

    if (swap.target_employee_id !== cleanEmpId) {
      return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ตอบรับคำขอนี้ เนื่องจากไม่ใช่ผู้ถูกขอแลก' });
    }

    if (swap.status !== 'PENDING_PEER') {
      return res.status(400).json({ error: `ไม่สามารถตอบรับได้ เนื่องจากรายการอยู่ในสถานะ ${swap.status}` });
    }

    const newStatus = cleanAction === 'ACCEPT' ? 'PENDING_SUPERVISOR' : 'REJECTED_BY_PEER';

    if (!pool) {
      swap.status = newStatus;
      swap.peer_responded_at = new Date().toISOString();
      swap.peer_rejection_reason = cleanAction === 'REJECT' ? (reason || 'เพื่อนร่วมงานไม่สะดวกแลกกะ') : null;
    } else {
      await query(
        `UPDATE shift_swap_requests 
         SET status = $1, peer_responded_at = CURRENT_TIMESTAMP, peer_rejection_reason = $2
         WHERE id = $3`,
        [newStatus, cleanAction === 'REJECT' ? (reason || 'เพื่อนร่วมงานไม่สะดวกแลกกะ') : null, swapId]
      );
    }

    const targetName = swap.target_name || swap.target_employee_name || 'เพื่อนร่วมงาน';
    const reqName = swap.requester_name || swap.requester_id;

    if (cleanAction === 'ACCEPT') {
      // Notify requester that peer accepted
      await createNotification(
        swap.requester_id,
        '🤝 เพื่อนร่วมงานยอมรับการแลกกะแล้ว',
        `${targetName} ยอมรับคำขอแลกกะแล้ว (วันที่ ${swap.requester_date} ⇄ ${swap.target_date}) รายการถูกส่งต่อให้หัวหน้างานพิจารณาอนุมัติ`,
        'SHIFT_SWAP_PEER_ACCEPTED',
        swapId
      );

      // Notify supervisors of the department
      let supervisors = [];
      if (!pool) {
        supervisors = [{ id: 'SUP-001' }];
      } else {
        const sRes = await query("SELECT id FROM employees WHERE department = $1 AND role IN ('SUPERVISOR', 'ADMIN')", [swap.department]);
        supervisors = sRes.rows;
      }
      for (const sup of supervisors) {
        await createNotification(
          sup.id,
          '⏳ มีคำขอแลกกะรอการอนุมัติ',
          `${reqName} และ ${targetName} แผนก ${swap.department} ได้ตกลงแลกกะกัน และรอคุณพิจารณาอนุมัติ`,
          'SHIFT_SWAP_PENDING_SUPERVISOR',
          swapId
        );
      }
    } else {
      // Notify requester that peer rejected
      await createNotification(
        swap.requester_id,
        '❌ เพื่อนร่วมงานไม่สะดวกแลกกะ',
        `${targetName} ปฏิเสธคำขอแลกกะ (${reason || 'ไม่สะดวกในวันดังกล่าว'})`,
        'SHIFT_SWAP_PEER_REJECTED',
        swapId
      );
    }

    res.json({
      success: true,
      message: cleanAction === 'ACCEPT' ? 'ยอมรับการแลกกะแล้ว ส่งต่อให้หัวหน้างานพิจารณา' : 'ปฏิเสธคำขอแลกกะเรียบร้อยแล้ว',
      status: newStatus
    });
  } catch (error) {
    console.error('Peer response error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการตอบรับคำขอ: ' + error.message });
  }
});

// PATCH /api/shift-swaps/:id/supervisor-review - Supervisor approves or rejects
app.patch('/api/shift-swaps/:id/supervisor-review', async (req, res) => {
  try {
    const swapId = parseInt(req.params.id, 10);
    const { supervisorId, action, reason } = req.body;

    if (!supervisorId || !action || !['APPROVE', 'REJECT'].includes(action.toUpperCase())) {
      return res.status(400).json({ error: 'ข้อมูลการพิจารณาไม่ถูกต้อง (supervisorId and action: APPROVE/REJECT required)' });
    }

    const cleanSupId = supervisorId.trim().toUpperCase();
    const cleanAction = action.toUpperCase();

    // Verify supervisor role
    let supEmp = null;
    if (!pool) {
      supEmp = { id: cleanSupId, name: 'หัวหน้างาน', role: 'SUPERVISOR' };
    } else {
      const supRes = await query("SELECT id, name, role, department FROM employees WHERE id = $1 AND role IN ('SUPERVISOR', 'ADMIN', 'HR')", [cleanSupId]);
      supEmp = supRes.rows[0];
    }

    if (!supEmp) {
      return res.status(403).json({ error: 'เฉพาะหัวหน้างาน (Supervisor), HR หรือ Admin เท่านั้นที่มีสิทธิ์อนุมัติ' });
    }

    let swap = null;
    if (!pool) {
      swap = demoShiftSwaps.find(s => s.id === swapId);
    } else {
      const q = await query(`
        SELECT sw.*, req.name as requester_name, tar.name as target_name 
        FROM shift_swap_requests sw
        JOIN employees req ON sw.requester_id = req.id
        JOIN employees tar ON sw.target_employee_id = tar.id
        WHERE sw.id = $1
      `, [swapId]);
      swap = q.rows[0];
    }

    if (!swap) {
      return res.status(404).json({ error: 'ไม่พบรายการคำขอแลกกะนี้' });
    }

    if (swap.status !== 'PENDING_SUPERVISOR') {
      return res.status(400).json({ error: `ไม่สามารถพิจารณาได้เนื่องจากรายการอยู่ในสถานะ ${swap.status}` });
    }

    const newStatus = cleanAction === 'APPROVE' ? 'APPROVED' : 'REJECTED_BY_SUPERVISOR';

    if (!pool) {
      swap.status = newStatus;
      swap.reviewed_by = cleanSupId;
      swap.reviewer_name = supEmp.name;
      swap.reviewed_at = new Date().toISOString();
      swap.supervisor_rejection_reason = cleanAction === 'REJECT' ? (reason || 'หัวหน้างานไม่อนุมัติ') : null;
    } else {
      await query(
        `UPDATE shift_swap_requests 
         SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, supervisor_rejection_reason = $3
         WHERE id = $4`,
        [newStatus, cleanSupId, cleanAction === 'REJECT' ? (reason || 'หัวหน้างานไม่อนุมัติ') : null, swapId]
      );
    }

    const reqName = swap.requester_name || swap.requester_id;
    const targetName = swap.target_name || swap.target_employee_id;

    if (cleanAction === 'APPROVE') {
      await createNotification(
        swap.requester_id,
        '✅ หัวหน้างานอนุมัติการแลกกะแล้ว',
        `การแลกกะกับ ${targetName} ได้รับการอนุมัติแล้ว คุณปฏิบัติงานวันที่ ${swap.target_date} (กะ ${swap.target_shift})`,
        'SHIFT_SWAP_APPROVED',
        swapId
      );
      await createNotification(
        swap.target_employee_id,
        '✅ หัวหน้างานอนุมัติการแลกกะแล้ว',
        `การแลกกะกับ ${reqName} ได้รับการอนุมัติแล้ว คุณปฏิบัติงานวันที่ ${swap.requester_date} (กะ ${swap.requester_shift})`,
        'SHIFT_SWAP_APPROVED',
        swapId
      );
    } else {
      const rejReason = reason || 'หัวหน้างานไม่อนุมัติ';
      await createNotification(
        swap.requester_id,
        '❌ หัวหน้างานไม่อนุมัติการแลกกะ',
        `คำขอแลกกะกับ ${targetName} ไม่ได้รับการอนุมัติ (เหตุผล: ${rejReason})`,
        'SHIFT_SWAP_REJECTED',
        swapId
      );
      await createNotification(
        swap.target_employee_id,
        '❌ คำขอแลกกะไม่ได้รับการอนุมัติ',
        `คำขอแลกกะกับ ${reqName} ไม่ได้รับการอนุมัติจากหัวหน้างาน (เหตุผล: ${rejReason})`,
        'SHIFT_SWAP_REJECTED',
        swapId
      );
    }

    res.json({
      success: true,
      message: cleanAction === 'APPROVE' ? 'อนุมัติการแลกกะเรียบร้อยแล้ว' : 'ปฏิเสธการแลกกะเรียบร้อยแล้ว',
      status: newStatus
    });
  } catch (error) {
    console.error('Supervisor review error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการพิจารณาการแลกกะ: ' + error.message });
  }
});

// PATCH /api/shift-swaps/:id/cancel - Requester cancels swap request
app.patch('/api/shift-swaps/:id/cancel', async (req, res) => {
  try {
    const swapId = parseInt(req.params.id, 10);
    const { employeeId } = req.body;

    if (!employeeId) {
      return res.status(400).json({ error: 'ต้องระบุ employeeId' });
    }

    const cleanEmpId = employeeId.trim().toUpperCase();

    let swap = null;
    if (!pool) {
      swap = demoShiftSwaps.find(s => s.id === swapId);
    } else {
      const q = await query('SELECT * FROM shift_swap_requests WHERE id = $1', [swapId]);
      swap = q.rows[0];
    }

    if (!swap) {
      return res.status(404).json({ error: 'ไม่พบรายการคำขอแลกกะนี้' });
    }

    if (swap.requester_id !== cleanEmpId) {
      return res.status(403).json({ error: 'คุณสามารถยกเลิกได้เฉพาะคำขอที่คุณเป็นผู้ยื่นเท่านั้น' });
    }

    if (!['PENDING_PEER', 'PENDING_SUPERVISOR'].includes(swap.status)) {
      return res.status(400).json({ error: 'ไม่สามารถยกเลิกคำขอนี้ได้เนื่องจากผ่านการพิจารณาแล้ว' });
    }

    if (!pool) {
      swap.status = 'CANCELLED';
    } else {
      await query("UPDATE shift_swap_requests SET status = 'CANCELLED' WHERE id = $1", [swapId]);
    }

    res.json({ success: true, message: 'ยกเลิกคำขอแลกกะเรียบร้อยแล้ว' });
  } catch (error) {
    console.error('Cancel swap error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการยกเลิกคำขอ: ' + error.message });
  }
});

// Start Server
const server = app.listen(PORT, () => {
  console.log(`🚀 Leave Management Server is running on http://localhost:${PORT}`);
});

module.exports = app;
module.exports.app = app;
module.exports.server = server;
