const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PORT = 3777;
process.env.PORT = PORT;

const app = require('../src/server');
const { pool } = require('../src/db');
const googleSheetsService = require('../src/googleSheetsService');

function request(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, data: body });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(typeof data === 'string' ? data : JSON.stringify(data));
    req.end();
  });
}

// 1x1 transparent PNG in base64
const SAMPLE_PNG_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Sample tiny PDF in base64
const SAMPLE_PDF_BASE64 = 'data:application/pdf;base64,JVBERi0xLjQKJcOkw7zDtsOfCjEgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovS2lkcyBbMyAwIFJdCi9Db3VudCAxCj4+CmVuZG9iagozIDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9QYXJlbnQgMiAwIFIKL01lZGlhQm94IFswIDAgMTAwIDEwMF0KPj4KZW5kb2JqCnhyZWYKMCA0CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDYwIDAwMDAwIG4gCjAwMDAwMDAxMTEgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA0Ci9Sb290IDEgMCBSCj4+CnN0YXJ0eHJlZgoxNzEKJSVFT0YK';

async function runAttachmentTests() {
  console.log('\n📎 Starting Attachment & Medical Certificate Verification Tests...\n');
  let passed = 0;
  let total = 0;
  const createdFiles = [];

  async function test(name, fn) {
    total++;
    try {
      await fn();
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ [FAIL] ${name}:`, err.message);
    }
  }

  // Cleanup past test data
  if (pool) {
    await pool.query("DELETE FROM leave_requests WHERE start_date >= '2029-01-01'").catch(() => {});
  }

  // 1. Direct Attachment Upload API (PNG)
  await test('POST /api/upload-attachment saves Base64 PNG image into public/uploads/', async () => {
    const res = await request(
      { hostname: 'localhost', port: PORT, path: '/api/upload-attachment', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { dataUrl: SAMPLE_PNG_BASE64, prefix: 'test-cert' }
    );

    assert.strictEqual(res.status, 200, 'Status should be 200');
    assert.strictEqual(res.data.success, true, 'success should be true');
    assert(res.data.url && res.data.url.startsWith('/uploads/test-cert-'), 'URL must start with /uploads/test-cert-');
    assert(res.data.url.endsWith('.png'), 'URL must end with .png');

    // Check physical file on disk
    const diskPath = path.join(__dirname, '..', 'public', res.data.url.replace(/^\//, ''));
    assert(fs.existsSync(diskPath), 'Saved file must exist on disk in public/uploads/');
    const fileStat = fs.statSync(diskPath);
    assert(fileStat.size > 0, 'Saved file must not be empty');
    createdFiles.push(diskPath);
  });

  // 2. Direct Attachment Upload API (PDF)
  await test('POST /api/upload-attachment handles PDF documents', async () => {
    const res = await request(
      { hostname: 'localhost', port: PORT, path: '/api/upload-attachment', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { dataUrl: SAMPLE_PDF_BASE64, prefix: 'test-doc' }
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert(res.data.url.endsWith('.pdf'), 'URL must end with .pdf');

    const diskPath = path.join(__dirname, '..', 'public', res.data.url.replace(/^\//, ''));
    assert(fs.existsSync(diskPath), 'PDF file must exist on disk');
    createdFiles.push(diskPath);
  });

  // 3. Static serving of uploaded attachments
  await test('GET /uploads/... serves uploaded files with correct HTTP 200 status', async () => {
    const uploadRes = await request(
      { hostname: 'localhost', port: PORT, path: '/api/upload-attachment', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { dataUrl: SAMPLE_PNG_BASE64, prefix: 'static-test' }
    );

    const uploadedUrl = uploadRes.data.url;
    const staticRes = await request(
      { hostname: 'localhost', port: PORT, path: uploadedUrl, method: 'GET' }
    );
    assert.strictEqual(staticRes.status, 200, 'Static GET on uploaded file must return 200 OK');

    const diskPath = path.join(__dirname, '..', 'public', uploadedUrl.replace(/^\//, ''));
    createdFiles.push(diskPath);
  });

  // 4. Submit Leave Request with Base64 Medical Certificate Attachment
  let createdRequestId = null;
  let attachedFileUrl = null;

  await test('POST /api/leave-requests with attachmentUrl saves file and stores attachment_url', async () => {
    const leavePayload = {
      employeeId: 'EMP-001',
      leaveType: 'Sick',
      startDate: '2029-03-01',
      endDate: '2029-03-03',
      durationType: 'FULL_DAY',
      reason: 'มีอาการไข้สูง แนบใบรับรองแพทย์จากโรงพยาบาล',
      attachmentUrl: SAMPLE_PNG_BASE64
    };

    const res = await request(
      { hostname: 'localhost', port: PORT, path: '/api/leave-requests', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      leavePayload
    );

    assert.strictEqual(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.data)}`);
    assert.strictEqual(res.data.success, true);
    const reqData = res.data.request;
    assert(reqData, 'Returned leave request object must exist');
    assert(reqData.attachment_url.startsWith('/uploads/'), 'attachment_url must point to /uploads/');

    createdRequestId = reqData.id;
    attachedFileUrl = reqData.attachment_url;

    const diskPath = path.join(__dirname, '..', 'public', attachedFileUrl.replace(/^\//, ''));
    if (fs.existsSync(diskPath)) createdFiles.push(diskPath);
  });

  // 5. Query leave requests returns attachment_url
  await test('GET /api/leave-requests returns attachment_url for requests with attachments', async () => {
    const res = await request(
      { hostname: 'localhost', port: PORT, path: '/api/leave-requests?role=SUPERVISOR', method: 'GET' }
    );

    assert.strictEqual(res.status, 200);
    assert(Array.isArray(res.data.requests), 'Must return array of requests');
    
    if (createdRequestId) {
      const match = res.data.requests.find(r => r.id === createdRequestId);
      assert(match, 'Created request should be found');
      assert.strictEqual(match.attachment_url, attachedFileUrl, 'attachment_url must match saved file URL');
    }
  });

  // 6. Submit leave request without attachment
  await test('POST /api/leave-requests without attachment saves cleanly with null attachment_url', async () => {
    const leavePayload = {
      employeeId: 'EMP-001',
      leaveType: 'Personal',
      startDate: '2029-04-10',
      endDate: '2029-04-10',
      durationType: 'FULL_DAY',
      reason: 'ไปติดต่อธุระราชการ',
      attachmentUrl: null
    };

    const res = await request(
      { hostname: 'localhost', port: PORT, path: '/api/leave-requests', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      leavePayload
    );

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.request.attachment_url, null, 'attachment_url should be null');
  });

  // 7. Google Sheets payload formatting
  await test('googleSheetsService.formatLeavePayload properly maps attachment_url and attachment_display', () => {
    const payloadWithAtt = googleSheetsService.formatLeavePayload({
      id: 999,
      employee_id: 'EMP001',
      employee_name: 'สมชาย ใจดี',
      department: 'IT',
      shift: 'A',
      leave_type: 'Sick',
      start_date: '2029-03-01',
      end_date: '2029-03-03',
      days_count: 3,
      duration_type: 'FULL_DAY',
      reason: 'ป่วย',
      attachment_url: '/uploads/cert-1234.jpg'
    }, 'APPROVED');

    assert.strictEqual(payloadWithAtt.attachment_url, '/uploads/cert-1234.jpg');
    assert.strictEqual(payloadWithAtt.attachment_display, '📎 มีใบรับรองแพทย์/เอกสารแนบ');

    const payloadWithoutAtt = googleSheetsService.formatLeavePayload({
      id: 1000,
      employee_id: 'EMP001',
      leave_type: 'Vacation',
      start_date: '2029-05-01',
      end_date: '2029-05-02',
      days_count: 2,
      duration_type: 'FULL_DAY'
    });

    assert.strictEqual(payloadWithoutAtt.attachment_url, '');
    assert.strictEqual(payloadWithoutAtt.attachment_display, '-');
  });

  // 8. Frontend HTML elements and script verification
  await test('public/index.html includes all medical certificate & attachment upload UI components', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

    // UI elements
    assert(html.includes('id="sick-leave-cert-notice"'), 'Must have sick leave reminder notice banner');
    assert(html.includes('id="req-attachment-file"'), 'Must have file input for attachments');
    assert(html.includes('id="attachment-dropzone"'), 'Must have attachment dropzone UI');
    assert(html.includes('id="attachment-preview-state"'), 'Must have attachment preview container');
    assert(html.includes('id="attachment-modal"'), 'Must have attachment Lightbox modal');
    assert(html.includes('id="attachment-modal-download"'), 'Must have attachment download button');

    // JavaScript controllers
    assert(html.includes('function checkMedicalCertificateRequirement'), 'Must have checkMedicalCertificateRequirement function');
    assert(html.includes('function compressImageFile'), 'Must have client-side image compression function');
    assert(html.includes('function handleAttachmentFileSelect'), 'Must have handleAttachmentFileSelect function');
    assert(html.includes('function viewAttachment'), 'Must have viewAttachment function');
    assert(html.includes('function closeAttachmentModal'), 'Must have closeAttachmentModal function');
    assert(html.includes('function removeSelectedAttachment'), 'Must have removeSelectedAttachment function');
  });

  // 9. Schema & Apps Script verification
  await test('schema.sql and google-apps-script.js include attachment column support', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    assert(schema.includes('attachment_url TEXT'), 'schema.sql must define attachment_url TEXT');

    const gas = fs.readFileSync(path.join(__dirname, '..', 'google-apps-script.js'), 'utf8');
    assert(gas.includes('เอกสารแนบ'), 'google-apps-script.js must include เอกสารแนบ header');
  });

  // Clean up created files on disk
  for (const f of createdFiles) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (_) {}
  }

  // Clean up DB test records
  if (pool) {
    await pool.query("DELETE FROM leave_requests WHERE start_date >= '2029-01-01'").catch(() => {});
  }

  console.log(`\n🎉 Results: ${passed}/${total} Attachment & Medical Certificate tests passed!\n`);
  if (passed === total) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runAttachmentTests().catch(err => {
  console.error('❌ Attachment test suite error:', err);
  process.exit(1);
});
