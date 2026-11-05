import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import app from "../app.js";
import { query } from "../config/db.js";
import { generateToken } from "../middlewares/auth.js";
import { generateVerificationSessionToken, hashToken } from "../services/livenessVerification.js";

const PORT = 5094;
let server;
let baseUrl;

const companyId = "company_multisession_test";
const testUser = {
  id: "test_emp_multi_session",
  email: "multi_session@example.com",
  role: "employee",
  companyId
};

const userToken = generateToken(testUser);

async function issueTestToken(userId, company, actionType = "check-in") {
  const { rawToken, tokenHash } = generateVerificationSessionToken();
  const sessionId = "avs_ms_" + Math.random().toString(36).substring(2);
  const attemptId = "ava_ms_" + Math.random().toString(36).substring(2);

  await query(
    `INSERT INTO attendance_verification_attempts (
       id, user_id, company_id, work_mode, status, gps_result, face_result, liveness_result, model
     ) VALUES ($1, $2, $3, 'office', 'verified', 'inside', 'matched', 'not_checked', 'ArcFace')`,
    [attemptId, userId, company]
  );

  await query(
    `INSERT INTO attendance_verification_sessions (
       id, attempt_id, user_id, company_id, token_hash, provider, status, expires_at, action_type
     ) VALUES ($1, $2, $3, $4, $5, 'internal', 'issued', CURRENT_TIMESTAMP + INTERVAL '10 minutes', $6)`,
    [sessionId, attemptId, userId, company, tokenHash, actionType]
  );

  return rawToken;
}

describe("Attendance Multi-Session & Timer Integrity Test Suite", () => {
  it("0. Setup test company, user, and server", async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(PORT, resolve));
    baseUrl = `http://127.0.0.1:${PORT}/api`;

    await query(
      `INSERT INTO companies (id, name, latitude, longitude, allowed_radius_meters)
       VALUES ($1, 'MultiSession Test Co', 13.0827, 80.2707, 200)
       ON CONFLICT (id) DO UPDATE SET
         latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude,
         allowed_radius_meters = EXCLUDED.allowed_radius_meters`,
      [companyId]
    );

    await query(
      `INSERT INTO users (id, name, email, password_hash, role, company_id, status)
       VALUES ($1, 'Multi Emp', $2, 'test_hash', 'employee', $3, 'active')
       ON CONFLICT (id) DO UPDATE SET company_id = EXCLUDED.company_id`,
      [testUser.id, testUser.email, companyId]
    );

    const today = new Date().toISOString().split("T")[0];
    await query(`DELETE FROM attendance WHERE id = $1`, [`${testUser.id}_${today}`]);
  });

  it("1. Check in 1: Starts initial session and active status", async () => {
    const token = await issueTestToken(testUser.id, companyId, "check-in");

    const res = await fetch(`${baseUrl}/attendance/check-in`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`
      },
      body: JSON.stringify({
        location: { latitude: 13.0827, longitude: 80.2707 },
        workMode: "office",
        verificationSessionToken: token
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, "checked-in");
    assert.ok(data.checkIn);
    assert.ok(data.latestCheckInTime);
    assert.equal(data.accumulatedWorkingMinutes, 0);
    assert.ok(Array.isArray(data.sessions));
    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessions[0].sessionIndex, 1);
    assert.equal(data.sessions[0].checkOut, null);
  });

  it("2. Take break during session 1 and resume", async () => {
    // Start Break 1
    const breakRes = await fetch(`${baseUrl}/attendance/start-break`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`
      },
      body: JSON.stringify({
        breakType: "short",
        reason: "Coffee break",
        location: { latitude: 13.0827, longitude: 80.2707 }
      })
    });

    assert.equal(breakRes.status, 200);
    const breakData = await breakRes.json();
    assert.equal(breakData.status, "on-break");
    assert.equal(breakData.breaks.length, 1);
    assert.equal(breakData.breaks[0].end, null);

    // End Break 1
    const endBreakRes = await fetch(`${baseUrl}/attendance/end-break`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`
      },
      body: JSON.stringify({
        location: { latitude: 13.0827, longitude: 80.2707 }
      })
    });

    assert.equal(endBreakRes.status, 200);
    const endData = await endBreakRes.json();
    assert.equal(endData.status, "checked-in");
    assert.ok(endData.breaks[0].end);
    assert.ok(endData.breaks[0].resumeTime);
  });

  it("3. Check out 1: Closes session 1 and stops timer immediately", async () => {
    const token = await issueTestToken(testUser.id, companyId, "check-out");

    const res = await fetch(`${baseUrl}/attendance/check-out`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`
      },
      body: JSON.stringify({
        location: { latitude: 13.0827, longitude: 80.2707 },
        verificationSessionToken: token
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, "checked-out");
    assert.ok(data.checkOutTime);
    assert.ok(typeof data.totalWorkingMinutes === "number");
    assert.ok(Array.isArray(data.sessions));
    assert.equal(data.sessions.length, 1);
    assert.ok(data.sessions[0].checkOut);
  });

  it("4. Check in 2 (Re-check-in): Appends session 2, preserves session 1", async () => {
    const token = await issueTestToken(testUser.id, companyId, "check-in");

    const res = await fetch(`${baseUrl}/attendance/check-in`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`
      },
      body: JSON.stringify({
        location: { latitude: 13.0827, longitude: 80.2707 },
        workMode: "office",
        verificationSessionToken: token
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, "checked-in");
    assert.ok(data.latestCheckInTime);
    assert.ok(Array.isArray(data.sessions));
    assert.equal(data.sessions.length, 2);
    // Session 1 remains completed with its checkOut and duration
    assert.equal(data.sessions[0].sessionIndex, 1);
    assert.ok(data.sessions[0].checkOut);
    // Session 2 is newly active
    assert.equal(data.sessions[1].sessionIndex, 2);
    assert.equal(data.sessions[1].checkOut, null);
    assert.equal(data.sessions[1].checkIn, data.latestCheckInTime);
  });

  it("5. Check out 2: Successfully completes second session and accumulates total hours", async () => {
    const token = await issueTestToken(testUser.id, companyId, "check-out");

    const res = await fetch(`${baseUrl}/attendance/check-out`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`
      },
      body: JSON.stringify({
        location: { latitude: 13.0827, longitude: 80.2707 },
        verificationSessionToken: token
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, "checked-out");
    assert.ok(Array.isArray(data.sessions));
    assert.equal(data.sessions.length, 2);
    assert.ok(data.sessions[0].checkOut);
    assert.ok(data.sessions[1].checkOut);
    assert.equal(
      data.totalWorkingMinutes,
      data.sessions[0].durationMinutes + data.sessions[1].durationMinutes
    );
  });

  it("6. getAttendance: Correctly reports completed sessions and status", async () => {
    const today = new Date().toISOString().split("T")[0];
    const res = await fetch(`${baseUrl}/attendance?userId=${testUser.id}&date=${today}`, {
      headers: {
        Authorization: `Bearer ${userToken}`
      }
    });

    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(Array.isArray(list));
    const todayRecord = list.find(r => r.userId === testUser.id);
    assert.ok(todayRecord);
    assert.equal(todayRecord.status, "checked-out");
    assert.equal(todayRecord.sessions.length, 2);
    assert.equal(
      todayRecord.totalWorkingMinutes,
      todayRecord.sessions[0].durationMinutes + todayRecord.sessions[1].durationMinutes
    );
  });

  it("7. Teardown test entities and server", async () => {
    const today = new Date().toISOString().split("T")[0];
    await query(`DELETE FROM attendance WHERE id LIKE 'test_%'`);
    await query(`DELETE FROM attendance_verification_sessions WHERE user_id LIKE 'test_%'`);
    await query(`DELETE FROM attendance_verification_attempts WHERE user_id LIKE 'test_%'`);
    await query(`DELETE FROM users WHERE id = $1`, [testUser.id]);
    await query(`DELETE FROM companies WHERE id = $1`, [companyId]);

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
