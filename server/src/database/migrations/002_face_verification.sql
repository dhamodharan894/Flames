-- ============================================================================
-- MIGRATION 002: BIOMETRIC FACE VERIFICATION & ATTENDANCE AUDIT LOGS
-- Fully idempotent and non-destructive: uses CREATE TABLE IF NOT EXISTS
-- and ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
-- Compatible with PostgreSQL 13+ on Railway.
-- ============================================================================

-- 1. EMPLOYEE FACE PROFILES
-- Stores enrolled reference embeddings (512-dim ArcFace vector) per employee.
-- Multi-tenant: scoped strictly by (company_id, user_id).
CREATE TABLE IF NOT EXISTS employee_face_profiles (
    id                         TEXT PRIMARY KEY,
    user_id                    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id                 TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    enrollment_status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                                 CHECK (enrollment_status IN ('pending', 'authorized', 'enrolled', 'revoked')),
    face_embedding             JSONB,                       -- Array of floats (ArcFace 512-dim)
    embedding_model            VARCHAR(50),                 -- e.g. 'ArcFace'
    embedding_dimension        INTEGER,                     -- e.g. 512
    enrolled_by                TEXT REFERENCES users(id) ON DELETE SET NULL,
    enrolled_at                TIMESTAMPTZ,
    reenrollment_requested_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    reenrollment_requested_at  TIMESTAMPTZ,
    reenrollment_reason        TEXT,
    last_verified_at           TIMESTAMPTZ,
    verification_attempt_count INTEGER DEFAULT 0,
    verification_fail_count    INTEGER DEFAULT 0,
    consent_recorded_at        TIMESTAMPTZ,
    scheduled_deletion_at      TIMESTAMPTZ,
    metadata                   JSONB NOT NULL DEFAULT '{}'::jsonb,
    audit_log                  JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_efp_user_company UNIQUE (user_id, company_id)
);

-- Safely add columns if pre-existing
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS enrollment_status VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS face_embedding JSONB;
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(50);
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS embedding_dimension INTEGER;
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS enrolled_by TEXT;
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS enrolled_at TIMESTAMPTZ;
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS reenrollment_requested_by TEXT;
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS reenrollment_requested_at TIMESTAMPTZ;
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS reenrollment_reason TEXT;
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS verification_attempt_count INTEGER DEFAULT 0;
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS verification_fail_count INTEGER DEFAULT 0;
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS consent_recorded_at TIMESTAMPTZ;
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS scheduled_deletion_at TIMESTAMPTZ;
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS audit_log JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE employee_face_profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_efp_user_id     ON employee_face_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_efp_company_id  ON employee_face_profiles(company_id);
CREATE INDEX IF NOT EXISTS idx_efp_status      ON employee_face_profiles(company_id, enrollment_status);


-- 2. ATTENDANCE VERIFICATION ATTEMPTS
-- Detailed audit log of every face verification attempt (verified, failed, inconclusive).
-- Tracks failure category, GPS result, face match result, and HR review states.
CREATE TABLE IF NOT EXISTS attendance_verification_attempts (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id       TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    attempted_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    work_mode        VARCHAR(20) NOT NULL DEFAULT 'office',
    status           VARCHAR(30) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'verified', 'failed', 'inconclusive')),
    failure_category VARCHAR(50),   -- 'no_face' | 'multiple_faces' | 'face_mismatch' | 'liveness_failed'
                                    -- | 'liveness_inconclusive' | 'enrollment_missing'
                                    -- | 'face_service_unavailable' | 'session_invalid_or_expired'
    gps_result       VARCHAR(30),   -- 'inside' | 'outside' | 'not_configured' | 'not_required' | 'not_checked'
    face_result      VARCHAR(30),   -- 'matched' | 'not_matched' | 'not_checked'
    liveness_result  VARCHAR(30),   -- 'live' | 'spoof' | 'inconclusive' | 'not_checked' | 'not_required'
    model            VARCHAR(50),
    review_status    VARCHAR(20) NOT NULL DEFAULT 'not_required'
                       CHECK (review_status IN ('not_required', 'pending', 'approved', 'rejected')),
    reviewed_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at      TIMESTAMPTZ,
    review_decision  VARCHAR(20),
    review_note      TEXT,
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE attendance_verification_attempts ADD COLUMN IF NOT EXISTS work_mode VARCHAR(20) NOT NULL DEFAULT 'office';
ALTER TABLE attendance_verification_attempts ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'pending';
ALTER TABLE attendance_verification_attempts ADD COLUMN IF NOT EXISTS failure_category VARCHAR(50);
ALTER TABLE attendance_verification_attempts ADD COLUMN IF NOT EXISTS gps_result VARCHAR(30);
ALTER TABLE attendance_verification_attempts ADD COLUMN IF NOT EXISTS face_result VARCHAR(30);
ALTER TABLE attendance_verification_attempts ADD COLUMN IF NOT EXISTS liveness_result VARCHAR(30);
ALTER TABLE attendance_verification_attempts ADD COLUMN IF NOT EXISTS model VARCHAR(50);
ALTER TABLE attendance_verification_attempts ADD COLUMN IF NOT EXISTS review_status VARCHAR(20) NOT NULL DEFAULT 'not_required';
ALTER TABLE attendance_verification_attempts ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE attendance_verification_attempts ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE attendance_verification_attempts ADD COLUMN IF NOT EXISTS review_decision VARCHAR(20);
ALTER TABLE attendance_verification_attempts ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE attendance_verification_attempts ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE attendance_verification_attempts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_ava_user_company    ON attendance_verification_attempts(user_id, company_id);
CREATE INDEX IF NOT EXISTS idx_ava_company_status  ON attendance_verification_attempts(company_id, status);
CREATE INDEX IF NOT EXISTS idx_ava_review_status   ON attendance_verification_attempts(company_id, review_status);
CREATE INDEX IF NOT EXISTS idx_ava_attempted_at    ON attendance_verification_attempts(attempted_at DESC);


-- 3. ATTENDANCE VERIFICATION SESSIONS
-- Single-use cryptographic tokens gating check-in/out.
-- Prevents replay attacks: each session token is consumed exactly once and carries a strict TTL.
CREATE TABLE IF NOT EXISTS attendance_verification_sessions (
    id                  TEXT PRIMARY KEY,
    attempt_id          TEXT NOT NULL REFERENCES attendance_verification_attempts(id) ON DELETE CASCADE,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    token_hash          TEXT NOT NULL,               -- SHA-256 of the 32-byte client token
    provider            VARCHAR(50),                 -- 'aws_rekognition' | 'internal' | NULL
    provider_session_id TEXT,
    status              VARCHAR(20) NOT NULL DEFAULT 'issued'
                          CHECK (status IN ('issued', 'consumed', 'expired')),
    expires_at          TIMESTAMPTZ NOT NULL,
    consumed_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE attendance_verification_sessions ADD COLUMN IF NOT EXISTS provider VARCHAR(50);
ALTER TABLE attendance_verification_sessions ADD COLUMN IF NOT EXISTS provider_session_id TEXT;
ALTER TABLE attendance_verification_sessions ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'issued';
ALTER TABLE attendance_verification_sessions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE attendance_verification_sessions ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
ALTER TABLE attendance_verification_sessions ADD COLUMN IF NOT EXISTS action_type VARCHAR(50);
ALTER TABLE attendance_verification_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_avs_user_company  ON attendance_verification_sessions(user_id, company_id);
CREATE INDEX IF NOT EXISTS idx_avs_status        ON attendance_verification_sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_avs_token_hash    ON attendance_verification_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_avs_token_action  ON attendance_verification_sessions(token_hash, action_type);

-- 2A. FACE RE-ENROLLMENT REQUESTS
-- Tracks employee-initiated re-enrollment permission requests and admin decisions.
CREATE TABLE IF NOT EXISTS face_reenrollment_requests (
    id                     TEXT PRIMARY KEY,
    employee_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id             TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    reason                 TEXT NOT NULL,
    status                 VARCHAR(20) NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'rejected')),
    requested_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_by            TEXT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at            TIMESTAMPTZ,
    rejection_reason       TEXT,
    permission_expires_at  TIMESTAMPTZ,
    used_at                TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE face_reenrollment_requests ADD COLUMN IF NOT EXISTS employee_id TEXT;
ALTER TABLE face_reenrollment_requests ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE face_reenrollment_requests ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE face_reenrollment_requests ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE face_reenrollment_requests ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE face_reenrollment_requests ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE face_reenrollment_requests ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE face_reenrollment_requests ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE face_reenrollment_requests ADD COLUMN IF NOT EXISTS permission_expires_at TIMESTAMPTZ;
ALTER TABLE face_reenrollment_requests ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
ALTER TABLE face_reenrollment_requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE face_reenrollment_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_face_reenroll_employee_company ON face_reenrollment_requests(employee_id, company_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_face_reenroll_company_status ON face_reenrollment_requests(company_id, status, requested_at DESC);

-- ============================================================================
-- END OF MIGRATION 002
-- ============================================================================

