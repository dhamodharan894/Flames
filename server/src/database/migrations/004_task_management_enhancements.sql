-- Migration: 004_task_management_enhancements.sql
-- Enhances tasks and hourly_reports tables with exact compliance fields

-- 1. Tasks Table additions
ALTER TABLE tasks 
ADD COLUMN IF NOT EXISTS start_time TEXT NULL,
ADD COLUMN IF NOT EXISTS deadline TIMESTAMP WITH TIME ZONE NULL,
ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMP WITH TIME ZONE NULL,
ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP WITH TIME ZONE NULL,
ADD COLUMN IF NOT EXISTS sla_penalty_applied BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS completion_status VARCHAR(30) DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS last_reported_at TIMESTAMP WITH TIME ZONE NULL,
ADD COLUMN IF NOT EXISTS reminder_1h_sent_at TIMESTAMP WITH TIME ZONE NULL,
ADD COLUMN IF NOT EXISTS reminder_2h_sent_at TIMESTAMP WITH TIME ZONE NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_compliance 
ON tasks (company_id, assigned_to, status, viewed_at, sla_penalty_applied);

-- 2. Hourly Reports Table additions
ALTER TABLE hourly_reports
ADD COLUMN IF NOT EXISTS work_completed TEXT NULL,
ADD COLUMN IF NOT EXISTS progress_percentage INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS pending_work TEXT NULL,
ADD COLUMN IF NOT EXISTS issues_blockers TEXT NULL,
ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'submitted';

CREATE INDEX IF NOT EXISTS idx_hourly_reports_task_date
ON hourly_reports (task_id, report_date, created_at DESC);

-- 3. Attendance Table penalty tracking
ALTER TABLE attendance
ADD COLUMN IF NOT EXISTS penalty_status VARCHAR(50) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS is_admin_locked BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS penalty_applied_at TIMESTAMP WITH TIME ZONE NULL,
ADD COLUMN IF NOT EXISTS penalty_reason TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS penalized_by_task_id VARCHAR(64) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS last_hourly_report_at TIMESTAMP WITH TIME ZONE NULL;

