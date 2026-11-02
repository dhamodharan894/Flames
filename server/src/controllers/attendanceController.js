import crypto from "crypto";
import { query } from "../config/db.js";
import auditService from "../services/auditService.js";
import securityDetector from "../services/securityDetector.js";
import faceServiceClient, {
  FaceServiceUnavailableError,
  FaceServiceVerificationError
} from "../services/faceServiceClient.js";
import { isValidEmbedding, evaluateFaceMatch } from "../services/faceVerificationPolicy.js";
import { validateEnrollmentPayload, canEnrollFace } from "../services/faceEnrollmentValidation.js";
import { generateVerificationSessionToken, hashToken } from "../services/livenessVerification.js";
import { validateServerGeofence } from "../utils/geofence.js";
import { withTransaction } from "../utils/transaction.js";

export const getAttendance = async (req, res) => {
  try {
    const { userId, companyId, startDate, endDate, date } = req.query;
    const isSuperAdmin = req.user?.role?.toLowerCase() === "superadmin";
    const targetCompanyId = (isSuperAdmin && companyId) ? companyId : req.user?.companyId;

    let sql = `
      SELECT a.*, a.date::text as date_str, a.id as "_id", u.name as user_name, u.name as "userName",
             u.email as user_email, u.department as "userDept", u.department
      FROM attendance a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (req.user && req.user.role === "employee") {
      params.push(req.user.id);
      sql += ` AND a.user_id = $${params.length}`;
    } else if (userId) {
      params.push(userId);
      sql += ` AND a.user_id = $${params.length}`;
    }

    if (targetCompanyId) {
      params.push(targetCompanyId);
      sql += ` AND a.company_id = $${params.length}`;
    }

    if (date) {
      params.push(date);
      sql += ` AND a.date = $${params.length}`;
    }

    if (startDate && endDate) {
      params.push(startDate);
      sql += ` AND a.date >= $${params.length}`;
      params.push(endDate);
      sql += ` AND a.date <= $${params.length}`;
    }

    sql += " ORDER BY a.date DESC, a.check_in DESC LIMIT 1000";
    const result = await query(sql, params);

    
    // Format check_in/check_out/status for client
    const logs = result.rows.map(row => {
      const checkInDate = row.check_in ? new Date(row.check_in) : null;
      const checkOutDate = row.check_out ? new Date(row.check_out) : null;
      const formatTime = (d) => d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : "";
      
      const durationHours = row.duration_minutes ? (row.duration_minutes / 60).toFixed(1) : (row.check_out ? "0.0" : "Live");
      const dateStr = row.date_str || (row.date instanceof Date ? row.date.toISOString().split("T")[0] : (row.date ? String(row.date).split("T")[0] : ""));

      let frontendStatus = "not-checked-in";
      let currentBreakTimerEnd = null;
      if (row.check_out) {
        frontendStatus = "checked-out";
      } else if (Array.isArray(row.breaks) && row.breaks.some(b => !b.end && !b.resumeTime)) {
        frontendStatus = "on-break";
        const activeB = row.breaks.find(b => !b.end && !b.resumeTime);
        if (activeB) {
          const bStart = new Date(activeB.start || activeB.startTime).getTime();
          const bType = activeB.breakType || activeB.type || "short";
          const durSec = bType === "bio" ? 900 : 1800;
          currentBreakTimerEnd = new Date(bStart + durSec * 1000).toISOString();
        }
      } else if (row.check_in) {
        frontendStatus = "checked-in";
      }

      return {
        ...row,
        id: row.id,
        userId: row.user_id,
        companyId: row.company_id,
        date: dateStr,
        checkIn: formatTime(checkInDate),
        checkOut: formatTime(checkOutDate),
        checkInTime: row.check_in,
        checkOutTime: row.check_out,
        checkInLocation: row.check_in_location || row.location,
        checkOutLocation: row.check_out_location,
        totalHours: durationHours,
        status: frontendStatus,
        currentBreakTimerEnd
      };
    });

    res.json(logs);
  } catch (err) {
    console.error("getAttendance error:", err);
    res.status(500).json({ error: "Failed to fetch attendance logs." });
  }
};

export const checkIn = async (req, res) => {
  try {
    let userId = req.user?.id || req.body.userId;
    if (typeof userId === "object" && userId !== null) {
      userId = userId.uid || userId.id;
    }
    const companyId = req.user?.companyId || req.body.companyId || req.body.userId?.companyId;
    const today = req.body.date || new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();
    const { location, workMode = "office", verificationSessionToken } = req.body;

    if (!verificationSessionToken) {
      return res.status(400).json({
        error: "Biometric verification is required. Please capture a selfie to check in."
      });
    }

    // Server-side geofence validation before database transaction
    const geoCheck = await validateServerGeofence({ companyId, location, user: req.user });
    if (!geoCheck.allowed) {
      return res.status(400).json({
        error: geoCheck.reason || "Check-in denied: You are outside the permitted workplace area."
      });
    }

    const tokenHash = hashToken(verificationSessionToken);
    const recordId = `${userId}_${today}`;

    // Execute session consumption and attendance mutation atomically using withTransaction
    const txResult = await withTransaction(async (client) => {
      // 1. Atomically consume the verification session token for this user, company, action, and unexpired validity
      const sessionRes = await client.query(
        `UPDATE attendance_verification_sessions
         SET status = 'consumed', consumed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE token_hash = $1
           AND user_id = $2
           AND company_id = $3
           AND status = 'issued'
           AND expires_at > CURRENT_TIMESTAMP
           AND (action_type IS NULL OR action_type = 'check-in')
         RETURNING *`,
        [tokenHash, userId, companyId]
      );

      if (sessionRes.rows.length === 0) {
        const err = new Error("Biometric verification session is invalid, expired, or has already been used. Please capture a fresh selfie.");
        err.statusCode = 403;
        err.isSessionReplay = true;
        throw err;
      }

      // 2. Perform attendance database mutation using the exact same PostgreSQL client
      const result = await client.query(
        `INSERT INTO attendance (id, user_id, company_id, date, check_in, status, work_mode, check_in_location, location)
         VALUES ($1, $2, $3, $4, $5, 'present', $6, $7, $7)
         ON CONFLICT (id) DO UPDATE SET
           check_in = COALESCE(attendance.check_in, EXCLUDED.check_in),
           check_out = NULL,
           status = 'present',
           check_in_location = EXCLUDED.check_in_location,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [recordId, userId, companyId, today, now, workMode, JSON.stringify(location || {})]
      );

      return {
        session: sessionRes.rows[0],
        attendance: result.rows[0]
      };
    });

    const row = txResult.attendance;
    const checkInDate = row.check_in ? new Date(row.check_in) : new Date();
    const formatTime = (d) => d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : "";

    // Audit logging executes outside the transaction, preserving asynchronous non-blocking behavior
    auditService.logAudit({
      userId,
      action: "ATTENDANCE_CLOCK_IN",
      resourceType: "attendance",
      resourceId: row.id,
      details: { date: today, workMode, location, verificationSessionId: txResult.session.id },
      req
    });

    return res.json({
      ...row,
      id: row.id,
      userId: row.user_id,
      companyId: row.company_id,
      date: today,
      checkIn: formatTime(checkInDate),
      checkInTime: row.check_in || now,
      checkInLocation: row.check_in_location || row.location,
      status: "checked-in"
    });
  } catch (err) {
    if (err.isSessionReplay || err.statusCode === 403) {
      let userId = req.user?.id || req.body.userId;
      if (typeof userId === "object" && userId !== null) userId = userId.uid || userId.id;
      const tokenHash = req.body?.verificationSessionToken ? hashToken(req.body.verificationSessionToken) : "unknown";

      auditService.logAudit({
        userId,
        action: "ATTENDANCE_VERIFICATION_REPLAY_REJECTED",
        resourceType: "attendance",
        resourceId: `session_${tokenHash.slice(0, 10)}`,
        details: { reason: "Invalid, expired, or already-consumed verification token", action: "check-in" },
        req
      });

      return res.status(403).json({
        error: "Biometric verification session is invalid, expired, or has already been used. Please capture a fresh selfie."
      });
    }

    console.error("checkIn error:", err);
    return res.status(500).json({ error: "Check-in failed." });
  }
};

export const checkOut = async (req, res) => {
  try {
    let userId = req.user?.id || req.body.userId;
    if (typeof userId === "object" && userId !== null) {
      userId = userId.uid || userId.id;
    }
    const companyId = req.user?.companyId || req.body.companyId;
    const today = req.body.date || new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();
    const { location, verificationSessionToken } = req.body;

    if (!verificationSessionToken) {
      return res.status(400).json({
        error: "Biometric verification is required. Please capture a selfie to check out."
      });
    }

    const tokenHash = hashToken(verificationSessionToken);
    const recordId = `${userId}_${today}`;

    // Execute prerequisite check, session consumption, and attendance update atomically inside withTransaction
    const txResult = await withTransaction(async (client) => {
      // 1. Prerequisite check: confirm that a valid check-in exists before checking out
      const existing = await client.query("SELECT * FROM attendance WHERE id = $1 FOR UPDATE", [recordId]);
      if (existing.rows.length === 0 || !existing.rows[0].check_in) {
        const err = new Error("No check-in found for today.");
        err.statusCode = 404;
        throw err;
      }

      // 2. Atomically consume the verification session token for this user, company, action, and unexpired validity
      const sessionRes = await client.query(
        `UPDATE attendance_verification_sessions
         SET status = 'consumed', consumed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE token_hash = $1
           AND user_id = $2
           AND company_id = $3
           AND status = 'issued'
           AND expires_at > CURRENT_TIMESTAMP
           AND (action_type IS NULL OR action_type = 'check-out')
         RETURNING *`,
        [tokenHash, userId, companyId]
      );

      if (sessionRes.rows.length === 0) {
        const err = new Error("Biometric verification session is invalid, expired, or has already been used. Please capture a fresh selfie.");
        err.statusCode = 403;
        err.isSessionReplay = true;
        throw err;
      }

      const rowData = existing.rows[0];
      let durationMinutes = 0;
      const breaks = Array.isArray(rowData.breaks) ? [...rowData.breaks] : [];
      let totalBreakMinutes = 0;

      breaks.forEach(b => {
        if (b.start && b.end) {
          totalBreakMinutes += Math.max(0, Math.floor((new Date(b.end) - new Date(b.start)) / 60000));
        } else if (b.start && !b.end) {
          b.end = now;
          const dur = Math.max(0, Math.floor((new Date(now) - new Date(b.start)) / 60000));
          b.durationMinutes = dur;
          totalBreakMinutes += dur;
        }
      });

      if (rowData.check_in) {
        const checkInTime = new Date(rowData.check_in);
        const rawElapsed = Math.max(0, Math.floor((new Date(now) - checkInTime) / 60000));
        durationMinutes = Math.max(0, rawElapsed - totalBreakMinutes);
      }

      const checkoutStatus = durationMinutes < 240 ? "half-day" : "present";

      const result = await client.query(
        `UPDATE attendance
         SET check_out = $1, check_out_location = $2, duration_minutes = $3, breaks = $4, status = $5, updated_at = CURRENT_TIMESTAMP
         WHERE id = $6
         RETURNING *`,
        [now, JSON.stringify(location || {}), durationMinutes, JSON.stringify(breaks), checkoutStatus, recordId]
      );

      return {
        session: sessionRes.rows[0],
        attendance: result.rows[0],
        durationMinutes
      };
    });

    const row = txResult.attendance;
    const checkOutDate = row.check_out ? new Date(row.check_out) : new Date();
    const formatTime = (d) => d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : "";

    // Audit logging executes outside the transaction, preserving asynchronous non-blocking behavior
    auditService.logAudit({
      userId: row.user_id,
      action: "ATTENDANCE_CLOCK_OUT",
      resourceType: "attendance",
      resourceId: row.id,
      details: { date: today, totalWorkingMinutes: txResult.durationMinutes, verificationSessionId: txResult.session.id },
      req
    });

    return res.json({
      ...row,
      id: row.id,
      userId: row.user_id,
      companyId: row.company_id,
      date: today,
      checkOut: formatTime(checkOutDate),
      checkOutTime: row.check_out || now,
      totalWorkingMinutes: txResult.durationMinutes,
      workingDuration: txResult.durationMinutes,
      status: "checked-out"
    });
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: err.message || "No check-in found for today." });
    }

    if (err.isSessionReplay || err.statusCode === 403) {
      let userId = req.user?.id || req.body.userId;
      if (typeof userId === "object" && userId !== null) userId = userId.uid || userId.id;
      const tokenHash = req.body?.verificationSessionToken ? hashToken(req.body.verificationSessionToken) : "unknown";

      auditService.logAudit({
        userId,
        action: "ATTENDANCE_VERIFICATION_REPLAY_REJECTED",
        resourceType: "attendance",
        resourceId: `session_${tokenHash.slice(0, 10)}`,
        details: { reason: "Invalid, expired, or already-consumed verification token", action: "check-out" },
        req
      });

      return res.status(403).json({
        error: "Biometric verification session is invalid, expired, or has already been used. Please capture a fresh selfie."
      });
    }

    console.error("checkOut error:", err);
    return res.status(500).json({ error: "Check-out failed." });
  }
};


export const startBreak = async (req, res) => {
  try {
    let userId = req.user?.id || req.body.userId;
    if (typeof userId === "object" && userId !== null) {
      userId = userId.uid || userId.id;
    }
    const today = req.body.date || new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();
    const { breakType = "short", reason = "break", location } = req.body;

    const recordId = `${userId}_${today}`;
    const existing = await query("SELECT * FROM attendance WHERE id = $1", [recordId]);
    if (existing.rows.length === 0 || !existing.rows[0].check_in) {
      return res.status(400).json({ error: "Cannot start a break without checking in first." });
    }
    if (existing.rows[0].check_out) {
      return res.status(400).json({ error: "Cannot start a break after checking out." });
    }

    const row = existing.rows[0];
    const breaks = Array.isArray(row.breaks) ? [...row.breaks] : [];
    if (breaks.some(b => !b.end && !b.resumeTime)) {
      return res.status(400).json({ error: "A break is already in progress." });
    }

    // Daily 3-break limit check
    if (breaks.length >= 3) {
      return res.status(400).json({ error: "Maximum limit reached. An employee can only take up to 3 breaks per day." });
    }

    // Check if this specific break has already been taken and resumed
    const normalizedReqType = String(breakType).toLowerCase();
    const isTypeAlreadyUsed = breaks.some(b => {
      const bType = String(b.breakType || b.type || "").toLowerCase();
      const isResumed = Boolean(b.end || b.resumeTime);
      if (!isResumed) return false;

      if (normalizedReqType === "short" || normalizedReqType === "break1") {
        return bType === "short" || bType === "break1";
      }
      if (normalizedReqType === "long" || normalizedReqType === "break2") {
        return bType === "long" || bType === "break2";
      }
      if (normalizedReqType === "bio" || normalizedReqType === "break3") {
        return bType === "bio" || bType === "break3";
      }
      return bType === normalizedReqType;
    });

    if (isTypeAlreadyUsed) {
      return res.status(400).json({ error: "This break has already been taken and resumed today. It has been removed from your available breaks." });
    }

    let durationSeconds = 1800; // default 30 mins
    if (normalizedReqType === "bio" || normalizedReqType === "break3") durationSeconds = 900; // 15 mins
    const timerEnd = new Date(Date.now() + durationSeconds * 1000).toISOString();

    breaks.push({
      start: now,
      startTime: now,
      end: null,
      resumeTime: null,
      breakType,
      type: breakType,
      reason,
      location: location || null
    });

    const result = await query(
      `UPDATE attendance
       SET breaks = $1, status = 'on-break', updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(breaks), recordId]
    );

    const updated = result.rows[0];

    // Non-blocking Audit Log: Break Started
    auditService.logAudit({
      userId,
      action: "ATTENDANCE_BREAK_START",
      resourceType: "attendance",
      resourceId: recordId,
      details: {
        breakNumber: breaks.length,
        breakType,
        startTime: now,
        durationMinutes: durationSeconds / 60,
        remainingBreaksAfterThis: Math.max(0, 3 - breaks.length),
        location: location || null
      },
      req
    });

    res.json({
      ...updated,
      id: updated.id,
      userId: updated.user_id,
      companyId: updated.company_id,
      date: today,
      checkInTime: updated.check_in,
      checkOutTime: updated.check_out,
      currentBreakTimerEnd: timerEnd,
      status: "on-break",
      breaks: updated.breaks
    });
  } catch (err) {
    console.error("startBreak error:", err);
    res.status(500).json({ error: "Failed to start break." });
  }
};

export const endBreak = async (req, res) => {
  try {
    let userId = req.user?.id || req.body.userId;
    if (typeof userId === "object" && userId !== null) {
      userId = userId.uid || userId.id;
    }
    const today = req.body.date || new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();
    const { location } = req.body;

    const recordId = `${userId}_${today}`;
    const existing = await query("SELECT * FROM attendance WHERE id = $1", [recordId]);
    if (existing.rows.length === 0 || !existing.rows[0].check_in) {
      return res.status(400).json({ error: "No attendance record found for today." });
    }

    const row = existing.rows[0];
    const breaks = Array.isArray(row.breaks) ? [...row.breaks] : [];
    const activeIdx = breaks.findIndex(b => !b.end && !b.resumeTime);
    if (activeIdx === -1) {
      return res.status(400).json({ error: "No active break to resume from." });
    }

    const breakStart = new Date(breaks[activeIdx].start || breaks[activeIdx].startTime);
    const breakDurationMinutes = Math.max(0, Math.floor((new Date(now) - breakStart) / 60000));
    breaks[activeIdx].end = now;
    breaks[activeIdx].resumeTime = now;
    breaks[activeIdx].durationMinutes = breakDurationMinutes;
    breaks[activeIdx].duration = breakDurationMinutes;
    if (location) breaks[activeIdx].endLocation = location;

    const result = await query(
      `UPDATE attendance
       SET breaks = $1, status = 'present', updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(breaks), recordId]
    );

    const updated = result.rows[0];

    // Non-blocking Audit Log: Break Resumed
    const completedBreak = breaks[activeIdx];
    const totalCompletedBreaks = breaks.filter(b => b.end || b.resumeTime).length;
    auditService.logAudit({
      userId: row.user_id,
      action: "ATTENDANCE_BREAK_RESUME",
      resourceType: "attendance",
      resourceId: recordId,
      details: {
        breakNumber: activeIdx + 1,
        breakType: completedBreak.breakType || completedBreak.type,
        startTime: completedBreak.start || completedBreak.startTime,
        resumeTime: now,
        durationMinutes: breakDurationMinutes,
        totalCompletedBreaks,
        remainingBreaks: Math.max(0, 3 - totalCompletedBreaks),
        location: location || null
      },
      req
    });

    res.json({
      ...updated,
      id: updated.id,
      userId: updated.user_id,
      companyId: updated.company_id,
      date: today,
      checkInTime: updated.check_in,
      checkOutTime: updated.check_out,
      status: "checked-in",
      breaks: updated.breaks
    });
  } catch (err) {
    console.error("endBreak error:", err);
    res.status(500).json({ error: "Failed to end break." });
  }
};

export const updateAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const callerRole = req.user?.role?.toLowerCase();
    const isAllowed = callerRole === "admin" || callerRole === "superadmin" || callerRole === "manager" || callerRole === "system admin";

    if (!isAllowed) {
      return res.status(403).json({ error: "Access forbidden. Admin or Manager role required to edit attendance records." });
    }

    const { checkIn, checkOut, status, date } = req.body;

    const result = await query(
      `UPDATE attendance
       SET check_in = COALESCE($1, check_in),
           check_out = COALESCE($2, check_out),
           status = COALESCE($3, status),
           date = COALESCE($4, date),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING *`,
      [checkIn || null, checkOut || null, status || null, date || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found." });
    }

    const updatedRow = result.rows[0];
    auditService.logAudit({
      userId: req.user?.id,
      action: "ATTENDANCE_EDIT",
      resourceType: "attendance",
      resourceId: id,
      details: { checkIn, checkOut, status, date, targetUserId: updatedRow.user_id },
      req
    });
    securityDetector.checkSuspiciousAction({
      userId: req.user?.id,
      action: "ATTENDANCE_EDIT",
      resourceType: "attendance",
      details: { checkIn, checkOut, status, date, targetUserId: updatedRow.user_id },
      req
    });

    res.json(updatedRow);
  } catch (err) {
    console.error("updateAttendance error:", err);
    res.status(500).json({ error: "Failed to update attendance." });
  }
};

export const deleteAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const callerRole = req.user?.role?.toLowerCase();
    const isAllowed = callerRole === "admin" || callerRole === "superadmin" || callerRole === "system admin";

    if (!isAllowed) {
      return res.status(403).json({ error: "Access forbidden. Admin role required to delete attendance records." });
    }

    const result = await query("DELETE FROM attendance WHERE id = $1 RETURNING id", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found." });
    }
    res.json({ message: "Attendance record deleted.", id });
  } catch (err) {
    console.error("deleteAttendance error:", err);
    res.status(500).json({ error: "Failed to delete attendance record." });
  }

};

// Rules
export const getAttendanceRules = async (req, res) => {
  try {
    const { companyId } = req.query;
    const targetCompanyId = companyId || req.user?.companyId;

    if (targetCompanyId) {
      const compResult = await query("SELECT value FROM settings WHERE key = $1", [`attendance_rules_${targetCompanyId}`]);
      if (compResult.rows.length > 0) {
        const val = compResult.rows[0].value;
        return res.json({ rules: typeof val === "object" && val !== null ? (val.rules || "") : (val || "") });
      }
    }

    const result = await query("SELECT value FROM settings WHERE key = 'attendance_rules'");
    if (result.rows.length > 0) {
      const val = result.rows[0].value;
      res.json({ rules: typeof val === "object" && val !== null ? (val.rules || "") : (val || "") });
    } else {
      res.json({ rules: "" });
    }
  } catch (err) {
    console.error("getAttendanceRules error:", err);
    res.status(500).json({ error: "Failed to fetch attendance rules." });
  }
};

export const updateAttendanceRules = async (req, res) => {
  try {
    const { rules, companyId } = req.body;
    const targetCompanyId = companyId || req.user?.companyId;

    if (targetCompanyId) {
      await query(
        `INSERT INTO settings (key, value)
         VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        [`attendance_rules_${targetCompanyId}`, JSON.stringify({ rules })]
      );
    }

    await query(
      `INSERT INTO settings (key, value)
       VALUES ('attendance_rules', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [JSON.stringify({ rules })]
    );

    res.json({ success: true, rules });
  } catch (err) {
    console.error("updateAttendanceRules error:", err);
    res.status(500).json({ error: "Failed to update attendance rules." });
  }
};

// ============================================================================
// BIOMETRIC FACE ENROLLMENT & MANAGEMENT
// ============================================================================

export const getFaceStatus = async (req, res) => {
  try {
    const targetUserId = req.query.userId || req.user.id;
    const role = (req.user?.role || "").toLowerCase();
    const isSuperAdmin = role === "superadmin";
    const isAdmin = role === "admin" || role === "hr manager" || role === "system admin";

    // Non-admins can only query their own status
    if (targetUserId !== req.user.id && !isAdmin && !isSuperAdmin) {
      return res.status(403).json({ error: "Access denied. Cannot view biometrics for other employees." });
    }

    const companyId = req.user.companyId;
    let sql = "SELECT * FROM employee_face_profiles WHERE user_id = $1";
    const params = [targetUserId];

    if (!isSuperAdmin && companyId) {
      sql += " AND company_id = $2";
      params.push(companyId);
    }

    const result = await query(sql, params);
    if (result.rows.length === 0) {
      return res.json({
        user_id: targetUserId,
        enrollment_status: "pending",
        is_enrolled: false,
        metadata: {}
      });
    }

    const row = result.rows[0];
    res.json({
      id: row.id,
      user_id: row.user_id,
      company_id: row.company_id,
      enrollment_status: row.enrollment_status,
      is_enrolled: row.enrollment_status === "enrolled",
      embedding_model: row.embedding_model,
      enrolled_at: row.enrolled_at,
      consent_recorded_at: row.consent_recorded_at,
      metadata: row.metadata || {}
    });
  } catch (err) {
    console.error("getFaceStatus error:", err);
    res.status(500).json({ error: "Failed to fetch biometric enrollment status." });
  }
};

export const authorizeFaceEnrollment = async (req, res) => {
  try {
    const { targetUserId } = req.body;
    if (!targetUserId) {
      return res.status(400).json({ error: "targetUserId is required." });
    }

    const role = (req.user?.role || "").toLowerCase();
    const isSuperAdmin = role === "superadmin";
    const isAdmin = role === "admin" || role === "hr manager" || role === "system admin";

    if (!isAdmin && !isSuperAdmin) {
      return res.status(403).json({ error: "Only administrators and HR personnel can authorize face enrollment." });
    }

    const companyId = req.user.companyId;

    // Validate target user exists and belongs to tenant
    const userCheck = await query("SELECT id, name, email, company_id FROM users WHERE id = $1", [targetUserId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "Target employee not found." });
    }

    const targetUser = userCheck.rows[0];
    if (!isSuperAdmin && targetUser.company_id !== companyId) {
      return res.status(403).json({ error: "Access denied. Target employee belongs to another organization." });
    }

    const profileId = `${targetUserId}_profile`;
    const now = new Date().toISOString();

    await query(
      `INSERT INTO employee_face_profiles (id, user_id, company_id, enrollment_status, metadata, updated_at)
       VALUES ($1, $2, $3, 'pending', $4, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET
         metadata = COALESCE(employee_face_profiles.metadata, '{}'::jsonb) || $4,
         updated_at = CURRENT_TIMESTAMP`,
      [
        profileId,
        targetUserId,
        targetUser.company_id || companyId,
        JSON.stringify({
          selfEnrollmentAuthorized: true,
          authorizedAt: now,
          authorizedBy: req.user.id
        })
      ]
    );

    auditService.logAudit({
      userId: req.user.id,
      action: "BIOMETRIC_ENROLLMENT_AUTHORIZED",
      resourceType: "biometrics",
      resourceId: profileId,
      details: { targetUserId, authorizedBy: req.user.id },
      req
    });

    res.json({
      success: true,
      message: "Face self-enrollment authorized successfully for employee.",
      targetUserId
    });
  } catch (err) {
    console.error("authorizeFaceEnrollment error:", err);
    res.status(500).json({ error: "Failed to authorize face enrollment." });
  }
};

export const enrollFace = async (req, res) => {
  try {
    const { imageBase64, consentGiven, biometricConsent, targetUserId, userId } = req.body;
    const consent = consentGiven !== undefined ? consentGiven : (biometricConsent !== undefined ? biometricConsent : true);
    const resolvedTargetId = targetUserId || userId || req.user.id;
    const isSelf = resolvedTargetId === req.user.id;
    const role = (req.user?.role || "").toLowerCase();
    const isSuperAdmin = role === "superadmin";
    const isAdmin = role === "admin" || isSuperAdmin || role === "hr manager";

    // Check enrollment permission: only admin or self-enroller
    if (!isSelf && !isAdmin) {
      return res.status(403).json({ error: "Unauthorized: Cannot enroll face biometrics for another user." });
    }

    let targetCompanyId = req.user.companyId;

    // Admin enrolling employee: validate target employee identity and company isolation
    if (!isSelf) {
      const userCheck = await query(
        "SELECT id, name, email, company_id, status FROM users WHERE id = $1",
        [resolvedTargetId]
      );
      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: "Target employee not found." });
      }
      const targetUser = userCheck.rows[0];
      if (!isSuperAdmin && targetUser.company_id !== req.user.companyId) {
        return res.status(403).json({
          error: "Access denied. Target employee belongs to another organization.",
          code: "CROSS_TENANT_ACCESS_DENIED"
        });
      }
      targetCompanyId = targetUser.company_id || req.user.companyId;
    }

    // If self-enrollment, confirm employee has been authorized and prevent unauthorized self-replacement
    if (isSelf && !isAdmin) {
      const profileCheck = await query(
        "SELECT metadata, enrollment_status FROM employee_face_profiles WHERE user_id = $1 AND company_id = $2",
        [req.user.id, targetCompanyId]
      );
      const profileRow = profileCheck.rows[0];
      const isAuthorized = Boolean(profileRow?.metadata?.selfEnrollmentAuthorized);

      if (!isAuthorized) {
        return res.status(403).json({
          error: "Face self-enrollment has not been authorized by HR or an Administrator.",
          code: "SELF_ENROLLMENT_NOT_AUTHORIZED"
        });
      }

      // Prevent replacing already-enrolled face unless explicitly re-authorized
      if (profileRow?.enrollment_status === "enrolled" && !profileRow?.metadata?.reenrollmentAuthorized) {
        return res.status(403).json({
          error: "Face template is already enrolled. Self-replacement is not permitted. Please contact your administrator.",
          code: "SELF_ENROLLMENT_NOT_AUTHORIZED"
        });
      }
    }

    // Biometric consent check
    const validation = validateEnrollmentPayload({ imageBase64, consentGiven: consent });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    // Call Python microservice
    let microserviceResult;
    try {
      microserviceResult = await faceServiceClient.enrollFace(imageBase64);
    } catch (svcErr) {
      auditService.logAudit({
        userId: req.user.id,
        action: "BIOMETRIC_ENROLLMENT_FAILED",
        resourceType: "biometrics",
        resourceId: resolvedTargetId,
        details: { reason: svcErr.message, targetUserId: resolvedTargetId },
        status: "FAILURE",
        severity: "WARNING",
        req
      });
      return res.status(svcErr.status || 400).json({ error: svcErr.message });
    }

    const { embedding, model, embedding_dimension, quality_score, face_count } = microserviceResult;

    if (!isValidEmbedding(embedding, 512)) {
      return res.status(500).json({ error: "Biometric service generated an invalid face embedding vector." });
    }

    const profileId = `${resolvedTargetId}_profile`;
    const now = new Date().toISOString();

    await query(
      `INSERT INTO employee_face_profiles (
         id, user_id, company_id, enrollment_status, face_embedding,
         embedding_model, embedding_dimension, enrolled_by, enrolled_at,
         consent_recorded_at, metadata, updated_at
       ) VALUES ($1, $2, $3, 'enrolled', $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $8, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET
         enrollment_status = 'enrolled',
         face_embedding = EXCLUDED.face_embedding,
         embedding_model = EXCLUDED.embedding_model,
         embedding_dimension = EXCLUDED.embedding_dimension,
         enrolled_by = EXCLUDED.enrolled_by,
         enrolled_at = CURRENT_TIMESTAMP,
         consent_recorded_at = CURRENT_TIMESTAMP,
         metadata = COALESCE(employee_face_profiles.metadata, '{}'::jsonb) || EXCLUDED.metadata,
         updated_at = CURRENT_TIMESTAMP`,
      [
        profileId,
        resolvedTargetId,
        targetCompanyId,
        JSON.stringify(embedding),
        model || "ArcFace",
        embedding_dimension || 512,
        req.user.id,
        JSON.stringify({
          qualityScore: quality_score,
          faceCount: face_count,
          enrolledByRole: req.user.role,
          consentRecorded: true,
          enrolledBy: req.user.id
        })
      ]
    );

    auditService.logAudit({
      userId: req.user.id,
      action: "BIOMETRIC_ENROLLMENT_SUCCESS",
      resourceType: "biometrics",
      resourceId: profileId,
      details: { targetUserId: resolvedTargetId, enrolledBy: req.user.id, model: model || "ArcFace" },
      req
    });

    res.json({
      success: true,
      enrollment_status: "enrolled",
      enrolled_at: now,
      model: model || "ArcFace"
    });
  } catch (err) {
    console.error("enrollFace error:", err);
    res.status(500).json({ error: "Internal server error during face enrollment." });
  }
};

export const revokeFaceEnrollment = async (req, res) => {
  try {
    const { targetUserId, userId, reason = "Administrator revocation" } = req.body;
    const resolvedTargetId = targetUserId || userId || req.user.id;
    const isSelf = resolvedTargetId === req.user.id;
    const role = (req.user?.role || "").toLowerCase();
    const isSuperAdmin = role === "superadmin";
    const isAdmin = role === "admin" || isSuperAdmin || role === "hr manager";

    // Only self or authorized admin can revoke
    if (!isSelf && !isAdmin) {
      return res.status(403).json({ error: "Access denied. Cannot revoke biometric profile for another user." });
    }

    let targetCompanyId = req.user.companyId;
    if (!isSelf) {
      const userCheck = await query("SELECT id, company_id FROM users WHERE id = $1", [resolvedTargetId]);
      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: "Target employee not found." });
      }
      if (!isSuperAdmin && userCheck.rows[0].company_id !== req.user.companyId) {
        return res.status(403).json({ error: "Access denied. Target employee belongs to another organization." });
      }
      targetCompanyId = userCheck.rows[0].company_id || req.user.companyId;
    }

    await query(
      `UPDATE employee_face_profiles
       SET enrollment_status = 'suspended',
           face_embedding = NULL,
           reenrollment_requested_at = CURRENT_TIMESTAMP,
           reenrollment_reason = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $2 AND company_id = $3`,
      [reason, resolvedTargetId, targetCompanyId]
    );

    auditService.logAudit({
      userId: req.user.id,
      action: "BIOMETRIC_ENROLLMENT_REVOKED",
      resourceType: "biometrics",
      resourceId: `${resolvedTargetId}_profile`,
      details: { targetUserId: resolvedTargetId, reason },
      req
    });

    res.json({ success: true, message: "Biometric template revoked successfully." });
  } catch (err) {
    console.error("revokeFaceEnrollment error:", err);
    res.status(500).json({ error: "Failed to revoke biometric template." });
  }
};

export const getVerificationAttempts = async (req, res) => {
  try {
    const role = (req.user?.role || "").toLowerCase();
    const isSuperAdmin = role === "superadmin";
    const isAdmin = role === "admin" || role === "hr manager";

    if (!isAdmin && !isSuperAdmin) {
      return res.status(403).json({ error: "Access denied. Admin role required." });
    }

    const companyId = req.user.companyId;
    const { status, limit = 50 } = req.query;

    let sql = `
      SELECT ava.*, u.name as user_name, u.email as user_email
      FROM attendance_verification_attempts ava
      LEFT JOIN users u ON ava.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (!isSuperAdmin && companyId) {
      params.push(companyId);
      sql += ` AND ava.company_id = $${params.length}`;
    }

    if (status) {
      params.push(status);
      sql += ` AND ava.status = $${params.length}`;
    }

    sql += ` ORDER BY ava.attempted_at DESC LIMIT $${params.length + 1}`;
    params.push(Math.min(Number(limit) || 50, 100));

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error("getVerificationAttempts error:", err);
    res.status(500).json({ error: "Failed to fetch verification attempts." });
  }
};

export const reviewVerificationAttempt = async (req, res) => {
  try {
    const { attemptId, decision, note } = req.body;
    if (!attemptId || !decision) {
      return res.status(400).json({ error: "attemptId and decision are required." });
    }

    const role = (req.user?.role || "").toLowerCase();
    const isSuperAdmin = role === "superadmin";
    const isAdmin = role === "admin" || role === "hr manager";

    if (!isAdmin && !isSuperAdmin) {
      return res.status(403).json({ error: "Access denied. Admin role required." });
    }

    const companyId = req.user.companyId;
    const result = await query(
      `UPDATE attendance_verification_attempts
       SET review_status = $1,
           reviewed_by = $2,
           reviewed_at = CURRENT_TIMESTAMP,
           review_decision = $1,
           review_note = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 ${!isSuperAdmin ? "AND company_id = $5" : ""}
       RETURNING *`,
      !isSuperAdmin ? [decision, req.user.id, note || "", attemptId, companyId] : [decision, req.user.id, note || "", attemptId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Verification attempt not found." });
    }

    auditService.logAudit({
      userId: req.user.id,
      action: "ATTENDANCE_VERIFICATION_REVIEWED",
      resourceType: "biometrics",
      resourceId: attemptId,
      details: { decision, note },
      req
    });

    res.json({ success: true, attempt: result.rows[0] });
  } catch (err) {
    console.error("reviewVerificationAttempt error:", err);
    res.status(500).json({ error: "Failed to review verification attempt." });
  }
};

export const createVerificationSession = async (req, res) => {
  const attemptId = "ava_" + crypto.randomUUID();
  const userId = req.user?.id;
  const companyId = req.user?.companyId;
  const { imageBase64, workMode = "office", location = {}, actionType = "check-in" } = req.body;

  if (!userId || !companyId) {
    return res.status(401).json({ error: "Authenticated session required." });
  }

  if (!imageBase64) {
    return res.status(400).json({ error: "Selfie image is required for biometric verification." });
  }

  // 1. Check face profile enrollment status
  let profile;
  try {
    const profileRes = await query(
      `SELECT * FROM employee_face_profiles WHERE user_id = $1 AND company_id = $2`,
      [userId, companyId]
    );
    profile = profileRes.rows[0];
  } catch (dbErr) {
    console.error("Error querying employee face profile:", dbErr);
    return res.status(500).json({ error: "Database error checking biometric enrollment." });
  }

  if (!profile || profile.enrollment_status !== "enrolled" || !profile.face_embedding) {
    // Record failed attempt
    try {
      await query(
        `INSERT INTO attendance_verification_attempts (
           id, user_id, company_id, work_mode, status, failure_category,
           gps_result, face_result, liveness_result, model, metadata
         ) VALUES ($1, $2, $3, $4, 'failed', 'enrollment_missing', 'not_checked', 'not_checked', 'not_checked', 'ArcFace', $5)`,
        [
          attemptId,
          userId,
          companyId,
          workMode,
          JSON.stringify({ actionType, reason: "Employee has not enrolled biometric template" })
        ]
      );
    } catch (insertErr) {
      console.warn("Could not insert failed attempt record:", insertErr.message);
    }

    auditService.logAudit({
      userId,
      action: "ATTENDANCE_VERIFICATION_FAILED",
      resourceType: "biometrics",
      resourceId: attemptId,
      details: { reason: "Missing or unapproved enrollment profile", actionType },
      req
    });

    return res.status(403).json({
      error: "No enrolled face template found. Please complete face enrollment first.",
      code: "ENROLLMENT_REQUIRED"
    });
  }

  // Parse enrolled embedding
  let enrolledEmbedding = profile.face_embedding;
  if (typeof enrolledEmbedding === "string") {
    try {
      enrolledEmbedding = JSON.parse(enrolledEmbedding);
    } catch (e) {
      enrolledEmbedding = null;
    }
  }

  if (!isValidEmbedding(enrolledEmbedding)) {
    return res.status(400).json({
      error: "Enrolled face template is corrupted. Please re-enroll your face.",
      code: "REENROLLMENT_REQUIRED"
    });
  }

  // 2. Validate GPS / workplace geofencing on server (fail-closed)
  let geoCheck;
  try {
    geoCheck = await validateServerGeofence({ companyId, location, user: req.user });
  } catch (geoErr) {
    console.error("Geofence validation error:", geoErr);
    geoCheck = { allowed: false, reason: "Workplace geofencing validation error.", gpsResult: "error" };
  }

  if (!geoCheck.allowed) {
    try {
      await query(
        `INSERT INTO attendance_verification_attempts (
           id, user_id, company_id, work_mode, status, failure_category,
           gps_result, face_result, liveness_result, model, metadata
         ) VALUES ($1, $2, $3, $4, 'failed', 'geofence_rejected', $5, 'not_checked', 'not_checked', 'ArcFace', $6)`,
        [
          attemptId,
          userId,
          companyId,
          workMode,
          geoCheck.gpsResult || "outside",
          JSON.stringify({ actionType, reason: geoCheck.reason, distance: geoCheck.distance })
        ]
      );
    } catch (insertErr) {
      console.warn("Could not insert failed geofence attempt:", insertErr.message);
    }

    auditService.logAudit({
      userId,
      action: "ATTENDANCE_VERIFICATION_FAILED",
      resourceType: "biometrics",
      resourceId: attemptId,
      details: { reason: geoCheck.reason, gpsResult: geoCheck.gpsResult, actionType },
      req
    });

    return res.status(400).json({
      error: geoCheck.reason || "Check-in denied: You are outside the permitted workplace area.",
      code: "GEOFENCE_FAILED"
    });
  }

  // 3. Call biometric microservice to compare selfie with enrolled embedding
  let verifyResult;
  try {
    verifyResult = await faceServiceClient.verifyFace({
      enrolledEmbedding,
      imageBase64
    });
  } catch (err) {
    if (err instanceof FaceServiceUnavailableError) {
      try {
        await query(
          `INSERT INTO attendance_verification_attempts (
             id, user_id, company_id, work_mode, status, failure_category,
             gps_result, face_result, liveness_result, model, metadata
           ) VALUES ($1, $2, $3, $4, 'failed', 'face_service_unavailable', $5, 'not_checked', 'not_checked', 'ArcFace', $6)`,
          [
            attemptId,
            userId,
            companyId,
            workMode,
            geoCheck.gpsResult || "not_required",
            JSON.stringify({ actionType, error: "Biometric service unreachable" })
          ]
        );
      } catch (insertErr) {
        console.warn("Could not insert service outage attempt:", insertErr.message);
      }

      auditService.logAudit({
        userId,
        action: "ATTENDANCE_VERIFICATION_SERVICE_OUTAGE",
        resourceType: "biometrics",
        resourceId: attemptId,
        details: { actionType },
        req
      });

      return res.status(503).json({
        error: "Biometric verification service is temporarily unavailable. Attendance cannot be recorded without biometric verification.",
        code: "BIOMETRIC_SERVICE_UNAVAILABLE"
      });
    }

    // Face service returned verification error (e.g. no face detected, multiple faces, bad image)
    const errorMsg = err.message || "Failed to process face verification.";
    let failureCat = "face_mismatch";
    if (errorMsg.toLowerCase().includes("no face")) failureCat = "no_face";
    else if (errorMsg.toLowerCase().includes("multiple")) failureCat = "multiple_faces";

    try {
      await query(
        `INSERT INTO attendance_verification_attempts (
           id, user_id, company_id, work_mode, status, failure_category,
           gps_result, face_result, liveness_result, model, metadata
         ) VALUES ($1, $2, $3, $4, 'failed', $5, $6, 'not_matched', 'not_checked', 'ArcFace', $7)`,
        [
          attemptId,
          userId,
          companyId,
          workMode,
          failureCat,
          geoCheck.gpsResult || "not_required",
          JSON.stringify({ actionType, error: errorMsg })
        ]
      );
    } catch (insertErr) {
      console.warn("Could not insert verification error attempt:", insertErr.message);
    }

    auditService.logAudit({
      userId,
      action: "ATTENDANCE_VERIFICATION_FAILED",
      resourceType: "biometrics",
      resourceId: attemptId,
      details: { reason: errorMsg, failureCategory: failureCat, actionType },
      req
    });

    return res.status(400).json({ error: errorMsg, code: failureCat.toUpperCase() });
  }

  // 4. Evaluate face match against configured similarity threshold (fail-closed: <= 0.40)
  const matchEval = evaluateFaceMatch(verifyResult);

  if (!matchEval.passed) {
    const failureCat = matchEval.failureCategory || "face_mismatch";
    try {
      await query(
        `INSERT INTO attendance_verification_attempts (
           id, user_id, company_id, work_mode, status, failure_category,
           gps_result, face_result, liveness_result, model, metadata
         ) VALUES ($1, $2, $3, $4, 'failed', $5, $6, 'not_matched', 'not_checked', 'ArcFace', $7)`,
        [
          attemptId,
          userId,
          companyId,
          workMode,
          failureCat,
          geoCheck.gpsResult || "not_required",
          JSON.stringify({
            actionType,
            distance: verifyResult.distance,
            threshold: matchEval.threshold,
            reason: matchEval.reason
          })
        ]
      );
    } catch (insertErr) {
      console.warn("Could not insert mismatch attempt:", insertErr.message);
    }

    auditService.logAudit({
      userId,
      action: "ATTENDANCE_VERIFICATION_FAILED",
      resourceType: "biometrics",
      resourceId: attemptId,
      details: {
        reason: matchEval.reason,
        distance: verifyResult.distance,
        threshold: matchEval.threshold,
        actionType
      },
      req
    });

    return res.status(400).json({
      error: matchEval.reason || "Face verification failed: Selfie does not match the enrolled face.",
      code: "FACE_MISMATCH",
      distance: verifyResult.distance
    });
  }

  // 5. Face matched successfully!
  // Record verified attempt
  try {
    await query(
      `INSERT INTO attendance_verification_attempts (
         id, user_id, company_id, work_mode, status, failure_category,
         gps_result, face_result, liveness_result, model, metadata
       ) VALUES ($1, $2, $3, $4, 'verified', NULL, $5, 'matched', 'not_checked', 'ArcFace', $6)`,
      [
        attemptId,
        userId,
        companyId,
        workMode,
        geoCheck.gpsResult || "not_required",
        JSON.stringify({
          actionType,
          distance: verifyResult.distance,
          threshold: matchEval.threshold,
          liveness_provider: "none",
          anti_spoofing_note: "2D ArcFace similarity check; active liveness presentation-attack detection not configured"
        })
      ]
    );
  } catch (insertErr) {
    console.warn("Could not insert verified attempt:", insertErr.message);
  }

  // Generate single-use verification session token
  const { rawToken, tokenHash } = generateVerificationSessionToken();
  const sessionId = "avs_" + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minute TTL

  await query(
    `INSERT INTO attendance_verification_sessions (
       id, attempt_id, user_id, company_id, token_hash, provider, status, expires_at, action_type
     ) VALUES ($1, $2, $3, $4, $5, 'internal', 'issued', $6, $7)`,
    [sessionId, attemptId, userId, companyId, tokenHash, expiresAt.toISOString(), actionType]
  );

  auditService.logAudit({
    userId,
    action: "ATTENDANCE_VERIFICATION_SUCCESS",
    resourceType: "biometrics",
    resourceId: attemptId,
    details: {
      actionType,
      distance: verifyResult.distance,
      threshold: matchEval.threshold,
      sessionId
    },
    req
  });

  return res.json({
    success: true,
    verified: true,
    verificationSessionToken: rawToken,
    attemptId,
    expiresAt: expiresAt.toISOString(),
    status: "verified",
    liveness_result: "not_checked",
    distance: verifyResult.distance
  });
};


export const adminRevertPenalty = async (req, res) => {
  try {
    const { id } = req.params;
    const { resolutionNotes = "" } = req.body || {};
    const adminId = req.user?.id;
    const userRole = (req.user?.role || "").toLowerCase();

    if (userRole !== "admin" && userRole !== "superadmin") {
      return res.status(403).json({ error: "Only an Admin or Superadmin can resolve compliance penalties and revert attendance." });
    }

    const existingRes = await query("SELECT * FROM attendance WHERE id = $1", [id]);
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found." });
    }

    const record = existingRes.rows[0];

    const result = await query(
      `UPDATE attendance
       SET status = 'present',
           is_admin_locked = FALSE,
           penalty_status = NULL,
           penalty_reason = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    // Unblock the employee's tasks
    await query(
      `UPDATE tasks SET sla_penalty_applied = FALSE, updated_at = NOW() WHERE assigned_to = $1 AND sla_penalty_applied = TRUE`,
      [record.user_id]
    ).catch(() => {});

    const updated = result.rows[0];

    const notifId = "notif_" + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    await query(
      `INSERT INTO notifications (id, user_id, title, message, type, read, link)
       VALUES ($1, $2, $3, $4, 'info', FALSE, '/attendance')`,
      [
        notifId,
        record.user_id,
        "Attendance Penalty Resolved by Admin",
        `Your attendance penalty has been resolved by Admin. Status restored to Present and reporting lock removed.`
      ]
    );

    const io = req.app?.get("io");
    if (io) {
      const payload = {
        attendanceId: id,
        userId: record.user_id,
        status: "present",
        is_admin_locked: false,
        resolutionNotes
      };
      io.to(`user_${record.user_id}`).emit("attendance_penalty_reverted", payload);
      if (record.company_id) io.to(`company_${record.company_id}`).emit("attendance_penalty_reverted", payload);
      io.emit("attendance_penalty_reverted", payload);
    }

    auditService.logAudit({
      userId: adminId,
      action: "ATTENDANCE_PENALTY_REVERT",
      resourceType: "attendance",
      resourceId: id,
      details: { previousPenalty: record.penalty_status, previousReason: record.penalty_reason, resolutionNotes },
      req
    });

    res.json({
      message: "Attendance penalty resolved. Status restored to Present.",
      attendance: updated
    });
  } catch (err) {
    console.error("adminRevertPenalty error:", err);
    res.status(500).json({ error: "Failed to revert attendance penalty." });
  }
};
