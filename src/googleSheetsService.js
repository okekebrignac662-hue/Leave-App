/**
 * ============================================================================
 * Google Sheets Integration Service
 * ============================================================================
 * บริการเชื่อมต่อและซิงค์ข้อมูลกับ Google Sheets ผ่าน Apps Script Webhook
 * รองรับการซิงค์แบบ Real-time และการกด Sync ทั้งหมดด้วยมือ (Manual Bulk Sync)
 * ============================================================================
 */

let dbPool = null;
let dbQuery = null;

let cachedConfig = {
  webhookUrl: process.env.GOOGLE_SHEET_WEBHOOK_URL || '',
  autoSync: true,
  lastSyncTime: null,
  lastSyncStatus: null,
  lastSyncMessage: null
};

/**
 * กำหนดค่าการเชื่อมต่อฐานข้อมูลและโหลดการตั้งค่าจาก PostgreSQL (ถ้ามี)
 */
async function init(pool, query) {
  dbPool = pool;
  dbQuery = query;

  if (dbPool && dbQuery) {
    try {
      const res = await dbQuery(
        "SELECT key, value FROM system_settings WHERE key IN ('google_sheet_webhook_url', 'google_sheet_auto_sync')"
      );
      res.rows.forEach(row => {
        if (row.key === 'google_sheet_webhook_url' && row.value) {
          cachedConfig.webhookUrl = row.value.trim();
        }
        if (row.key === 'google_sheet_auto_sync') {
          cachedConfig.autoSync = row.value === 'true' || row.value === true;
        }
      });
    } catch (err) {
      // Table might not exist yet or connection error; fallback to process.env
      // console.warn('Could not load google sheets settings from DB:', err.message);
    }
  }
}

/**
 * ดึงสถานะการตั้งค่า Google Sheets ปัจจุบัน
 */
function getConfig() {
  return {
    configured: Boolean(cachedConfig.webhookUrl && cachedConfig.webhookUrl.trim()),
    webhookUrl: cachedConfig.webhookUrl || '',
    autoSync: cachedConfig.autoSync,
    lastSyncTime: cachedConfig.lastSyncTime,
    lastSyncStatus: cachedConfig.lastSyncStatus,
    lastSyncMessage: cachedConfig.lastSyncMessage
  };
}

/**
 * บันทึกการตั้งค่า Google Sheets Webhook URL ลงหน่วยความจำและฐานข้อมูล
 */
async function saveConfig({ webhookUrl, autoSync }) {
  if (webhookUrl !== undefined) {
    cachedConfig.webhookUrl = (webhookUrl || '').trim();
  }
  if (autoSync !== undefined) {
    cachedConfig.autoSync = Boolean(autoSync);
  }

  if (dbPool && dbQuery) {
    try {
      if (webhookUrl !== undefined) {
        await dbQuery(
          `INSERT INTO system_settings (key, value, updated_at)
           VALUES ('google_sheet_webhook_url', $1, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
          [cachedConfig.webhookUrl]
        );
      }
      if (autoSync !== undefined) {
        await dbQuery(
          `INSERT INTO system_settings (key, value, updated_at)
           VALUES ('google_sheet_auto_sync', $1, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
          [cachedConfig.autoSync ? 'true' : 'false']
        );
      }
    } catch (err) {
      console.warn('⚠️ Could not save google sheets settings to DB:', err.message);
    }
  }

  return getConfig();
}

/**
 * ส่งคำขอไปยัง Google Apps Script Webhook
 */
async function postToWebhook(payload, targetUrl = null, timeoutMs = 25000) {
  const url = targetUrl || cachedConfig.webhookUrl;
  if (!url || !url.trim()) {
    throw new Error('ยังไม่ได้กำหนด URL ของ Google Apps Script Webhook');
  }

  if (!url.startsWith('https://script.google.com/')) {
    throw new Error('URL ไม่ถูกต้อง ต้องเป็น URL ของ Google Apps Script ที่ขึ้นต้นด้วย https://script.google.com/');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: controller.signal
    });

    clearTimeout(timer);

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Google Sheets ส่งข้อมูลตอบกลับในรูปแบบที่ไม่ถูกต้อง (ได้รับ: ${text.slice(0, 100)})`);
    }

    if (!data.success) {
      throw new Error(data.error || 'Google Apps Script รายงานข้อผิดพลาด');
    }

    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error('การเชื่อมต่อไปยัง Google Sheets หมดเวลา (Timeout เกิน 25 วินาที)');
    }
    throw err;
  }
}

/**
 * ทดสอบการเชื่อมต่อไปยัง Google Sheets Webhook
 */
async function testConnection(targetUrl = null) {
  const url = targetUrl || cachedConfig.webhookUrl;
  const result = await postToWebhook({ action: 'TEST_CONNECTION' }, url, 20000);
  return result;
}

/**
 * แปลงวันที่เป็น YYYY-MM-DD ตามเขตเวลา Asia/Bangkok
 */
function formatDateOnly(d) {
  if (!d) return '';
  if (typeof d === 'string') {
    const trimmed = d.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }
  }
  const dateObj = new Date(d);
  if (isNaN(dateObj.getTime())) return String(d);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(dateObj);
}

/**
 * เติมข้อมูลพนักงาน (ชื่อ-นามสกุล, แผนก, กะ) ในกรณีที่คำขอลาไม่มีข้อมูลหรือชื่อซ้ำกับรหัสพนักงาน
 */
async function enrichLeaveRequest(leaveReq) {
  if (!leaveReq) return leaveReq;
  const empId = String(leaveReq.employee_id || '').trim().toUpperCase();
  const currentName = leaveReq.employee_name || leaveReq.name;
  const needsName = !currentName || currentName === leaveReq.employee_id;
  const needsDept = !leaveReq.department;

  if (dbQuery && empId && (needsName || needsDept)) {
    try {
      const eRes = await dbQuery('SELECT name, department, shift FROM employees WHERE UPPER(id) = $1', [empId]);
      if (eRes.rows.length > 0) {
        const emp = eRes.rows[0];
        return {
          ...leaveReq,
          employee_name: (needsName && emp.name) ? emp.name : (currentName || leaveReq.employee_id),
          department: needsDept ? (emp.department || '') : leaveReq.department,
          shift: emp.shift || leaveReq.shift || 'A'
        };
      }
    } catch (_) {}
  }
  return leaveReq;
}

/**
 * เติมข้อมูลพนักงานแบบกลุ่ม (Bulk) ให้กับรายการคำขอลางานทั้งหมด
 */
async function enrichLeavesList(leavesList) {
  if (!Array.isArray(leavesList) || leavesList.length === 0) return [];
  if (!dbQuery) return leavesList;

  try {
    const eRes = await dbQuery('SELECT id, name, department, shift FROM employees');
    const empMap = new Map();
    eRes.rows.forEach(e => {
      empMap.set(String(e.id).trim().toUpperCase(), e);
    });

    return leavesList.map(req => {
      const empId = String(req.employee_id || '').trim().toUpperCase();
      const emp = empMap.get(empId);
      const currentName = req.employee_name || req.name;
      const validName = (currentName && currentName !== req.employee_id) ? currentName : (emp ? emp.name : req.employee_id);
      return {
        ...req,
        employee_name: validName,
        department: req.department || (emp ? emp.department : ''),
        shift: req.shift || (emp ? emp.shift : 'A')
      };
    });
  } catch (_) {
    return leavesList;
  }
}

/**
 * จัดรูปแบบข้อมูลคำขอลางานให้พร้อมส่งไปยัง Google Sheets
 */
function formatLeavePayload(req) {
  const hasAttachment = Boolean(req.attachment_url && String(req.attachment_url).trim());
  let attachmentDisplay = '-';
  if (hasAttachment) {
    if (req.attachment_url.startsWith('http://') || req.attachment_url.startsWith('https://')) {
      attachmentDisplay = req.attachment_url;
    } else {
      attachmentDisplay = '📎 มีใบรับรองแพทย์/เอกสารแนบ';
    }
  }

  const cleanEmpId = String(req.employee_id || '').trim();
  const rawEmpName = req.employee_name || req.name;
  const cleanEmpName = (rawEmpName && rawEmpName.trim() !== cleanEmpId) ? rawEmpName.trim() : cleanEmpId;

  return {
    id: req.id,
    employee_id: cleanEmpId,
    employee_name: cleanEmpName,
    department: req.department || '',
    shift: req.shift || 'A',
    leave_type: req.leave_type,
    duration_type: req.duration_type || 'FULL_DAY',
    start_date: formatDateOnly(req.start_date),
    end_date: formatDateOnly(req.end_date || req.start_date),
    days_count: req.days_count !== undefined ? parseFloat(req.days_count) : 1,
    start_time: req.start_time || null,
    end_time: req.end_time || null,
    hours_count: req.hours_count ? parseFloat(req.hours_count) : null,
    reason: req.reason || '',
    status: req.status || 'PENDING',
    reviewer_name: req.reviewer_name || req.reviewed_by || '',
    reviewed_by: req.reviewed_by || '',
    reviewed_at: req.reviewed_at || null,
    rejection_reason: req.rejection_reason || '',
    attachment_url: req.attachment_url || '',
    attachment_display: attachmentDisplay,
    created_at: req.created_at || new Date().toISOString()
  };
}

/**
 * จัดรูปแบบข้อมูลพนักงานให้พร้อมส่งไปยัง Google Sheets
 */
function formatEmployeePayload(emp) {
  return {
    id: emp.id,
    name: emp.name,
    department: emp.department,
    shift: emp.shift || 'A',
    role: emp.role || 'EMPLOYEE',
    pin: emp.pin || '',
    vacation_quota: emp.vacation_quota !== undefined ? emp.vacation_quota : 6,
    personal_quota: emp.personal_quota !== undefined ? emp.personal_quota : 6,
    sick_quota: emp.sick_quota !== undefined ? emp.sick_quota : 30,
    unpaid_quota: emp.unpaid_quota !== undefined ? emp.unpaid_quota : 30,
    created_at: emp.created_at || new Date().toISOString()
  };
}

/**
 * ซิงค์คำขอลางานเดี่ยว (ส่งแบบ Asynchronous ไม่ให้ขัดจังหวะการตอบสนองผู้ใช้)
 */
function syncLeaveRequestAsync(leaveReq, actionType = 'CREATE_LEAVE') {
  if (!cachedConfig.webhookUrl || !cachedConfig.autoSync) {
    return;
  }

  // เรียกทำงานเบื้องหลังแบบ Non-blocking
  setImmediate(async () => {
    try {
      const enriched = await enrichLeaveRequest(leaveReq);
      const payload = {
        action: actionType,
        data: formatLeavePayload(enriched)
      };
      await postToWebhook(payload);
    } catch (err) {
      console.warn(`[GoogleSheets] Auto-sync leave request failed:`, err.message);
    }
  });
}

/**
 * ซิงค์ข้อมูลพนักงานเดี่ยว (ส่งแบบ Asynchronous)
 */
function syncEmployeeAsync(employee) {
  if (!cachedConfig.webhookUrl || !cachedConfig.autoSync) {
    return;
  }

  setImmediate(async () => {
    try {
      const payload = {
        action: 'UPSERT_EMPLOYEE',
        data: formatEmployeePayload(employee)
      };
      await postToWebhook(payload);
      // console.log(`[GoogleSheets] Synced employee ${employee.id} successfully`);
    } catch (err) {
      console.warn(`[GoogleSheets] Auto-sync employee failed:`, err.message);
    }
  });
}

/**
 * ซิงค์คำขอลางานทั้งหมด (Manual Bulk Sync)
 */
async function syncAllLeaves(leavesList) {
  const enriched = await enrichLeavesList(leavesList);
  const formatted = enriched.map(formatLeavePayload);
  const result = await postToWebhook({
    action: 'SYNC_ALL_LEAVES',
    rows: formatted
  });

  cachedConfig.lastSyncTime = new Date().toISOString();
  cachedConfig.lastSyncStatus = 'SUCCESS';
  cachedConfig.lastSyncMessage = `ซิงค์คำขอลางาน ${formatted.length} รายการสำเร็จ`;

  return result;
}

/**
 * ซิงค์รายชื่อพนักงานทั้งหมด (Manual Bulk Sync)
 */
async function syncAllEmployees(employeesList) {
  const formatted = employeesList.map(formatEmployeePayload);
  const result = await postToWebhook({
    action: 'SYNC_ALL_EMPLOYEES',
    rows: formatted
  });

  cachedConfig.lastSyncTime = new Date().toISOString();
  cachedConfig.lastSyncStatus = 'SUCCESS';
  cachedConfig.lastSyncMessage = `ซิงค์ข้อมูลพนักงาน ${formatted.length} คนสำเร็จ`;

  return result;
}

/**
 * ซิงค์ข้อมูลทั้งหมดทั้งคำขอและพนักงาน (Manual Bulk Sync All)
 */
async function syncAllData(leavesList, employeesList) {
  const enrichedLeaves = await enrichLeavesList(leavesList);
  const formattedLeaves = enrichedLeaves.map(formatLeavePayload);
  const formattedEmployees = employeesList.map(formatEmployeePayload);

  const result = await postToWebhook({
    action: 'SYNC_ALL',
    leaves: formattedLeaves,
    employees: formattedEmployees
  });

  cachedConfig.lastSyncTime = new Date().toISOString();
  cachedConfig.lastSyncStatus = 'SUCCESS';
  cachedConfig.lastSyncMessage = `ซิงค์ข้อมูลทั้งหมดสำเร็จ (คำขอ ${formattedLeaves.length} รายการ, พนักงาน ${formattedEmployees.length} คน)`;

  return result;
}

module.exports = {
  init,
  getConfig,
  saveConfig,
  testConnection,
  formatLeavePayload,
  formatEmployeePayload,
  syncLeaveRequestAsync,
  syncEmployeeAsync,
  syncAllLeaves,
  syncAllEmployees,
  syncAllData
};
