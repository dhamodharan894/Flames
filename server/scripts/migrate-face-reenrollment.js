import { query } from "../src/config/db.js";

export async function runFaceReenrollmentMigration() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS face_reenrollment_requests (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        company_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reviewed_by TEXT,
        reviewed_at TIMESTAMPTZ,
        rejection_reason TEXT,
        permission_expires_at TIMESTAMPTZ,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_face_reenroll_employee_company
      ON face_reenrollment_requests(employee_id, company_id, status, requested_at DESC);
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_face_reenroll_company_status
      ON face_reenrollment_requests(company_id, status, requested_at DESC);
    `);

    console.log("✅ Verified face_reenrollment_requests table exists.");
  } catch (err) {
    console.warn("⚠️ Face re-enrollment migration note:", err.message);
  }
}

if (process.argv[1] && process.argv[1].endsWith("migrate-face-reenrollment.js")) {
  runFaceReenrollmentMigration()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Face re-enrollment migration failed:", err);
      process.exit(1);
    });
}
