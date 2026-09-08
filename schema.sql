-- =======================================================
-- Online Department Leave Management Database Schema
-- Compatible with PostgreSQL, Supabase, Neon, and Render
-- =======================================================

-- 1. Create Employees Table
CREATE TABLE IF NOT EXISTS employees (
    id VARCHAR(20) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    department VARCHAR(50) NOT NULL,
    pin VARCHAR(50) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'EMPLOYEE', -- 'EMPLOYEE' or 'SUPERVISOR'
    vacation_quota INT NOT NULL DEFAULT 6,
    personal_quota INT NOT NULL DEFAULT 6,
    sick_quota INT NOT NULL DEFAULT 30,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Create Quota Settings Table (Department Daily Leave Limit)
CREATE TABLE IF NOT EXISTS quota_settings (
    id SERIAL PRIMARY KEY,
    department VARCHAR(50) NOT NULL UNIQUE,
    max_daily_leaves INT NOT NULL DEFAULT 2,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Create Leave Requests Table
CREATE TABLE IF NOT EXISTS leave_requests (
    id SERIAL PRIMARY KEY,
    employee_id VARCHAR(20) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    leave_type VARCHAR(50) NOT NULL, -- 'Vacation', 'Personal', 'Sick'
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    days_count INT NOT NULL DEFAULT 1,
    reason TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'APPROVED', 'REJECTED'
    reviewed_by VARCHAR(20) REFERENCES employees(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    rejection_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for performance when checking daily overlapping leaves
CREATE INDEX IF NOT EXISTS idx_leave_requests_dates ON leave_requests (start_date, end_date, status);
CREATE INDEX IF NOT EXISTS idx_leave_requests_employee ON leave_requests (employee_id);

-- =======================================================
-- Seed Demo Data
-- =======================================================

-- Insert or Update Employees
INSERT INTO employees (id, name, department, pin, role, vacation_quota, personal_quota, sick_quota)
VALUES
    ('EMP-001', 'สมชาย ใจดี', 'Assembly', '1234', 'EMPLOYEE', 6, 6, 30),
    ('EMP-002', 'สมหญิง รักงาน', 'Assembly', '1234', 'EMPLOYEE', 6, 6, 30),
    ('EMP-003', 'อนันต์ ตั้งใจ', 'QC', '1234', 'EMPLOYEE', 6, 6, 30),
    ('SUP-001', 'สมศักดิ์ คุมงาน (หัวหน้า)', 'Assembly', '1234', 'SUPERVISOR', 10, 6, 30),
    ('SUP-002', 'วิชัย ดูแลดี (หัวหน้า QC)', 'QC', '1234', 'SUPERVISOR', 10, 6, 30)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    department = EXCLUDED.department,
    pin = EXCLUDED.pin,
    role = EXCLUDED.role;

-- Insert or Update Quota Settings (e.g. max 2 employees per department can be on leave each day)
INSERT INTO quota_settings (department, max_daily_leaves)
VALUES
    ('Assembly', 2),
    ('QC', 1),
    ('General', 3)
ON CONFLICT (department) DO UPDATE SET
    max_daily_leaves = EXCLUDED.max_daily_leaves;

-- Insert Sample Initial Leave Requests
INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, days_count, reason, status)
VALUES
    ('EMP-001', 'Vacation', CURRENT_DATE + INTERVAL '5 days', CURRENT_DATE + INTERVAL '5 days', 1, 'พาครอบครัวไปทำธุระต่างจังหวัด', 'PENDING'),
    ('EMP-002', 'Personal', CURRENT_DATE + INTERVAL '7 days', CURRENT_DATE + INTERVAL '7 days', 1, 'ไปต่ออายุใบขับขี่', 'PENDING')
ON CONFLICT DO NOTHING;
