import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import app from "../app.js";
import { query } from "../config/db.js";
import { generateToken } from "../middlewares/auth.js";
import { checkComplianceNow } from "../services/complianceSupervisor.js";

const PORT = 5098;
let server;
let baseUrl;

const testCompany = "comp_sla_test_corp";
const testAdmin = {
  id: "usr_admin_sla_test",
  name: "SLA Admin",
  email: "sla_admin@test.local",
  role: "admin",
  companyId: testCompany
};
const testEmp = {
  id: "usr_emp_sla_test",
  name: "SLA Employee",
  email: "sla_emp@test.local",
  role: "employee",
  companyId: testCompany
};

let adminToken;
let empToken;

describe("Task SLA & Hourly Report Compliance Engine Test Suite", () => {
  before(async () => {
    server = http.createServer(app);
    await new Promise(resolve => server.listen(PORT, resolve));
    baseUrl = `http://localhost:${PORT}/api`;

    // Seed test company and users
    await query(`INSERT INTO companies (id, name, slug) VALUES ($1, 'SLA Corp', 'sla-corp') ON CONFLICT (id) DO NOTHING`, [testCompany]);
    await query(`INSERT INTO users (id, name, email, password_hash, role, company_id) VALUES ($1, $2, $3, 'hashed', 'admin', $4) ON CONFLICT (id) DO NOTHING`, [testAdmin.id, testAdmin.name, testAdmin.email, testCompany]);
    await query(`INSERT INTO users (id, name, email, password_hash, role, company_id) VALUES ($1, $2, $3, 'hashed', 'employee', $4) ON CONFLICT (id) DO NOTHING`, [testEmp.id, testEmp.name, testEmp.email, testCompany]);

    // Clean any residual test tasks and attendance
    await query(`DELETE FROM tasks WHERE company_id = $1`, [testCompany]);
    await query(`DELETE FROM hourly_reports WHERE company_id = $1`, [testCompany]);
    await query(`DELETE FROM attendance WHERE company_id = $1`, [testCompany]);

    adminToken = generateToken({ id: testAdmin.id, email: testAdmin.email, role: testAdmin.role, companyId: testCompany });
    empToken = generateToken({ id: testEmp.id, email: testEmp.email, role: testEmp.role, companyId: testCompany });
  });

  after(async () => {
    // Cleanup
    await query(`DELETE FROM tasks WHERE company_id = $1`, [testCompany]);
    await query(`DELETE FROM hourly_reports WHERE company_id = $1`, [testCompany]);
    await query(`DELETE FROM attendance WHERE company_id = $1`, [testCompany]);
    await query(`DELETE FROM notifications WHERE user_id IN ($1, $2)`, [testAdmin.id, testEmp.id]);
    await query(`DELETE FROM users WHERE id IN ($1, $2)`, [testAdmin.id, testEmp.id]);
    await query(`DELETE FROM companies WHERE id = $1`, [testCompany]);

    await new Promise(resolve => server.close(resolve));
  });

  it("1. Employee finishes task within deadline -> marked completed_on_time", async () => {
    const futureDue = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2 hours in future

    // Admin creates task
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        title: "Build Homepage Banner",
        deadline: futureDue,
        dueDate: futureDue,
        assignedTo: testEmp.id,
        companyId: testCompany
      })
    });
    assert.strictEqual(createRes.status, 201);
    const task = await createRes.json();

    // Employee views task
    const viewRes = await fetch(`${baseUrl}/tasks/${task.id}/view`, {
      method: "POST",
      headers: { Authorization: `Bearer ${empToken}` }
    });
    assert.strictEqual(viewRes.status, 200);
    const viewedTask = await viewRes.json();
    assert.ok(viewedTask.viewed_at, "Task must have viewed_at timestamp");
    assert.strictEqual(viewedTask.status, "accepted");

    // Employee completes task before deadline
    const compRes = await fetch(`${baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${empToken}` },
      body: JSON.stringify({ completionNotes: "Finished design files on time" })
    });
    assert.strictEqual(compRes.status, 200);
    const completed = await compRes.json();
    assert.strictEqual(completed.status, "completed");
    assert.strictEqual(completed.completion_status, "completed_on_time");
  });

  it("2. Employee finishes task after deadline -> marked completed_overdue", async () => {
    const pastDue = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 minutes in past

    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        title: "Fix Navigation Bar",
        deadline: pastDue,
        dueDate: pastDue,
        assignedTo: testEmp.id,
        companyId: testCompany
      })
    });
    const task = await createRes.json();

    const compRes = await fetch(`${baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${empToken}` },
      body: JSON.stringify({ completionNotes: "Delivered late" })
    });
    assert.strictEqual(compRes.status, 200);
    const completed = await compRes.json();
    assert.strictEqual(completed.status, "completed");
    assert.strictEqual(completed.completion_status, "completed_overdue");
  });

  it("3. Unseen task > 1 hour -> Auto marks attendance Absent and locks record", async () => {
    const taskId = "task_sla_unseen_" + Date.now();
    const today = new Date().toISOString().split("T")[0];

    // Seed an initial present attendance for today
    const attId = "att_test_" + Date.now();
    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in)
       VALUES ($1, $2, $3, $4, 'present', NOW())`,
      [attId, testEmp.id, testCompany, today]
    );

    // Seed task assigned 1 hour and 15 minutes ago, never viewed
    await query(
      `INSERT INTO tasks (id, company_id, title, assigned_to, created_by, status, viewed_at, sla_penalty_applied, assigned_at, created_at)
       VALUES ($1, $2, 'Critical Client Bug', $3, $4, 'new', NULL, FALSE, NOW() - INTERVAL '1 hour 15 minutes', NOW() - INTERVAL '1 hour 15 minutes')`,
      [taskId, testCompany, testEmp.id, testAdmin.id]
    );

    // Run compliance supervisor check for testCompany
    const checkResult = await checkComplianceNow(null, testCompany);
    assert.ok(checkResult.taskPenalties >= 1, "Should identify and penalize at least 1 unseen task violation");

    // Verify employee's attendance record is now Absent and Admin Locked
    const attCheck = await query("SELECT * FROM attendance WHERE id = $1", [attId]);
    assert.strictEqual(attCheck.rows[0].status, "absent");
    assert.strictEqual(attCheck.rows[0].penalty_status, "unseen_task_penalty");
    assert.strictEqual(attCheck.rows[0].is_admin_locked, true);
    assert.ok(attCheck.rows[0].penalty_reason.includes("1 hour"));

    // Verify task sla_penalty_applied is now TRUE
    const taskCheck = await query("SELECT sla_penalty_applied FROM tasks WHERE id = $1", [taskId]);
    assert.strictEqual(taskCheck.rows[0].sla_penalty_applied, true);

    // Verify notifications were delivered
    const notifs = await query("SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC", [testEmp.id]);
    assert.ok(notifs.rows.length > 0);
    assert.ok(notifs.rows[0].title.includes("Attendance Marked Absent"));
  });

  it("4. Admin can revert penalty -> restores Present status and lifts lock", async () => {
    const today = new Date().toISOString().split("T")[0];
    const attRes = await query("SELECT id FROM attendance WHERE user_id = $1 AND date = $2", [testEmp.id, today]);
    assert.ok(attRes.rows.length > 0, "Attendance record must exist");
    const attId = attRes.rows[0].id;

    // Regular employee cannot revert penalty
    const failRes = await fetch(`${baseUrl}/attendance/${attId}/revert-penalty`, {
      method: "POST",
      headers: { Authorization: `Bearer ${empToken}` }
    });
    assert.strictEqual(failRes.status, 403);

    // Admin reverts penalty
    const revertRes = await fetch(`${baseUrl}/attendance/${attId}/revert-penalty`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ resolutionNotes: "Employee was in external client meeting" })
    });
    assert.strictEqual(revertRes.status, 200);
    const body = await revertRes.json();
    assert.strictEqual(body.attendance.status, "present");
    assert.strictEqual(body.attendance.is_admin_locked, false);
    assert.strictEqual(body.attendance.penalty_status, null);
  });

  it("5. Missed hourly report > 2 hours -> Auto marks Absent and locks reporting", async () => {
    const today = new Date().toISOString().split("T")[0];
    const attId = "att_hourly_test_" + Date.now();

    // Ensure clean state for today
    await query("DELETE FROM hourly_reports WHERE user_id = $1 AND report_date = $2", [testEmp.id, today]);
    await query("DELETE FROM attendance WHERE user_id = $1 AND date = $2", [testEmp.id, today]);

    // Check in 2 hours and 30 minutes ago with NO hourly report submitted
    await query(
      `INSERT INTO attendance (id, user_id, company_id, date, status, check_in, is_admin_locked)
       VALUES ($1, $2, $3, $4, 'present', NOW() - INTERVAL '2 hours 30 minutes', FALSE)`,
      [attId, testEmp.id, testCompany, today]
    );

    // Run compliance check for testCompany
    const reportCheck = await checkComplianceNow(null, testCompany);
    assert.strictEqual(reportCheck.penaltyCount, 1, "Should catch exactly 1 missed hourly report violation");

    // Verify attendance is marked Absent and locked
    const attRow = await query("SELECT * FROM attendance WHERE id = $1", [attId]);
    assert.strictEqual(attRow.rows[0].status, "absent");
    assert.strictEqual(attRow.rows[0].penalty_status, "missed_hourly_report_penalty");
    assert.strictEqual(attRow.rows[0].is_admin_locked, true);

    // Employee tries to submit hourly report while locked -> 403 Forbidden
    const submitFail = await fetch(`${baseUrl}/reports/hourly`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${empToken}` },
      body: JSON.stringify({
        workCompleted: "Trying to submit late report",
        progressPercentage: 40,
        pendingWork: "More testing"
      })
    });
    assert.strictEqual(submitFail.status, 403);
    const submitFailBody = await submitFail.json();
    assert.strictEqual(submitFailBody.locked, true);

    // Admin resolves penalty
    await fetch(`${baseUrl}/attendance/${attId}/revert-penalty`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ resolutionNotes: "Granted exception" })
    });

    // Employee can now submit hourly report successfully
    const submitOk = await fetch(`${baseUrl}/reports/hourly`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${empToken}` },
      body: JSON.stringify({
        workCompleted: "Completed module integration and tests",
        progressPercentage: 85,
        pendingWork: "Final documentation",
        issuesBlockers: "None"
      })
    });
    assert.strictEqual(submitOk.status, 201);
    const repData = await submitOk.json();
    assert.ok(repData.id);
    assert.strictEqual(repData.work_completed, "Completed module integration and tests");
    assert.strictEqual(repData.progress_percentage, 85);
  });
});
