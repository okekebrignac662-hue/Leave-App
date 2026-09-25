const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

process.env.PORT = 3444;
const app = require('../src/server');
const BASE_URL = 'http://localhost:3444';

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${urlPath}`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body
        });
      });
    }).on('error', reject);
  });
}

async function runPwaTests() {
  console.log('\n📱 Starting PWA (Progressive Web App) Verification Tests...\n');

  // 1. Verify manifest.json
  console.log('1️⃣  Testing GET /manifest.json...');
  const manifestRes = await get('/manifest.json');
  assert.strictEqual(manifestRes.status, 200, 'manifest.json must return 200 OK');
  assert(
    manifestRes.headers['content-type'] && manifestRes.headers['content-type'].includes('json'),
    'manifest.json must have JSON Content-Type'
  );
  const manifest = JSON.parse(manifestRes.body);
  assert(manifest.name && manifest.name.includes('Leave App'), 'manifest.name must exist');
  assert(manifest.short_name, 'manifest.short_name must exist');
  assert.strictEqual(manifest.display, 'standalone', 'display must be standalone');
  assert.strictEqual(manifest.start_url, '/', 'start_url must be /');
  assert(Array.isArray(manifest.icons) && manifest.icons.length >= 3, 'Must define multiple icons');
  console.log('✅ [PASS] manifest.json is valid and correctly configured');

  // 2. Verify sw.js (Service Worker)
  console.log('2️⃣  Testing GET /sw.js...');
  const swRes = await get('/sw.js');
  assert.strictEqual(swRes.status, 200, 'sw.js must return 200 OK');
  assert(
    swRes.headers['content-type'] && swRes.headers['content-type'].includes('javascript'),
    'sw.js must have Javascript Content-Type'
  );
  assert.strictEqual(
    swRes.headers['service-worker-allowed'],
    '/',
    'sw.js must have Service-Worker-Allowed: / header'
  );
  assert(swRes.body.includes('addEventListener(\'install\''), 'sw.js must handle install event');
  assert(swRes.body.includes('addEventListener(\'fetch\''), 'sw.js must handle fetch event');
  console.log('✅ [PASS] sw.js serves with proper Service-Worker-Allowed and caching logic');

  // 3. Verify App Icons
  console.log('3️⃣  Testing App Icons (PNG & SVG)...');
  const icon192Res = await get('/icons/icon-192.png');
  assert.strictEqual(icon192Res.status, 200, 'icon-192.png must exist');
  assert(icon192Res.headers['content-type'].includes('image'), 'icon-192.png must be image');

  const icon512Res = await get('/icons/icon-512.png');
  assert.strictEqual(icon512Res.status, 200, 'icon-512.png must exist');

  const iconSvgRes = await get('/icons/icon.svg');
  assert.strictEqual(iconSvgRes.status, 200, 'icon.svg must exist');
  assert(iconSvgRes.body.includes('<svg'), 'icon.svg must contain valid SVG markup');

  const appleIconRes = await get('/icons/apple-touch-icon.png');
  assert.strictEqual(appleIconRes.status, 200, 'apple-touch-icon.png must exist');
  console.log('✅ [PASS] All PWA icons (192, 512, SVG, Apple touch icon) load properly');

  // 4. Verify index.html PWA tags
  console.log('4️⃣  Testing PWA Integration inside public/index.html...');
  const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert(htmlContent.includes('rel="manifest"'), 'index.html must link to manifest.json');
  assert(htmlContent.includes('name="theme-color"'), 'index.html must specify theme-color');
  assert(htmlContent.includes('apple-mobile-web-app-capable'), 'index.html must specify iOS web-app-capable');
  assert(htmlContent.includes('navigator.serviceWorker.register'), 'index.html must register service worker');
  assert(htmlContent.includes('beforeinstallprompt'), 'index.html must listen to beforeinstallprompt');
  assert(htmlContent.includes('pwa-floating-banner'), 'index.html must contain PWA install banner');
  assert(htmlContent.includes('ios-install-modal'), 'index.html must contain iOS install instructions modal');
  console.log('✅ [PASS] index.html includes all required PWA meta tags, banners, and handlers');

  console.log('\n🎉 ALL PWA (PROGRESSIVE WEB APP) TESTS PASSED 100%!\n');
  process.exit(0);
}

runPwaTests().catch((err) => {
  console.error('❌ PWA Test failed:', err);
  process.exit(1);
});
