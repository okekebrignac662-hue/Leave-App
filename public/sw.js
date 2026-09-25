/**
 * ============================================================================
 * Leave App - Service Worker (PWA Offline & Caching Engine)
 * ============================================================================
 */

const CACHE_NAME = 'leave-app-cache-v1.0.1';

// รายการไฟล์ที่ต้อง Pre-cache สำหรับการเปิดแอปแบบออฟไลน์
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon.svg'
];

// 1. Install Event: Cache Core Assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // ใช้ cache.addAll พร้อม catch error แต่ละไฟล์เพื่อป้องกันการ crash หากบาง asset โหลดช้า
      return Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[PWA SW] Precache failed for ${url}:`, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// 2. Activate Event: Clean up outdated caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log(`[PWA SW] Deleting obsolete cache: ${name}`);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch Event: Smart Cache Strategy
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // ข้าม non-GET requests (POST, PUT, DELETE, PATCH) ให้วิ่งตรงไปเซิร์ฟเวอร์
  if (req.method !== 'GET') {
    return;
  }

  // ข้าม chrome-extension หรือ protocol แปลกๆ
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // กลยุทธ์ที่ 1: API Endpoints (/api/) -> Network First พร้อม Fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          // ถ้าสำเร็จ บันทึกลง cache เฉพาะ GET ที่สถานะ 200
          if (networkRes.ok) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(async () => {
          // เมื่อเน็ตหลุด พยายามดึง cache เดิมมาแสดง
          const cachedRes = await caches.match(req);
          if (cachedRes) {
            return cachedRes;
          }
          // ถ้าไม่มี ให้ส่ง JSON แจ้งสถานะออฟไลน์
          return new Response(
            JSON.stringify({
              offline: true,
              error: 'คุณกำลังอยู่ในโหมดออฟไลน์ กรุณาเชื่อมต่ออินเทอร์เน็ตเพื่อทำรายการ',
              timestamp: new Date().toISOString()
            }),
            {
              status: 503,
              headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }
          );
        })
    );
    return;
  }

  // กลยุทธ์ที่ 2: Static Files & HTML Pages -> Stale-While-Revalidate
  // ดึงจาก Cache มาแสดงทันทีเพื่อความเร็วระดับเสี้ยววินาที แล้วแอบอัปเดตจาก Network ในพื้นหลัง
  event.respondWith(
    caches.match(req).then((cachedRes) => {
      const fetchPromise = fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => {
          // หาก fetch ล้มเหลวและเป็น Navigation (เข้าเว็บ) ให้ส่ง /index.html จาก Cache
          if (req.mode === 'navigate') {
            return caches.match('/index.html');
          }
        });

      return cachedRes || fetchPromise;
    })
  );
});

// 4. Message Event: Handle manual refresh or cache invalidation
self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
});
