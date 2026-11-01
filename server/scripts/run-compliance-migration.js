import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { query } from "../src/config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  try {
    const sqlPath = path.resolve(__dirname, "../src/database/migrations/003_task_compliance_and_hourly_reports.sql");
    const sql = fs.readFileSync(sqlPath, "utf8");
    console.log("🚀 Running migration: 003_task_compliance_and_hourly_reports.sql...");
    await query(sql);
    console.log("✅ Migration 003 completed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Migration error:", err);
    process.exit(1);
  }
}

run();

