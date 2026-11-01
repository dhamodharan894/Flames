-- Migration: 003_task_compliance_and_hourly_reports.sql
-- 1. Tasks Table: Add SLA, Viewed Tracking & Completion Status
ALTER TABLE tasks 
ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMP WITH TIME ZONE NULL,
ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP WITH TIME ZONE NULL,
ADD COLUMN IF NOT EXISTS sla_penalty_applied BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS completion_status VARCHAR(30) DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_tasks_unseen_sla 
ON tasks (status, viewed_at, sla_penalty_applied, created_at);

-- 2. Attendance Table: Add Penalty Tracking & Admin Lock
ALTER TABLE attendance 
ADD COLUMN IF NOT EXISTS penalty_status VARCHAR(50) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS is_admin_locked BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS penalty_applied_at TIMESTAMP WITH TIME ZONE NULL,
ADD COLUMN IF NOT EXISTS penalty_reason TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS last_hourly_report_at TIMESTAMP WITH TIME ZONE NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_penalty 
ON attendance (user_id, date, penalty_status, is_admin_locked);

-- 3. Hourly Reports Table: Track continuous employee updates during active work hours
CREATE TABLE IF NOT EXISTS hourly_reports (
  id VARCHAR(64) PRIMARY KEY,
  company_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id VARCHAR(64) REFERENCES tasks(id) ON DELETE SET NULL,
  report_hour INTEGER NOT NULL DEFAULT 1,
  report_date DATE NOT NULL DEFAULT CURRENT_DATE,
  summary TEXT NOT NULL,
  challenges TEXT DEFAULT '',
  next_hour_plan TEXT DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hourly_reports_user_date 
ON hourly_reports (user_id, report_date, created_at DESC);

