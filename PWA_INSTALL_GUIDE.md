# 📱 คู่มือการติดตั้งใช้งาน Leave App เป็นแอปมือถือ (PWA - Progressive Web App)

ระบบ **Leave App** ได้รับการอัปเกรดเป็น **Progressive Web App (PWA)** เต็มรูปแบบเรียบร้อยแล้ว พนักงานและหัวหน้างานสามารถติดตั้งแอปลงบนหน้าจอหลักของสมาร์ตโฟน (Home Screen) ได้ทันที **โดยไม่ต้องผ่าน App Store หรือ Google Play Store**

---

## 🌟 จุดเด่นของ PWA ในระบบ Leave App
1. **ติดตั้งง่ายในคลิกเดียว**: แตะปุ่ม "ติดตั้ง" จากบนเว็บ ไอคอนแอปจะไปปรากฏบนหน้าจอมือถือทันที
2. **เปิดเร็วระดับเสี้ยววินาที**: ด้วยเทคโนโลยี Service Worker และ Smart Caching แอปจะโหลดข้อมูลจากเครื่องทันที ไม่ต้องรอดาวน์โหลดใหม่ทุกครั้ง
3. **เปิดใช้งานได้แม้อยู่นอกสัญญาณเน็ต (Offline Resilience)**: เข้าดูประวัติและข้อมูลใบลาที่เคยโหลดไว้ได้แม้สัญญาณเน็ตหลุด พร้อมแจ้งเตือนสถานะเมื่อกลับมาออนไลน์
4. **เปิดเต็มหน้าจอ (Standalone Mode)**: ใช้งานได้แบบเต็มจอ ไม่มีแถบ URL หรือปุ่มของเบราว์เซอร์กวนใจ ให้ความรู้สึกเหมือน Native Mobile App 100%

---

## 📲 วิธีการติดตั้งบนมือถือแต่ละระบบ

### 1. สำหรับผู้ใช้ Android (Google Chrome / Brave / Edge)
1. เปิดเบราว์เซอร์ Chrome แล้วเข้าเว็บไซต์ Leave App
2. จะมีกล่องข้อความสีน้ำเงินเข้มลอยขึ้นมาด้านล่าง: **"ติดตั้ง Leave App ลงมือถือ"**
3. แตะปุ่ม **"📲 ติดตั้งทันที"** หรือแตะปุ่ม **"ติดตั้ง"** บนการ์ดหน้าเข้าสู่ระบบ
4. กดยืนยัน **"Install" (ติดตั้ง)**
5. ไอคอนแอป Leave App จะปรากฏบนหน้าจอหลักของโทรศัพท์ทันที

> **หากไม่ขึ้นแจ้งเตือนอัตโนมัติ**:  
> แตะที่จุด 3 จุด (⋮) มุมขวาบนของ Chrome $\rightarrow$ เลือก **"ติดตั้งแอป" (Install app)** หรือ **"เพิ่มลงในหน้าจอหลัก" (Add to Home screen)**

---

### 2. สำหรับผู้ใช้ iPhone / iPad (iOS Safari)
1. เปิด **Safari** แล้วเข้าเว็บไซต์ Leave App
2. แตะปุ่ม **"แชร์" (Share icon: ⎋)** ที่แถบเมนูด้านล่างของหน้าจอ
3. เลื่อนลงมาเล็กน้อยแล้วเลือก **"เพิ่มไปยังหน้าจอโฮม" (Add to Home Screen ➕)**
4. แตะปุ่ม **"เพิ่ม" (Add)** ที่มุมขวาบน
5. ไอคอนแอป Leave App จะถูกเพิ่มลงบนหน้าจอโฮมของ iPhone ทันที

---

### 3. สำหรับเครื่องคอมพิวเตอร์ (PC / Mac ผ่าน Google Chrome หรือ Microsoft Edge)
1. เปิดหน้าเว็บ Leave App บนคอมพิวเตอร์
2. จะมีไอคอนรูปจอคอมพิวเตอร์พร้อมลูกศรลง 🖥️ ปรากฏที่ด้านขวาสุดของแถบที่อยู่เว็บ (Address bar)
3. คลิกไอคอนนั้นแล้วกด **"Install"**
4. ระบบจะสร้างแอปพลิเคชัน Leave App บน Desktop และ Taskbar ให้เปิดใช้งานได้แยกเป็นหน้าต่างโปรแกรมทันที

---

## ⚙️ รายละเอียดไฟล์ทางเทคนิคของ PWA
- [`public/manifest.json`](file:///c:/Users/Toto/Desktop/Leave-App/public/manifest.json): กำหนดชื่อแอป, ธีมสี (#4f46e5), โหมด standalone, และทางลัด (App Shortcuts)
- [`public/sw.js`](file:///c:/Users/Toto/Desktop/Leave-App/public/sw.js): Service Worker ควบคุม Offline Caching, Stale-While-Revalidate และ Network-First APIs
- [`public/icons/`](file:///c:/Users/Toto/Desktop/Leave-App/public/icons/): ไอคอนแอปความละเอียดสูง (192x192 PNG, 512x512 Maskable PNG, SVG Vector, Apple Touch Icon)
- [`src/server.js`](file:///c:/Users/Toto/Desktop/Leave-App/src/server.js): กำหนด HTTP Headers สำหรับ Service Worker (`Service-Worker-Allowed: /`) และ Cache Control
