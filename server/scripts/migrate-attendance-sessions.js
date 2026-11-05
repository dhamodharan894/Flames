import { query } from "../src/config/db.js";

export async function runAttendanceSessionsMigration() {
  try {
    await query(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS sessions JSONB DEFAULT '[]'::jsonb;`);
    console.log("✅ Verified attendance.sessions column exists.");
  } catch (err) {
    console.warn("⚠️ Attendance sessions migration note:", err.message);
  }
}

if (process.argv[1] && process.argv[1].endsWith("migrate-attendance-sessions.js")) {
  runAttendanceSessionsMigration()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Migration failed:", err);
      process.exit(1);
    });
}
