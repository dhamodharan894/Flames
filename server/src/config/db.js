import pg from "pg";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config();

const { Pool } = pg;

const DEFAULT_DB_URL = "postgresql://postgres:wbmoHIZoKMKVvFhmAHgDYLUdVhZCcTzq@kodama.proxy.rlwy.net:52896/railway";
const activeDbUrl = process.env.DATABASE_URL || DEFAULT_DB_URL;

const pool = new Pool({
  connectionString: activeDbUrl,
  ssl: { rejectUnauthorized: false },
  max: 15,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 8000,
  statement_timeout: 15000,
  query_timeout: 15000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000
});

pool.on("connect", (client) => {
  // connection established
});

pool.on("error", (err, client) => {
  console.warn("⚠️ PostgreSQL client warning/drop:", err.message);
});

export const query = async (text, params) => {
  try {
    return await pool.query(text, params);
  } catch (err) {
    // If connection was dropped or timed out, retry once
    if (err.message && (err.message.includes("timeout") || err.message.includes("Connection terminated") || err.message.includes("closed"))) {
      console.warn("⚠️ Retrying query after connection reset:", text.slice(0, 50));
      return await pool.query(text, params);
    }
    throw err;
  }
};
export default pool;
