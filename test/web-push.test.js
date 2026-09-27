/**
 * test/web-push.test.js
 * Automated Test Suite for Web Push Notifications & Service Worker Integration
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

let app;
let server;
const PORT = 3993;
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

async function runTests() {
  console.log('\n📱 Starting Web Push Notifications & Service Worker Integration Tests...\n');
  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${message}`);
      process.exitCode = 1;
    }
  }

  try {
    // 1. Verify Service Worker & Frontend Assets
    console.log('1️⃣  Verifying Service Worker & Frontend UI Components...');
    const swContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf-8');
    assert(swContent.includes("addEventListener('push'"), 'sw.js contains push event listener');
    assert(swContent.includes("addEventListener('notificationclick'"), 'sw.js contains notificationclick event listener');
    assert(swContent.includes('showNotification'), 'sw.js displays notifications via registration.showNotification');

    const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
    assert(htmlContent.includes('id="push-notif-control-banner"'), 'index.html contains #push-notif-control-banner');
    assert(htmlContent.includes('id="btn-push-toggle"'), 'index.html contains #btn-push-toggle');
    assert(htmlContent.includes('id="btn-push-test"'), 'index.html contains #btn-push-test');
    assert(htmlContent.includes('checkPushNotificationSupport'), 'index.html defines checkPushNotificationSupport');
    assert(htmlContent.includes('toggleWebPushSubscription'), 'index.html defines toggleWebPushSubscription');
    assert(htmlContent.includes('sendTestPushNotification'), 'index.html defines sendTestPushNotification');

    const schemaContent = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8');
    assert(schemaContent.includes('CREATE TABLE IF NOT EXISTS push_subscriptions'), 'schema.sql contains push_subscriptions table');

    // 2. Start server
    console.log('\n2️⃣  Starting test server on port ' + PORT + '...');
    process.env.PORT = PORT;
    const googleSheetsService = require('../src/googleSheetsService');
    googleSheetsService.syncLeaveRequestAsync = () => {};
    googleSheetsService.syncEmployeeAsync = () => {};

    const serverModule = require('../src/server.js');
    app = serverModule.app || serverModule;
    server = serverModule.server;
    await new Promise((r) => setTimeout(r, 1000));

    // 3. Test GET /api/push/vapid-public-key
    console.log('\n3️⃣  Testing GET /api/push/vapid-public-key...');
    const keyRes = await makeRequest('/api/push/vapid-public-key');
    assert(keyRes.status === 200, `GET /api/push/vapid-public-key returns HTTP 200 (Got ${keyRes.status})`);
    assert(keyRes.json && keyRes.json.success === true, 'Response contains success: true');
    assert(keyRes.json && typeof keyRes.json.publicKey === 'string' && keyRes.json.publicKey.length > 20, 'Response contains valid VAPID publicKey string');

    // 4. Test POST /api/push/subscribe validation
    console.log('\n4️⃣  Testing POST /api/push/subscribe validation...');
    const invalidSubRes = await makeRequest('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { userId: 'EMP-001' } // Missing subscription
    });
    assert(invalidSubRes.status === 400, 'POST /api/push/subscribe without subscription returns 400 Bad Request');

    // 5. Test Registering Push Subscription
    console.log('\n5️⃣  Testing registering push subscription...');
    const testUserId = `EMP-PUSH-${Date.now().toString().slice(-4)}`;
    const mockEndpoint = `https://fcm.googleapis.com/fcm/send/mock-${Date.now()}`;
    const mockSub = {
      endpoint: mockEndpoint,
      keys: {
        p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
        auth: 'tBHItJI5svbpez7KI4CCXg'
      }
    };

    const subRes = await makeRequest('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        userId: testUserId,
        subscription: mockSub,
        userAgent: 'MockBrowser/1.0'
      }
    });
    assert(subRes.status === 200, 'POST /api/push/subscribe returns 200 OK');
    assert(subRes.json && subRes.json.success === true, 'Response contains success: true');

    // 6. Test POST /api/push/test
    console.log('\n6️⃣  Testing POST /api/push/test...');
    const testPushRes = await makeRequest('/api/push/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { userId: testUserId }
    });
    assert(testPushRes.status === 200, 'POST /api/push/test returns 200 OK');
    assert(testPushRes.json && testPushRes.json.success === true, 'Test push dispatch returns success: true');

    // 7. Test POST /api/push/unsubscribe
    console.log('\n7️⃣  Testing POST /api/push/unsubscribe...');
    const unsubRes = await makeRequest('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        userId: testUserId,
        endpoint: mockEndpoint
      }
    });
    assert(unsubRes.status === 200, 'POST /api/push/unsubscribe returns 200 OK');
    assert(unsubRes.json && unsubRes.json.success === true, 'Unsubscribe returns success: true');

    console.log(`\n========================================`);
    console.log(`📱 Web Push Test Results: ${passed}/${total} assertions passed.`);
    console.log(`========================================\n`);

    if (passed === total) {
      console.log('🎉 All Web Push & Service Worker tests passed perfectly!\n');
    }
  } catch (err) {
    console.error('Web push test error:', err);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.close();
    }
    process.exit(process.exitCode || 0);
  }
}

runTests();
