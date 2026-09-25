/**
 * ============================================================================
 * ระบบบันทึกข้อมูลการลางานลง Google Sheets (Leave App Webhook)
 * ============================================================================
 * สคริปต์นี้ใช้สำหรับรับข้อมูลจาก Leave Management Web App และบันทึกลงใน Google Sheets โดยอัตโนมัติ
 * รองรับ 2 แผ่นงาน (Sheets):
 *   1. "รายการลางาน" (Leave Requests)
 *   2. "ข้อมูลพนักงาน" (Employees)
 *
 * วิธีติดตั้ง:
 * 1. เปิด Google Sheet ที่ต้องการเก็บข้อมูล
 * 2. ไปที่เมนู "ส่วนขยาย" (Extensions) > "Apps Script"
 * 3. ลบโค้ดเดิมทั้งหมดออก แล้ววางโค้ดนี้ลงไป
 * 4. กดปุ่ม "บันทึก" (รูปแผ่นดิสก์ 💾)
 * 5. กดปุ่ม "การทำให้ใช้งานได้" (Deploy) > "การทำให้ใช้งานได้ใหม่" (New deployment)
 * 6. เลือกประเภทเป็น "เว็บแอป" (Web app)
 *    - คำอธิบาย: Leave App Webhook
 *    - ดำเนินการในฐานะ: ตัวฉัน (Me)
 *    - ผู้มีสิทธิ์เข้าถึง: ทุกคน (Anyone)  <--- สำคัญมาก! ต้องเลือก "ทุกคน"
 * 7. กด "ทำให้ใช้งานได้" (Deploy) และให้สิทธิ์การเข้าถึง (Authorize access)
 * 8. คัดลอก "URL ของเว็บแอป" (Web app URL) ที่ลงท้ายด้วย /exec ไปวางในหน้าตั้งค่า Google Sheets ของระบบ
 * ============================================================================
 */

// ชื่อแผ่นงาน (Sheet Names)
const SHEET_LEAVES = 'รายการลางาน';
const SHEET_EMPLOYEES = 'ข้อมูลพนักงาน';

// ส่วนหัวคอลัมน์ของแผ่นงาน "รายการลางาน"
const LEAVE_HEADERS = [
  'รหัสคำขอ',
  'รหัสพนักงาน',
  'ชื่อ-นามสกุล',
  'แผนก',
  'กะการทำงาน',
  'ประเภทการลา',
  'รูปแบบการลา',
  'วันเริ่มต้น',
  'วันสิ้นสุด',
  'จำนวนวัน',
  'เวลาเริ่ม',
  'เวลาสิ้นสุด',
  'จำนวนชั่วโมง',
  'เหตุผลการลา',
  'สถานะ',
  'ผู้พิจารณา',
  'วันที่พิจารณา',
  'เหตุผลที่ไม่อนุมัติ',
  'วันที่ยื่นคำขอ',
  'อัปเดตล่าสุด'
];

// ส่วนหัวคอลัมน์ของแผ่นงาน "ข้อมูลพนักงาน"
const EMPLOYEE_HEADERS = [
  'รหัสพนักงาน',
  'ชื่อ-นามสกุล',
  'แผนก',
  'กะการทำงาน',
  'บทบาท (Role)',
  'รหัสผ่าน (PIN)',
  'โควตาพักร้อน (วัน)',
  'โควตากิจ (วัน)',
  'โควตาป่วย (วัน)',
  'โควตาไม่รับค่าจ้าง (วัน)',
  'วันที่ลงทะเบียน',
  'อัปเดตล่าสุด'
];

/**
 * ฟังก์ชันสำหรับรับ HTTP POST จาก Leave App
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  // รอสูงสุด 30 วินาที เพื่อป้องกัน Concurrency เขียนทับกัน
  if (!lock.tryLock(30000)) {
    return createJsonResponse({ success: false, error: 'ระบบกำลังประมวลผลคำขออื่นอยู่ กรุณาลองใหม่อีกครั้ง' });
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({ success: false, error: 'ไม่พบข้อมูลที่ส่งมา (Missing payload)' });
    }

    const payload = JSON.parse(e.postData.contents);
    const action = payload.action;
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    let result = { success: true };

    switch (action) {
      // 1. ทดสอบการเชื่อมต่อ
      case 'TEST_CONNECTION':
        ensureSheetWithHeaders(ss, SHEET_LEAVES, LEAVE_HEADERS, '#1E3A8A');
        ensureSheetWithHeaders(ss, SHEET_EMPLOYEES, EMPLOYEE_HEADERS, '#065F46');
        result = {
          success: true,
          message: 'เชื่อมต่อ Google Sheets สำเร็จเรียบร้อย!',
          sheetTitle: ss.getName(),
          sheets: [SHEET_LEAVES, SHEET_EMPLOYEES],
          timestamp: getBangkokTimestamp()
        };
        break;

      // 2. บันทึกคำขอลางานใหม่ (Create Leave Request)
      case 'CREATE_LEAVE':
        result = handleCreateLeave(ss, payload.data);
        break;

      // 3. อัปเดตสถานะคำขอลางาน (อนุมัติ / ปฏิเสธ / ยกเลิก)
      case 'UPDATE_LEAVE_STATUS':
        result = handleUpdateLeaveStatus(ss, payload.data);
        break;

      // 4. บันทึก / อัปเดตข้อมูลพนักงาน (Upsert Employee)
      case 'UPSERT_EMPLOYEE':
        result = handleUpsertEmployee(ss, payload.data);
        break;

      // 5. ซิงค์คำขอลางานทั้งหมด (Bulk Sync Leaves)
      case 'SYNC_ALL_LEAVES':
        result = handleSyncAllLeaves(ss, payload.rows || []);
        break;

      // 6. ซิงค์รายชื่อพนักงานทั้งหมด (Bulk Sync Employees)
      case 'SYNC_ALL_EMPLOYEES':
        result = handleSyncAllEmployees(ss, payload.rows || []);
        break;

      // 7. ซิงค์ข้อมูลทั้งหมดพร้อมกันทั้ง 2 แผ่นงาน
      case 'SYNC_ALL':
        const leavesRes = handleSyncAllLeaves(ss, payload.leaves || []);
        const empRes = handleSyncAllEmployees(ss, payload.employees || []);
        result = {
          success: true,
          message: 'ซิงค์ข้อมูลทั้งหมดไปยัง Google Sheets สำเร็จเรียบร้อย',
          leavesCount: leavesRes.count,
          employeesCount: empRes.count,
          timestamp: getBangkokTimestamp()
        };
        break;

      default:
        result = { success: false, error: 'ไม่รู้จัก Action: ' + action };
    }

    return createJsonResponse(result);

  } catch (err) {
    return createJsonResponse({
      success: false,
      error: err.toString(),
      stack: err.stack
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * ฟังก์ชันสำหรับรับ HTTP GET (เช็คสถานะ Webhook)
 */
function doGet(e) {
  return createJsonResponse({
    status: 'ACTIVE',
    service: 'Leave Management Google Sheets Webhook',
    time: getBangkokTimestamp(),
    instructions: 'Webhook พร้อมรับข้อมูลผ่าน HTTP POST'
  });
}

// ============================================================================
// ฟังก์ชันจัดการข้อมูล (Handlers)
// ============================================================================

/**
 * บันทึกคำขอลางานใหม่ (เพิ่มแถวใหม่)
 */
function handleCreateLeave(ss, data) {
  if (!data || !data.id) {
    return { success: false, error: 'ข้อมูลคำขอลางานไม่ครบถ้วน' };
  }

  const sheet = ensureSheetWithHeaders(ss, SHEET_LEAVES, LEAVE_HEADERS, '#1E3A8A');
  const now = getBangkokTimestamp();

  // ตรวจสอบว่ามี Request ID นี้อยู่แล้วหรือไม่ ถ้ามีให้อัปเดตแทน
  const existingRow = findRowIndexByColumnValue(sheet, 1, data.id.toString());
  const rowValues = [
    data.id.toString(),
    data.employee_id || '',
    data.employee_name || '',
    data.department || '',
    formatShiftText(data.shift),
    formatLeaveTypeText(data.leave_type),
    data.duration_type === 'HOURLY' ? 'ลารายชั่วโมง' : 'ลาเต็มวัน',
    data.start_date || '',
    data.end_date || data.start_date || '',
    data.days_count !== undefined ? data.days_count : 1,
    data.start_time || '-',
    data.end_time || '-',
    data.hours_count !== undefined && data.hours_count !== null ? data.hours_count : '-',
    data.reason || '-',
    formatStatusText(data.status || 'PENDING'),
    data.reviewer_name || data.reviewed_by || '-',
    data.reviewed_at ? formatDateTime(data.reviewed_at) : '-',
    data.rejection_reason || '-',
    data.created_at ? formatDateTime(data.created_at) : now,
    now
  ];

  if (existingRow > 0) {
    sheet.getRange(existingRow, 1, 1, rowValues.length).setValues([rowValues]);
    formatStatusCell(sheet.getRange(existingRow, 15), data.status || 'PENDING');
    return { success: true, message: 'อัปเดตคำขอลางานเดิมสำเร็จ', id: data.id, row: existingRow };
  } else {
    sheet.appendRow(rowValues);
    const newRow = sheet.getLastRow();
    formatStatusCell(sheet.getRange(newRow, 15), data.status || 'PENDING');
    styleDataRow(sheet, newRow, LEAVE_HEADERS.length);
    return { success: true, message: 'บันทึกคำขอลางานใหม่สำเร็จ', id: data.id, row: newRow };
  }
}

/**
 * อัปเดตสถานะคำขอลางานเดิม
 */
function handleUpdateLeaveStatus(ss, data) {
  if (!data || !data.id) {
    return { success: false, error: 'กรุณาระบุรหัสคำขอ (Request ID)' };
  }

  const sheet = ensureSheetWithHeaders(ss, SHEET_LEAVES, LEAVE_HEADERS, '#1E3A8A');
  const rowIndex = findRowIndexByColumnValue(sheet, 1, data.id.toString());

  if (rowIndex === -1) {
    // ถ้ายังไม่มีแถวเดิม ให้สร้างใหม่เลย
    return handleCreateLeave(ss, data);
  }

  const now = getBangkokTimestamp();
  const statusText = formatStatusText(data.status);

  // คอลัมน์: 15=สถานะ, 16=ผู้พิจารณา, 17=วันที่พิจารณา, 18=เหตุผลที่ไม่อนุมัติ, 20=อัปเดตล่าสุด
  if (data.status) {
    const statusCell = sheet.getRange(rowIndex, 15);
    statusCell.setValue(statusText);
    formatStatusCell(statusCell, data.status);
  }
  if (data.reviewer_name || data.reviewed_by) {
    sheet.getRange(rowIndex, 16).setValue(data.reviewer_name || data.reviewed_by);
  }
  if (data.reviewed_at) {
    sheet.getRange(rowIndex, 17).setValue(formatDateTime(data.reviewed_at));
  } else if (data.status && data.status !== 'PENDING') {
    sheet.getRange(rowIndex, 17).setValue(now);
  }
  if (data.rejection_reason !== undefined) {
    sheet.getRange(rowIndex, 18).setValue(data.rejection_reason || '-');
  }
  sheet.getRange(rowIndex, 20).setValue(now);

  return {
    success: true,
    message: 'อัปเดตสถานะคำขอเรียบร้อยแล้ว',
    id: data.id,
    row: rowIndex,
    status: data.status
  };
}

/**
 * เพิ่มหรืออัปเดตข้อมูลพนักงาน (Upsert)
 */
function handleUpsertEmployee(ss, data) {
  if (!data || !data.id) {
    return { success: false, error: 'กรุณาระบุรหัสพนักงาน (Employee ID)' };
  }

  const sheet = ensureSheetWithHeaders(ss, SHEET_EMPLOYEES, EMPLOYEE_HEADERS, '#065F46');
  const now = getBangkokTimestamp();

  const cleanId = data.id.toString().trim().toUpperCase();
  const existingRow = findRowIndexByColumnValue(sheet, 1, cleanId);

  const rowValues = [
    cleanId,
    data.name || '',
    data.department || '',
    formatShiftText(data.shift),
    data.role || 'EMPLOYEE',
    data.pin !== undefined ? `'${data.pin}` : '', // ใส่ single quote ป้องกัน Google Sheets แปลงตัวเลข 0 นำหน้าหาย
    data.vacation_quota !== undefined ? data.vacation_quota : 6,
    data.personal_quota !== undefined ? data.personal_quota : 6,
    data.sick_quota !== undefined ? data.sick_quota : 30,
    data.unpaid_quota !== undefined ? data.unpaid_quota : 30,
    data.created_at ? formatDateTime(data.created_at) : now,
    now
  ];

  if (existingRow > 0) {
    sheet.getRange(existingRow, 1, 1, rowValues.length).setValues([rowValues]);
    return { success: true, message: 'อัปเดตข้อมูลพนักงานสำเร็จ', id: cleanId, row: existingRow };
  } else {
    sheet.appendRow(rowValues);
    const newRow = sheet.getLastRow();
    styleDataRow(sheet, newRow, EMPLOYEE_HEADERS.length);
    return { success: true, message: 'เพิ่มพนักงานใหม่สำเร็จ', id: cleanId, row: newRow };
  }
}

/**
 * ซิงค์คำขอลางานทั้งหมด (ล้างแถวเก่าแล้วเขียนใหม่ในครั้งเดียว - รวดเร็วมาก)
 */
function handleSyncAllLeaves(ss, rows) {
  const sheet = ensureSheetWithHeaders(ss, SHEET_LEAVES, LEAVE_HEADERS, '#1E3A8A');
  const now = getBangkokTimestamp();

  // ลบแถวเก่าทั้งหมดตั้งแต่แถวที่ 2 เป็นต้นไป
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
  }

  if (!rows || rows.length === 0) {
    return { success: true, count: 0, message: 'ไม่มีข้อมูลคำขอลางาน' };
  }

  const dataValues = rows.map(r => [
    (r.id || '').toString(),
    r.employee_id || '',
    r.employee_name || '',
    r.department || '',
    formatShiftText(r.shift),
    formatLeaveTypeText(r.leave_type),
    r.duration_type === 'HOURLY' ? 'ลารายชั่วโมง' : 'ลาเต็มวัน',
    r.start_date || '',
    r.end_date || r.start_date || '',
    r.days_count !== undefined ? r.days_count : 1,
    r.start_time || '-',
    r.end_time || '-',
    r.hours_count !== undefined && r.hours_count !== null ? r.hours_count : '-',
    r.reason || '-',
    formatStatusText(r.status || 'PENDING'),
    r.reviewer_name || r.reviewed_by || '-',
    r.reviewed_at ? formatDateTime(r.reviewed_at) : '-',
    r.rejection_reason || '-',
    r.created_at ? formatDateTime(r.created_at) : now,
    now
  ]);

  sheet.getRange(2, 1, dataValues.length, LEAVE_HEADERS.length).setValues(dataValues);

  // จัดรูปแบบสีสถานะสำหรับทุกแถว
  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    formatStatusCell(sheet.getRange(rowNum, 15), rows[i].status || 'PENDING');
    styleDataRow(sheet, rowNum, LEAVE_HEADERS.length);
  }

  sheet.autoResizeColumns(1, LEAVE_HEADERS.length);

  return {
    success: true,
    count: rows.length,
    message: `ซิงค์คำขอลางานสำเร็จทั้งหมด ${rows.length} รายการ`
  };
}

/**
 * ซิงค์รายชื่อพนักงานทั้งหมด (ล้างแถวเก่าแล้วเขียนใหม่ในครั้งเดียว)
 */
function handleSyncAllEmployees(ss, rows) {
  const sheet = ensureSheetWithHeaders(ss, SHEET_EMPLOYEES, EMPLOYEE_HEADERS, '#065F46');
  const now = getBangkokTimestamp();

  // ลบแถวเก่าทั้งหมดตั้งแต่แถวที่ 2 เป็นต้นไป
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
  }

  if (!rows || rows.length === 0) {
    return { success: true, count: 0, message: 'ไม่มีข้อมูลพนักงาน' };
  }

  const dataValues = rows.map(r => [
    (r.id || '').toString().toUpperCase(),
    r.name || '',
    r.department || '',
    formatShiftText(r.shift),
    r.role || 'EMPLOYEE',
    r.pin !== undefined ? `'${r.pin}` : '',
    r.vacation_quota !== undefined ? r.vacation_quota : 6,
    r.personal_quota !== undefined ? r.personal_quota : 6,
    r.sick_quota !== undefined ? r.sick_quota : 30,
    r.unpaid_quota !== undefined ? r.unpaid_quota : 30,
    r.created_at ? formatDateTime(r.created_at) : now,
    now
  ]);

  sheet.getRange(2, 1, dataValues.length, EMPLOYEE_HEADERS.length).setValues(dataValues);

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    styleDataRow(sheet, rowNum, EMPLOYEE_HEADERS.length);
  }

  sheet.autoResizeColumns(1, EMPLOYEE_HEADERS.length);

  return {
    success: true,
    count: rows.length,
    message: `ซิงค์รายชื่อพนักงานสำเร็จทั้งหมด ${rows.length} คน`
  };
}

// ============================================================================
// ฟังก์ชันตัวช่วย (Helper Utilities)
// ============================================================================

/**
 * ตรวจสอบแผ่นงาน ถ้ายังไม่มีให้สร้างพร้อมจัดรูปแบบส่วนหัว (Header)
 */
function ensureSheetWithHeaders(ss, sheetName, headers, headerColor) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  // ถ้ายังไม่มีส่วนหัว ให้ใส่ส่วนหัวและตกแต่ง
  const lastRow = sheet.getLastRow();
  if (lastRow === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground(headerColor || '#1E3A8A');
    headerRange.setFontColor('#FFFFFF');
    headerRange.setFontWeight('bold');
    headerRange.setFontSize(10);
    headerRange.setHorizontalAlignment('center');
    headerRange.setVerticalAlignment('middle');
    headerRange.setWrap(true);
    sheet.setRowHeight(1, 36);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, headers.length);
  }

  return sheet;
}

/**
 * ค้นหาหมายเลขแถวตามค่าในคอลัมน์ที่ระบุ
 */
function findRowIndexByColumnValue(sheet, colIndex, targetValue) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;

  const values = sheet.getRange(2, colIndex, lastRow - 1, 1).getValues();
  const searchVal = targetValue.toString().trim().toUpperCase();

  for (let i = 0; i < values.length; i++) {
    if (values[i][0] && values[i][0].toString().trim().toUpperCase() === searchVal) {
      return i + 2; // +2 เพราะเริ่มจาก row 2
    }
  }
  return -1;
}

/**
 * จัดรูปแบบแถวข้อมูล (เส้นตาราง, ฟอนต์, ความสูง)
 */
function styleDataRow(sheet, rowNum, numCols) {
  const range = sheet.getRange(rowNum, 1, 1, numCols);
  range.setFontSize(9);
  range.setVerticalAlignment('middle');
  range.setBorder(true, true, true, true, true, true, '#E5E7EB', SpreadsheetApp.BorderStyle.SOLID);
  sheet.setRowHeight(rowNum, 28);
}

/**
 * ปรับสีพื้นหลังของช่องสถานะ (Status Badge Color)
 */
function formatStatusCell(cell, status) {
  const s = (status || '').toString().toUpperCase();
  cell.setFontWeight('bold');
  cell.setHorizontalAlignment('center');

  if (s === 'APPROVED' || s.includes('อนุมัติแล้ว')) {
    cell.setBackground('#D1FAE5'); // Light green
    cell.setFontColor('#065F46'); // Dark green
  } else if (s === 'REJECTED' || s.includes('ไม่อนุมัติ')) {
    cell.setBackground('#FEE2E2'); // Light red
    cell.setFontColor('#991B1B'); // Dark red
  } else if (s === 'CANCELLED' || s.includes('ยกเลิก')) {
    cell.setBackground('#F3F4F6'); // Light gray
    cell.setFontColor('#4B5563'); // Dark gray
  } else {
    // PENDING หรือ รออนุมัติ
    cell.setBackground('#FEF3C7'); // Light amber/yellow
    cell.setFontColor('#92400E'); // Dark amber
  }
}

/**
 * แปลงประเภทการลาเป็นข้อความภาษาไทย
 */
function formatLeaveTypeText(type) {
  if (!type) return 'ลาพักร้อน';
  const t = type.toString().toLowerCase();
  if (t.includes('vacation') || t.includes('พักร้อน')) return '🏖️ ลาพักร้อน';
  if (t.includes('personal') || t.includes('กิจ')) return '💼 ลากิจ';
  if (t.includes('sick') || t.includes('ป่วย')) return '🏥 ลาป่วย';
  if (t.includes('unpaid') || t.includes('ไม่รับค่าจ้าง')) return '📋 ลาไม่รับค่าจ้าง';
  return type;
}

/**
 * แปลงกะการทำงานเป็นข้อความภาษาไทย
 */
function formatShiftText(shift) {
  if (!shift) return 'กะ A';
  const s = shift.toString().trim().toUpperCase();
  if (s === 'B' || s.includes('B')) return '🅱️ กะ B';
  if (s === 'MORNING' || s.includes('เช้า')) return '🌅 เช้าตลอด';
  return '🅰️ กะ A';
}

/**
 * แปลงสถานะเป็นข้อความภาษาไทย
 */
function formatStatusText(status) {
  if (!status) return '⏳ รออนุมัติ';
  const s = status.toString().toUpperCase();
  if (s === 'APPROVED') return '✓ อนุมัติแล้ว';
  if (s === 'REJECTED') return '✕ ไม่อนุมัติ';
  if (s === 'CANCELLED') return '🚫 ยกเลิกแล้ว';
  return '⏳ รออนุมัติ';
}

/**
 * แปลงวันที่เวลาเป็นรูปแบบอ่านง่ายในเขตเวลา Asia/Bangkok
 */
function formatDateTime(dateStr) {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
  } catch (e) {
    return dateStr;
  }
}

/**
 * รับเวลาปัจจุบันในเขตเวลาไทย Asia/Bangkok
 */
function getBangkokTimestamp() {
  return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
}

/**
 * สร้าง JSON Response
 */
function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
