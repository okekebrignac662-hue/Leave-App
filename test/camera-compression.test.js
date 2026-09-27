/**
 * test/camera-compression.test.js
 * Automated Test Suite for Camera Snapshot & Auto-Compression System (กล้องถ่ายภาพใบรับรองแพทย์)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

let app;
const PORT = 3995;
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

// 2x2 JPEG Base64 simulating camera output
const CAMERA_SNAPSHOT_JPEG_BASE64 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAACAAIBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

async function runTests() {
  console.log('\n📸 Starting Camera Snapshot & Auto-Compression Verification Tests...\n');
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
    // 1. Static UI & DOM Verifications in public/index.html
    console.log('1️⃣  Verifying Camera Viewfinder & Form Elements in public/index.html...');
    const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    assert(html.includes('id="camera-modal"'), 'index.html contains #camera-modal');
    assert(html.includes('id="camera-video"'), 'index.html contains #camera-video stream viewer');
    assert(html.includes('id="camera-overlay-guide"'), 'index.html contains #camera-overlay-guide (document alignment box)');
    assert(html.includes('id="btn-camera-snap"'), 'index.html contains #btn-camera-snap shutter button');
    assert(html.includes('id="req-camera-fallback-file"'), 'index.html contains #req-camera-fallback-file for mobile device camera');
    assert(html.includes('capture="environment"'), 'Mobile fallback input specifies capture="environment" for rear camera');
    assert(html.includes('function openCameraModal'), 'index.html defines openCameraModal function');
    assert(html.includes('function takeCameraSnapshot'), 'index.html defines takeCameraSnapshot function');
    assert(html.includes('function confirmCameraSnapshot'), 'index.html defines confirmCameraSnapshot function');
    assert(html.includes('function compressImageFile'), 'index.html defines compressImageFile auto-compressor');

    // 2. Start Test Server
    console.log('\n2️⃣  Starting test server on port 3995...');
    process.env.PORT = PORT;
    app = require('../src/server.js');
    await new Promise((r) => setTimeout(r, 600));

    // 3. Test POST /api/upload-attachment with camera snapshot
    console.log('\n3️⃣  Testing POST /api/upload-attachment with camera JPEG snapshot...');
    const uploadRes = await makeRequest('/api/upload-attachment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        dataUrl: CAMERA_SNAPSHOT_JPEG_BASE64,
        prefix: 'camera-cert-test'
      }
    });
    assert(uploadRes.status === 200, 'POST /api/upload-attachment returns 200 OK');
    assert(uploadRes.json && uploadRes.json.success === true, 'Upload response contains success: true');
    assert(uploadRes.json && uploadRes.json.url && uploadRes.json.url.startsWith('data:image/jpeg;base64,'), 'Returned URL preserves JPEG image MIME type');

    // 4. Test Leave Request with Camera Snapshot attachment
    console.log('\n4️⃣  Submitting Leave Request with Camera Snapshot Attachment...');
    const leaveRes = await makeRequest('/api/leave-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        employeeId: 'EMP-002',
        leaveType: 'Sick',
        startDate: '2026-11-10',
        endDate: '2026-11-11',
        durationType: 'FULL_DAY',
        reason: 'ป่วยติดเชื้อ แนบใบรับรองแพทย์ถ่ายจากกล้องมือถือ',
        attachmentUrl: CAMERA_SNAPSHOT_JPEG_BASE64
      }
    });
    assert(leaveRes.status === 201, 'POST /api/leave-requests returns 201 Created');
    assert(leaveRes.json && leaveRes.json.request, 'Returns created leave request');
    assert(leaveRes.json.request.attachment_url && leaveRes.json.request.attachment_url.startsWith('data:image/jpeg;base64,'), 'Request stores camera snapshot attachment_url');
    const createdId = leaveRes.json.request.id;

    // 5. Test Supervisor Query retrieves attachment
    console.log('\n5️⃣  Verifying Supervisor retrieval of medical certificate attachment...');
    const getRes = await makeRequest(`/api/leave-requests?role=SUPERVISOR&status=PENDING`);
    assert(getRes.status === 200, 'GET /api/leave-requests returns 200 OK');
    assert(getRes.json && Array.isArray(getRes.json.requests), 'Returns requests array');
    const found = (getRes.json.requests || []).find(r => r.id === createdId);
    assert(found !== undefined, 'Found created leave request in supervisor pending list');
    assert(found && found.attachment_url && found.attachment_url.startsWith('data:image/jpeg;base64,'), 'Supervisor view contains attachment_url for instant lightbox view');

    console.log(`\n========================================`);
    console.log(`📸 Camera & Compression Test Results: ${passed}/${total} assertions passed.`);
    console.log(`========================================\n`);

    if (passed === total) {
      console.log('🎉 All Camera Snapshot & Auto-Compression tests passed perfectly!\n');
    }
  } catch (err) {
    console.error('Camera test execution error:', err);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode || 0);
  }
}

runTests();
