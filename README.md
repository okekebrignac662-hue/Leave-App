# 🏖️ Department Leave Management Web Application
ระบบบริหารจัดการการลางานออนไลน์สำหรับแผนก (Department Leave Management App)

---

## 📌 คุณสมบัติเด่นของระบบ (Features)
1. **ระบบล็อกอินตามบทบาท (Role-based Authentication)**:
   - รหัสขึ้นต้นด้วย `EMP` เข้าสู่หน้า **พนักงาน (Employee)**
   - รหัสขึ้นต้นด้วย `SUP` เข้าสู่หน้า **หัวหน้างาน (Supervisor)** ได้สิทธิ์ตรวจอนุมัติโดยอัตโนมัติ
2. **ระบบตรวจสอบโควตาและข้อจำกัดแบบเรียลไทม์ (Daily Quota Protection)**:
   - คำนวณโควตาคงเหลือรายบุคคล (ลาพักร้อน, ลากิจ, ลาป่วย)
   - **บล็อกการขอลาทันทีหากโควตารายวันของแผนกเต็ม** (อ้างอิงตาม `Quota_Settings` เช่น แผนก Assembly ลาได้พร้อมกันไม่เกิน 2 คน/วัน)
   - **ข้อยกเว้นพิเศษ:** **ลาป่วย (Sick Leave)** สามารถส่งคำขอได้เสมอแม้โควตาแผนกจะเต็ม
3. **ระบบอนุมัติสำหรับหัวหน้างาน (Supervisor Approval Workflow)**:
   - แสดงรายการคำขอที่รอการอนุมัติ (Pending) แบบเรียลไทม์
   - กด **Approve (อนุมัติ)** หรือ **Reject (ไม่อนุมัติ)** ได้ในคลิกเดียว
4. **พร้อมใช้งานบนคลาวด์ฟรี 100%**:
   - Backend: Node.js (Express) รองรับ Render.com Free Tier
   - Database: PostgreSQL รองรับ Supabase หรือ Neon Free Tier

---

## 🗄️ โครงสร้างฐานข้อมูล (Database Schema)

ไฟล์ SQL อยู่ที่ [`schema.sql`](schema.sql) ประกอบด้วย 3 ตารางหลัก:
- `employees`: เก็บข้อมูลพนักงาน, แผนก, รหัสผ่าน PIN, บทบาท และโควตาวันลา
- `quota_settings`: กำหนดจำนวนพนักงานที่อนุญาตให้ลางานพร้อมกันได้สูงสุดต่อวันในแต่ละแผนก (`max_daily_leaves`)
- `leave_requests`: บันทึกประวัติคำขอลางาน, วันที่เริ่ม-สิ้นสุด, จำนวนวัน, เหตุผล, สถานะ (`PENDING`, `APPROVED`, `REJECTED`) และผู้พิจารณา

---

## 🚀 วิธีเปิดใช้งานบนเครื่องของคุณ (Local Development)

### 1. ติดตั้ง Dependencies
```bash
npm install
```

### 2. ตั้งค่าการเชื่อมต่อฐานข้อมูล
คัดลอกไฟล์ `.env.example` เป็น `.env`:
```bash
copy .env.example .env
```
ใส่ URL ฐานข้อมูล PostgreSQL ของคุณลงในช่อง `DATABASE_URL` เช่น:
```env
DATABASE_URL=postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres?sslmode=require
```

### 3. รันสคริปต์สร้างตาราง (Init Database)
```bash
npm run init-db
```

### 4. รันเซิร์ฟเวอร์
```bash
npm start
```
เปิดบราวเซอร์ที่: `http://localhost:3000`

---

# 🌐 คู่มือการ Deploy ขึ้นระบบออนไลน์แบบฟรี 100% (Free Cloud Deployment)

คุณสามารถนำโปรเจกต์นี้ขึ้นออนไลน์ให้ทุกคนใช้งานได้ฟรีผ่าน **Supabase (ฐานข้อมูล PostgreSQL ฟรี)** และ **Render.com (เซิร์ฟเวอร์ Node.js ฟรี)**

---

### ขั้นตอนที่ 1: สร้างฐานข้อมูล PostgreSQL ฟรีบน Supabase

1. ไปที่เว็บไซต์ **[supabase.com](https://supabase.com)** แล้วสมัคร/ล็อกอินบัญชี
2. คลิก **"New project"**
   - **Name:** `leave-management-db`
   - **Database Password:** ตั้งรหัสผ่านที่ปลอดภัย (⚠️ **จำรหัสนี้ไว้**)
   - **Region:** เลือกใกล้ที่สุด เช่น `Singapore (ap-southeast-1)`
   - คลิก **"Create new project"** (รอประมาณ 1-2 นาทีให้ระบบสร้างฐานข้อมูลเสร็จ)
3. **รันคำสั่งสร้างตารางใน Supabase**:
   - ที่เมนูด้านซ้าย ให้คลิกที่ไอคอน **"SQL Editor"**
   - เปิดไฟล์ [`schema.sql`](schema.sql) ในโปรเจกต์นี้ แล้วคัดลอกโค้ด SQL ทั้งหมดไปวางในช่อง SQL Editor ของ Supabase
   - กดปุ่ม **"Run"** สีเขียวด้านล่างขวา
   - คุณจะเห็นตาราง `employees`, `quota_settings`, `leave_requests` พร้อมข้อมูลทดสอบถูกสร้างขึ้นทันที
4. **คัดลอก Connection String**:
   - ไปที่ **Project Settings** (ไอคอนฟันเฟืองด้านล่างซ้าย) -> **Database**
   - เลื่อนลงมาที่หัวข้อ **"Connection string"** -> เลือกแท็บ **"URI"**
   - ติ๊กถูกที่ **"Use connection pooling"** (โหมด Session หรือ Transaction สำหรับพอร์ต 5432/6543)
   - คัดลอก URL ที่ได้ โดยแทนที่ `[YOUR-PASSWORD]` ด้วยรหัสผ่านที่คุณตั้งไว้ในข้อ 2
   - ตัวอย่าง: `postgresql://postgres.xxx:mypassword@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`

---

### ขั้นตอนที่ 2: นำโค้ดขึ้น GitHub

1. สร้าง Repository ใหม่บน **[GitHub](https://github.com)** (ตั้งชื่อเช่น `leave-app`)
2. อัปโหลดโค้ดโปรเจกต์นี้ขึ้น GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial commit of Department Leave Management App"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/leave-app.git
   git push -u origin main
   ```

---

### ขั้นตอนที่ 3: Deploy ฟรีบน Render.com

1. เข้าไปที่ **[render.com](https://render.com)** แล้วเข้าสู่ระบบ (ล็อกอินด้วยบัญชี GitHub ได้เลย)
2. ในหน้า Dashboard คลิกปุ่ม **"New +"** -> เลือก **"Web Service"**
3. เลือกเชื่อมต่อกับ Repository GitHub ของคุณที่เพิ่งสร้างในขั้นตอนที่ 2
4. กรอกข้อมูลการตั้งค่า:
   - **Name:** `department-leave-app` (หรือชื่อที่คุณต้องการ)
   - **Language:** `Node`
   - **Branch:** `main`
   - **Region:** `Singapore` (แนะนำให้เลือกภูมิภาคเดียวกับ Supabase เพื่อความเร็วสูงสุด)
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
5. **ตั้งค่า Environment Variable**:
   - เลื่อนลงมาที่หัวข้อ **"Environment Variables"**
   - คลิก **"Add Environment Variable"**:
     - Key: `DATABASE_URL`
     - Value: วาง Connection String จาก Supabase ที่เตรียมไว้ในขั้นตอนที่ 1
   - เพิ่มอีก 1 ค่า:
     - Key: `NODE_ENV`
     - Value: `production`
6. คลิก **"Create Web Service"** ด้านล่างสุด
7. รอ Render ทำการ Build และ Deploy ประมาณ 1-2 นาที เมื่อสถานะขึ้นเป็น **"Live"** คุณจะได้ลิงก์เว็บไซต์แบบ HTTPS ใช้งานได้ทันที เช่น:
   `https://department-leave-app.onrender.com`

---

## 🧪 บัญชีสำหรับทดสอบระบบ (Demo Accounts)

| รหัสพนักงาน (ID) | PIN | แผนก | สิทธิ์ (Role) | โควตาพักร้อนคงเหลือ |
|---|---|---|---|---|
| `EMP-001` | `1234` | Assembly | พนักงาน (Employee) | 6 วัน |
| `EMP-002` | `1234` | Assembly | พนักงาน (Employee) | 6 วัน |
| `EMP-003` | `1234` | QC | พนักงาน (Employee) | 6 วัน |
| `SUP-001` | `1234` | Assembly | หัวหน้างาน (Supervisor) | 10 วัน (มีสิทธิ์อนุมัติ) |
| `SUP-002` | `1234` | QC | หัวหน้างาน (Supervisor) | 10 วัน (มีสิทธิ์อนุมัติ) |

> 💡 **ทดสอบข้อจำกัดโควตาแผนก (Daily Quota Rule):**
> แผนก `Assembly` กำหนดโควตาลาได้สูงสุด 2 คน/วัน (`max_daily_leaves = 2`).
> หากมีคำขอลาพักร้อน/ลากิจในวันเดียวกันครบ 2 คนแล้ว เมื่อคนที่ 3 ยื่นขอลาพักร้อน ระบบจะแจ้งเตือนบล็อกทันที แต่หากเลือกยื่นเป็น **ลาป่วย (Sick Leave)** ระบบจะอนุญาตให้ส่งคำขอได้ตามเงื่อนไข
