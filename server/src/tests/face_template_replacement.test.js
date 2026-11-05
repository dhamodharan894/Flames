/**
 * Automated Verification Suite for Face Template Replacement
 * ==========================================================
 * Tests all 11 required scenarios:
 *   1. Admin enrolls an employee without an existing template (Mode A).
 *   2. Admin replaces an existing enrolled employee's face template (Mode B).
 *   3. Admin replaces a template when self-enrollment permission is revoked.
 *   4. Employee cannot replace a template when self-enrollment permission is revoked.
 *   5. Employee can replace a template after reauthorization.
 *   6. Failed face detection preserves the previous embedding.
 *   7. Failed Python face-service processing preserves the previous embedding.
 *   8. Replacement updates the existing profile instead of creating a duplicate.
 *   9. Cross-tenant admin replacement is rejected.
 *  10. Attendance verification works using the newly replaced embedding.
 *  11. Existing consent and attendance history remain intact.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import app from "../app.js";
import { query } from "../config/db.js";
import { generateToken } from "../middlewares/auth.js";
import faceServiceClient, { FaceServiceUnavailableError } from "../services/faceServiceClient.js";
import { generateVerificationSessionToken } from "../services/livenessVerification.js";

const PORT = 5094;
let server;
let baseUrl;

const companyA = "company_repl_alpha";
const companyB = "company_repl_beta";

const adminUserA = {
  id: "test_repl_admin_a",
  email: "admin_a@example.com",
  role: "admin",
  companyId: companyA
};

const adminUserB = {
  id: "test_repl_admin_b",
  email: "admin_b@example.com",
  role: "admin",
  companyId: companyB
};

const employeeA1 = {
  id: "test_repl_emp_a1",
  email: "emp_a1@example.com",
  role: "employee",
  companyId: companyA
};

const employeeA2 = {
  id: "test_repl_emp_a2",
  email: "emp_a2@example.com",
  role: "employee",
  companyId: companyA
};

const adminTokenA = generateToken(adminUserA);
const adminTokenB = generateToken(adminUserB);
const empA1Token = generateToken(employeeA1);
const empA2Token = generateToken(employeeA2);

function makeSyntheticEmbedding(dim = 512, seed = 1) {
  const raw = Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return raw.map(v => v / norm);
}

// 200+ byte valid test image payload
const validImageBase64 = "data:image/jpeg;base64," + "A".repeat(400);

describe("HRMS Face Template Replacement & Biometrics Suite", () => {
  const originalEnrollFace = faceServiceClient.enrollFace;
  const originalVerifyFace = faceServiceClient.verifyFace;

  it("0. Setup in-process server and test database entities", async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(PORT, resolve));
    baseUrl = `http://127.0.0.1:${PORT}/api`;

    // Create companies with geofencing coordinates
    await query(
      `INSERT INTO companies (id, name, latitude, longitude, allowed_radius_meters)
       VALUES ($1, 'Alpha Replacement Org', 13.0827, 80.2707, 1000),
              ($2, 'Beta Replacement Org', 12.9716, 77.5946, 1000)
       ON CONFLICT (id) DO UPDATE SET
         latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude,
         allowed_radius_meters = EXCLUDED.allowed_radius_meters`,
      [companyA, companyB]
    );

    // Create users
    for (const u of [adminUserA, adminUserB, employeeA1, employeeA2]) {
      await query(
        `INSERT INTO users (id, name, email, password_hash, role, company_id, status)
         VALUES ($1, $2, $3, 'hash', $4, $5, 'active')
         ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, company_id = EXCLUDED.company_id`,
        [u.id, u.email.split("@")[0], u.email, u.role, u.companyId]
      );
    }

    // Clean up any old test profiles
    await query(`DELETE FROM employee_face_profiles WHERE user_id IN ($1, $2)`, [
      employeeA1.id,
      employeeA2.id
    ]);
  });

  it("1. Scenario 1: Admin enrolls an employee without an existing template (Mode A: New Enrollment)", async () => {
    const embedding1 = makeSyntheticEmbedding(512, 10);
    faceServiceClient.enrollFace = async () => ({
      embedding: embedding1,
      model: "ArcFace",
      embedding_dimension: 512,
      quality_score: 0.88,
      face_count: 1
    });

    const res = await fetch(`${baseUrl}/attendance/face/enroll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminTokenA}`
      },
      body: JSON.stringify({
        targetUserId: employeeA1.id,
        imageBase64: validImageBase64,
        consentGiven: true
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.mode, "enrollment");
    assert.equal(data.enrollment_status, "enrolled");

    // Verify row in database
    const dbRes = await query(
      "SELECT * FROM employee_face_profiles WHERE user_id = $1 AND company_id = $2",
      [employeeA1.id, companyA]
    );
    assert.equal(dbRes.rows.length, 1);
    const profile = dbRes.rows[0];
    assert.equal(profile.enrollment_status, "enrolled");
    assert.ok(profile.face_embedding);
    assert.ok(profile.consent_recorded_at);
  });

  it("2. Scenario 2: Admin replaces an existing enrolled employee's face template (Mode B: Template Replacement)", async () => {
    // Record original profile details
    const beforeRes = await query(
      "SELECT * FROM employee_face_profiles WHERE user_id = $1 AND company_id = $2",
      [employeeA1.id, companyA]
    );
    const profileBefore = beforeRes.rows[0];
    const originalConsentRecordedAt = profileBefore.consent_recorded_at;
    const originalProfileId = profileBefore.id;

    // New embedding representing updated face capture
    const embedding2 = makeSyntheticEmbedding(512, 20);
    faceServiceClient.enrollFace = async () => ({
      embedding: embedding2,
      model: "ArcFace",
      embedding_dimension: 512,
      quality_score: 0.94,
      face_count: 1
    });

    const res = await fetch(`${baseUrl}/attendance/face/enroll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminTokenA}`
      },
      body: JSON.stringify({
        targetUserId: employeeA1.id,
        imageBase64: validImageBase64,
        consentGiven: true
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.mode, "replacement");
    assert.equal(data.enrollment_status, "enrolled");

    // Verify database state: profile ID, consent date, and tenant are preserved
    const afterRes = await query(
      "SELECT * FROM employee_face_profiles WHERE user_id = $1 AND company_id = $2",
      [employeeA1.id, companyA]
    );
    assert.equal(afterRes.rows.length, 1, "Exactly one profile must exist (no duplicate)");
    const profileAfter = afterRes.rows[0];
    assert.equal(profileAfter.id, originalProfileId, "Profile ID must be preserved");
    assert.equal(
      new Date(profileAfter.consent_recorded_at).toISOString(),
      new Date(originalConsentRecordedAt).toISOString(),
      "Original biometric consent timestamp must be preserved"
    );

    // Verify embedding was replaced
    const storedEmbedding = typeof profileAfter.face_embedding === "string"
      ? JSON.parse(profileAfter.face_embedding)
      : profileAfter.face_embedding;
    assert.deepEqual(storedEmbedding, embedding2, "Embedding vector must match the newly generated replacement");
    assert.equal(profileAfter.metadata.replacementCount, 1);
  });

  it("3. Scenario 3: Admin replaces a template when employee self-enrollment permission is revoked", async () => {
    // Explicitly revoke self-enrollment permission on employee profile
    await query(
      `UPDATE employee_face_profiles
       SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"selfEnrollmentAuthorized": false, "reenrollmentAuthorized": false}'::jsonb
       WHERE user_id = $1`,
      [employeeA1.id]
    );

    // Verify employee has selfEnrollmentAuthorized === false
    const checkAuth = await query(
      "SELECT metadata FROM employee_face_profiles WHERE user_id = $1",
      [employeeA1.id]
    );
    assert.equal(checkAuth.rows[0].metadata?.selfEnrollmentAuthorized, false);

    // Admin initiates template replacement
    const embedding3 = makeSyntheticEmbedding(512, 30);
    faceServiceClient.enrollFace = async () => ({
      embedding: embedding3,
      model: "ArcFace",
      embedding_dimension: 512,
      quality_score: 0.91,
      face_count: 1
    });

    const res = await fetch(`${baseUrl}/attendance/face/enroll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminTokenA}`
      },
      body: JSON.stringify({
        targetUserId: employeeA1.id,
        imageBase64: validImageBase64,
        consentGiven: true
      })
    });

    assert.equal(res.status, 200, "Admin replacement must succeed even when employee self-enrollment is revoked");
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.mode, "replacement");
  });

  it("4. Scenario 4: Employee cannot replace a template when self-enrollment permission is revoked", async () => {
    // Employee tries to self-replace face template while selfEnrollmentAuthorized is false
    const res = await fetch(`${baseUrl}/attendance/face/enroll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${empA1Token}`
      },
      body: JSON.stringify({
        imageBase64: validImageBase64,
        consentGiven: true
      })
    });

    assert.equal(res.status, 403, "Self-replacement must be rejected when not authorized");
    const data = await res.json();
    assert.match(data.error, /authorized|Self-replacement/i);
  });

  it("5. Scenario 5: Employee can replace a template after reauthorization", async () => {
    // Admin authorizes re-enrollment for employee
    const authRes = await fetch(`${baseUrl}/attendance/face/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminTokenA}`
      },
      body: JSON.stringify({ targetUserId: employeeA1.id })
    });
    assert.equal(authRes.status, 200);

    // Employee now self-replaces template
    const embeddingSelf = makeSyntheticEmbedding(512, 50);
    faceServiceClient.enrollFace = async () => ({
      embedding: embeddingSelf,
      model: "ArcFace",
      embedding_dimension: 512,
      quality_score: 0.95,
      face_count: 1
    });

    const res = await fetch(`${baseUrl}/attendance/face/enroll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${empA1Token}`
      },
      body: JSON.stringify({
        imageBase64: validImageBase64,
        consentGiven: true
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.mode, "replacement");
  });

  it("6. Scenario 6: Failed face detection preserves the previous embedding", async () => {
    const beforeRes = await query(
      "SELECT face_embedding FROM employee_face_profiles WHERE user_id = $1",
      [employeeA1.id]
    );
    const embeddingBefore = beforeRes.rows[0].face_embedding;

    // Simulate Python face service returning 400 No face detected
    faceServiceClient.enrollFace = async () => {
      const err = new Error("No face detected. Please ensure your face is well-lit and centered.");
      err.status = 400;
      throw err;
    };

    const res = await fetch(`${baseUrl}/attendance/face/enroll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminTokenA}`
      },
      body: JSON.stringify({
        targetUserId: employeeA1.id,
        imageBase64: validImageBase64,
        consentGiven: true
      })
    });

    assert.equal(res.status, 400);

    // Verify database: embedding must remain completely untouched
    const afterRes = await query(
      "SELECT face_embedding FROM employee_face_profiles WHERE user_id = $1",
      [employeeA1.id]
    );
    assert.deepEqual(afterRes.rows[0].face_embedding, embeddingBefore, "Previous embedding must be preserved on face detection failure");
  });

  it("7. Scenario 7: Failed Python face-service processing preserves the previous embedding", async () => {
    const beforeRes = await query(
      "SELECT face_embedding FROM employee_face_profiles WHERE user_id = $1",
      [employeeA1.id]
    );
    const embeddingBefore = beforeRes.rows[0].face_embedding;

    // Simulate Python microservice unavailable (503 / timeout)
    faceServiceClient.enrollFace = async () => {
      throw new FaceServiceUnavailableError("Face verification service is offline.");
    };

    const res = await fetch(`${baseUrl}/attendance/face/enroll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminTokenA}`
      },
      body: JSON.stringify({
        targetUserId: employeeA1.id,
        imageBase64: validImageBase64,
        consentGiven: true
      })
    });

    assert.equal(res.status, 503);

    // Verify embedding remains unchanged
    const afterRes = await query(
      "SELECT face_embedding FROM employee_face_profiles WHERE user_id = $1",
      [employeeA1.id]
    );
    assert.deepEqual(afterRes.rows[0].face_embedding, embeddingBefore, "Previous embedding must be preserved on microservice failure");
  });

  it("8. Scenario 8: Replacement updates the existing profile instead of creating a duplicate", async () => {
    const countBefore = await query(
      "SELECT COUNT(*) FROM employee_face_profiles WHERE user_id = $1",
      [employeeA1.id]
    );
    assert.equal(Number(countBefore.rows[0].count), 1);

    const embedding8 = makeSyntheticEmbedding(512, 80);
    faceServiceClient.enrollFace = async () => ({
      embedding: embedding8,
      model: "ArcFace",
      embedding_dimension: 512,
      quality_score: 0.90,
      face_count: 1
    });

    const res = await fetch(`${baseUrl}/attendance/face/enroll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminTokenA}`
      },
      body: JSON.stringify({
        targetUserId: employeeA1.id,
        imageBase64: validImageBase64,
        consentGiven: true
      })
    });

    assert.equal(res.status, 200);

    const countAfter = await query(
      "SELECT COUNT(*) FROM employee_face_profiles WHERE user_id = $1",
      [employeeA1.id]
    );
    assert.equal(Number(countAfter.rows[0].count), 1, "Must maintain exactly one profile row per employee");
  });

  it("9. Scenario 9: Cross-tenant admin replacement is rejected", async () => {
    // Admin B (Company B) tries to replace face template for Employee A1 (Company A)
    const res = await fetch(`${baseUrl}/attendance/face/enroll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminTokenB}`
      },
      body: JSON.stringify({
        targetUserId: employeeA1.id,
        imageBase64: validImageBase64,
        consentGiven: true
      })
    });

    assert.equal(res.status, 403, "Cross-tenant replacement must be rejected");
    const data = await res.json();
    assert.equal(data.code, "CROSS_TENANT_ACCESS_DENIED");
  });

  it("10. Scenario 10: Attendance verification works using the newly replaced embedding", async () => {
    // Replaced template for Employee A1 is embedding8 (seed 80)
    const storedProfile = await query(
      "SELECT face_embedding FROM employee_face_profiles WHERE user_id = $1",
      [employeeA1.id]
    );
    const activeEmbedding = typeof storedProfile.rows[0].face_embedding === "string"
      ? JSON.parse(storedProfile.rows[0].face_embedding)
      : storedProfile.rows[0].face_embedding;

    // Setup verification mock to compare against the active enrolledEmbedding passed by attendanceController
    let receivedEnrolledEmbedding = null;
    faceServiceClient.verifyFace = async ({ enrolledEmbedding, imageBase64 }) => {
      receivedEnrolledEmbedding = enrolledEmbedding;
      return {
        matched: true,
        distance: 0.12,
        threshold: 0.40,
        model: "ArcFace",
        face_count: 1,
        quality_score: 0.95,
        liveness_result: "not_checked"
      };
    };

    // Verify session directly with attendance verification endpoint
    const verifyRes = await fetch(`${baseUrl}/attendance/face/verify-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${empA1Token}`
      },
      body: JSON.stringify({
        imageBase64: validImageBase64,
        workMode: "office",
        location: { latitude: 13.0827, longitude: 80.2707 },
        actionType: "check-in"
      })
    });

    assert.equal(verifyRes.status, 200, "Verification should succeed with active template");
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.verified, true);
    assert.ok(verifyData.verificationSessionToken);
    assert.deepEqual(receivedEnrolledEmbedding, activeEmbedding, "Attendance verification must use the replaced embedding");
  });

  it("11. Scenario 11: Existing consent and attendance history remain intact", async () => {
    // Seed attendance log for employee A1
    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in)
       VALUES ('test_att_hist_1', $1, $2, CURRENT_DATE, 'present', CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO NOTHING`,
      [employeeA1.id, companyA]
    );

    // Admin replaces template again
    const embeddingFinal = makeSyntheticEmbedding(512, 999);
    faceServiceClient.enrollFace = async () => ({
      embedding: embeddingFinal,
      model: "ArcFace",
      embedding_dimension: 512,
      quality_score: 0.92,
      face_count: 1
    });

    const res = await fetch(`${baseUrl}/attendance/face/enroll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminTokenA}`
      },
      body: JSON.stringify({
        targetUserId: employeeA1.id,
        imageBase64: validImageBase64,
        consentGiven: true
      })
    });
    assert.equal(res.status, 200);

    // Verify attendance records are intact
    const attCheck = await query(
      "SELECT * FROM attendance WHERE id = 'test_att_hist_1'"
    );
    assert.equal(attCheck.rows.length, 1, "Historical attendance records must never be lost");

    // Verify consent record timestamp is preserved
    const profCheck = await query(
      "SELECT consent_recorded_at FROM employee_face_profiles WHERE user_id = $1",
      [employeeA1.id]
    );
    assert.ok(profCheck.rows[0].consent_recorded_at, "Biometric consent timestamp must remain intact");
  });

  it("cleanup and restore faceServiceClient mocks", async () => {
    faceServiceClient.enrollFace = originalEnrollFace;
    faceServiceClient.verifyFace = originalVerifyFace;

    await query("DELETE FROM attendance WHERE id = 'test_att_hist_1'");
    await query("DELETE FROM attendance_verification_attempts WHERE user_id IN ($1, $2)", [
      employeeA1.id,
      employeeA2.id
    ]);
    await query("DELETE FROM employee_face_profiles WHERE user_id IN ($1, $2)", [
      employeeA1.id,
      employeeA2.id
    ]);
    await query("DELETE FROM users WHERE id IN ($1, $2, $3, $4)", [
      adminUserA.id,
      adminUserB.id,
      employeeA1.id,
      employeeA2.id
    ]);
    await query("DELETE FROM companies WHERE id IN ($1, $2)", [companyA, companyB]);

    await new Promise((resolve) => server.close(resolve));
  });
});
