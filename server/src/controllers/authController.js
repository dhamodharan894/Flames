import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { query } from "../config/db.js";
import { generateToken } from "../middlewares/auth.js";
import { sendWelcomeEmail, sendPasswordResetEmail, sendOtpEmail } from "../services/emailService.js";
import auditService from "../services/auditService.js";
import sessionService from "../services/sessionService.js";
import securityDetector from "../services/securityDetector.js";

const JWT_SECRET = process.env.JWT_SECRET || "hrms_jwt_super_secret_railway_2026";

const mapUserProfile = (user) => {
  const { password_hash, metadata = {}, ...userProfile } = user;
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const empId = user.employee_id || meta.employeeId || meta.employee_id || "";

  return {
    ...userProfile,
    ...meta,
    uid: user.id,
    id: user.id,
    employeeId: empId,
    employee_id: empId,
    companyId: user.company_id,
    company_id: user.company_id,
    shiftStart: user.shift_start,
    shiftEnd: user.shift_end,
    annualLeaves: Number(user.casual_leave_quota || 25),
    sickLeaves: Number(user.sick_leave_quota || 10),
    casualLeaves: Number(user.paid_leave_quota || 6),
    isProjectManager: user.is_project_manager,
    projects: Array.isArray(user.projects) ? user.projects : (meta.projects || []),
    tasks: Array.isArray(meta.tasks) ? meta.tasks : []
  };
};

export const login = async (req, res) => {
  try {
    const { email, password, companySlug } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    let targetCompany = null;
    if (companySlug && typeof companySlug === "string" && companySlug.trim()) {
      const cleanSlug = companySlug.toLowerCase().trim();
      const compRes = await query(
        "SELECT id, name, slug, status FROM companies WHERE LOWER(slug) = $1 OR LOWER(id) = $1",
        [cleanSlug]
      );
      if (compRes.rows.length === 0) {
        return res.status(404).json({ error: `Organization workspace "${companySlug}" not found.` });
      }
      if (compRes.rows[0].status === "deactive") {
        return res.status(403).json({ error: "This organization workspace has been deactivated." });
      }
      targetCompany = compRes.rows[0];
    }

    const cleanEmail = email.toLowerCase().trim();
    const result = await query(
      "SELECT * FROM users WHERE LOWER(TRIM(email)) = LOWER($1) ORDER BY (password_hash IS NOT NULL) DESC, created_at DESC LIMIT 1",
      [cleanEmail]
    );
    if (result.rows.length === 0) {
      securityDetector.recordFailedLogin(cleanEmail, req);
      auditService.logAudit({
        action: "AUTH_LOGIN_FAILED",
        resourceType: "auth",
        details: { email: cleanEmail, reason: "User not found" },
        status: "FAILURE",
        severity: "WARNING",
        req
      });
      return res.status(401).json({ error: "Invalid credentials. User not found." });
    }

    const user = result.rows[0];

    // If password_hash does not exist, require user to set a password via Forgot Password
    if (!user.password_hash) {
      return res.status(401).json({ error: "Password has not been set for this account. Please use 'Forgot password?' to set your password." });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      securityDetector.recordFailedLogin(cleanEmail, req);
      auditService.logAudit({
        userId: user.id,
        action: "AUTH_LOGIN_FAILED",
        resourceType: "auth",
        details: { email: cleanEmail, reason: "Invalid password" },
        status: "FAILURE",
        severity: "WARNING",
        req
      });
      return res.status(401).json({ error: "Invalid password." });
    }

    // If logging into a specific organization workspace, validate tenant membership
    if (targetCompany) {
      const isSuperAdmin = user.role === "superadmin" || (user.email || "").toLowerCase().includes("superadmin@");
      if (!isSuperAdmin) {
        if (!user.company_id) {
          return res.status(403).json({
            error: "Your account is not linked to any organization workspace. Please contact your administrator."
          });
        }
        if (user.company_id !== targetCompany.id) {
          return res.status(403).json({
            error: `Access denied. Your account belongs to a different organization, not "${targetCompany.name}".`
          });
        }
      }
    }

    // All user types (employees, admins, superadmins, HR managers, project managers, etc.)
    // must complete Email OTP Multi-Factor Authentication before receiving access credentials.
    const registeredEmail = (user.email || "").toLowerCase().trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!registeredEmail || !emailRegex.test(registeredEmail)) {
      return res.status(400).json({
        error: "This account does not have a valid registered email address configured for multi-factor verification. Please contact your administrator to configure a registered email address."
      });
    }

    // Generate 6-digit numeric OTP with leading zeros preserved
    const otp = crypto.randomInt(0, 1000000).toString().padStart(6, "0");
    const pendingId = "mfa_" + crypto.randomUUID();
    const otpHash = crypto.createHash("sha256").update(pendingId + ":" + otp).digest("hex");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // Store in login_otps table
    await query(
      `INSERT INTO login_otps (id, user_id, otp_hash, expires_at, attempts, resend_count, last_sent_at, is_used)
       VALUES ($1, $2, $3, $4, 0, 0, NOW(), FALSE)`,
      [pendingId, user.id, otpHash, expiresAt]
    );

    // Dispatch OTP email via Resend
    const emailResult = await sendOtpEmail({ email: registeredEmail, otp });
    if (!emailResult.success) {
      console.error(`❌ [MFA] Failed to deliver OTP to ${registeredEmail}:`, emailResult.error);
      return res.status(500).json({
        error: "Failed to deliver verification code. Please check your email configuration or try again."
      });
    }

    // Issue restricted pendingToken (rejected by authenticateToken middleware)
    const pendingToken = jwt.sign(
      {
        type: "mfa_pending",
        pending: true,
        userId: user.id,
        pendingId,
        email: user.email,
        expectedCompanyId: targetCompany ? targetCompany.id : undefined
      },
      JWT_SECRET,
      { expiresIn: "5m" }
    );

    auditService.logAudit({
      userId: user.id,
      action: "AUTH_MFA_CHALLENGE_ISSUED",
      resourceType: "auth",
      details: { email: user.email, pendingId, role: user.role },
      req
    });

    return res.json({
      mfaRequired: true,
      pendingToken,
      email: user.email,
      message: "A 6-digit verification code has been sent to your registered email address.",
      ...((!process.env.NODE_ENV || process.env.NODE_ENV === "development") ? { devOtp: otp } : {})
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error during login." });
  }
};

export const verifyOtp = async (req, res) => {
  try {
    const { pendingToken, otp } = req.body;
    if (!pendingToken || !otp) {
      return res.status(400).json({ error: "Pending login token and OTP are required." });
    }

    let decoded;
    try {
      decoded = jwt.verify(pendingToken, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: "Verification session has expired or is invalid. Please log in again." });
    }

    if (decoded.type !== "mfa_pending" || !decoded.pendingId || !decoded.userId) {
      return res.status(401).json({ error: "Invalid pending login session. Please log in again." });
    }

    const cleanOtp = String(otp).trim();
    if (!/^\d{6}$/.test(cleanOtp)) {
      return res.status(400).json({ error: "Please enter a valid 6-digit verification code." });
    }

    const otpRes = await query(
      "SELECT * FROM login_otps WHERE id = $1 AND user_id = $2",
      [decoded.pendingId, decoded.userId]
    );

    if (otpRes.rows.length === 0) {
      return res.status(400).json({ error: "Invalid or expired verification session. Please log in again." });
    }

    const record = otpRes.rows[0];

    if (record.is_used) {
      return res.status(400).json({ error: "This verification code has already been used. Please log in again." });
    }

    if (new Date() > new Date(record.expires_at)) {
      return res.status(400).json({ error: "Verification code has expired. Please request a new one." });
    }

    if (record.attempts >= 5) {
      return res.status(400).json({ error: "Too many failed verification attempts. Please log in again." });
    }

    const candidateHash = crypto.createHash("sha256").update(decoded.pendingId + ":" + cleanOtp).digest("hex");
    if (candidateHash !== record.otp_hash) {
      const newAttempts = record.attempts + 1;
      await query("UPDATE login_otps SET attempts = $1 WHERE id = $2", [newAttempts, decoded.pendingId]);
      const remaining = 5 - newAttempts;
      return res.status(400).json({
        error: remaining > 0
          ? `Invalid verification code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
          : "Invalid verification code. Maximum attempts exceeded. Please log in again."
      });
    }

    // Invalidate OTP (mark as used)
    await query("UPDATE login_otps SET is_used = TRUE WHERE id = $1", [decoded.pendingId]);

    // Retrieve user and complete authentication
    const userRes = await query("SELECT * FROM users WHERE id = $1", [decoded.userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const user = userRes.rows[0];

    // If login was initiated for a specific workspace, verify tenant isolation
    if (decoded.expectedCompanyId) {
      const isSuperAdmin = user.role === "superadmin" || (user.email || "").toLowerCase().includes("superadmin@");
      if (!isSuperAdmin && user.company_id !== decoded.expectedCompanyId) {
        return res.status(403).json({
          error: "Access denied. Your account belongs to a different organization workspace."
        });
      }
    }

    const session = await sessionService.createSession(user.id, req);

    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
      companyId: user.company_id,
      sid: session.sessionId
    });

    auditService.logAudit({
      userId: user.id,
      action: "AUTH_MFA_SUCCESS",
      resourceType: "auth",
      details: { email: user.email, sessionId: session.sessionId },
      req
    });

    const mappedUser = mapUserProfile(user);
    res.json({ token, sessionId: session.sessionId, user: mappedUser });
  } catch (err) {
    console.error("verifyOtp error:", err);
    res.status(500).json({ error: "Internal server error during OTP verification." });
  }
};

export const resendOtp = async (req, res) => {
  try {
    const { pendingToken } = req.body;
    if (!pendingToken) {
      return res.status(400).json({ error: "Pending login token is required." });
    }

    let decoded;
    try {
      decoded = jwt.verify(pendingToken, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: "Verification session has expired. Please log in again." });
    }

    if (decoded.type !== "mfa_pending" || !decoded.pendingId || !decoded.userId) {
      return res.status(401).json({ error: "Invalid pending login session. Please log in again." });
    }

    const otpRes = await query(
      "SELECT * FROM login_otps WHERE id = $1 AND user_id = $2",
      [decoded.pendingId, decoded.userId]
    );

    if (otpRes.rows.length === 0) {
      return res.status(400).json({ error: "Verification session not found. Please log in again." });
    }

    const record = otpRes.rows[0];

    if (record.is_used) {
      return res.status(400).json({ error: "This login session has already been completed. Please log in again." });
    }

    // Check resend cooldown (60 seconds)
    const elapsedSeconds = (Date.now() - new Date(record.last_sent_at).getTime()) / 1000;
    if (elapsedSeconds < 60) {
      const waitSeconds = Math.ceil(60 - elapsedSeconds);
      return res.status(429).json({ error: `Please wait ${waitSeconds} seconds before requesting a new verification code.` });
    }

    // Check maximum resend limit per pending session (limit 3 resends)
    if (record.resend_count >= 3) {
      return res.status(429).json({ error: "Maximum resend limit reached for this session. Please log in again." });
    }

    // Fetch user email
    const userRes = await query("SELECT email FROM users WHERE id = $1", [decoded.userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }
    const userEmail = (userRes.rows[0].email || "").toLowerCase().trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!userEmail || !emailRegex.test(userEmail)) {
      return res.status(400).json({
        error: "This account does not have a valid registered email address configured for multi-factor verification."
      });
    }

    // Generate new OTP and invalidate previous one
    const newOtp = crypto.randomInt(0, 1000000).toString().padStart(6, "0");
    const newOtpHash = crypto.createHash("sha256").update(decoded.pendingId + ":" + newOtp).digest("hex");
    const newExpiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const emailResult = await sendOtpEmail({ email: userEmail, otp: newOtp });
    if (!emailResult.success) {
      return res.status(500).json({
        error: emailResult.error || "Failed to deliver replacement verification code. Please try again."
      });
    }

    await query(
      `UPDATE login_otps 
       SET otp_hash = $1, expires_at = $2, attempts = 0, resend_count = resend_count + 1, last_sent_at = NOW()
       WHERE id = $3`,
      [newOtpHash, newExpiresAt, decoded.pendingId]
    );

    res.json({ message: "A new verification code has been sent to your email address." });
  } catch (err) {
    console.error("resendOtp error:", err);
    res.status(500).json({ error: "Internal server error while resending verification code." });
  }
};


export const register = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      department,
      designation,
      programType,
      shiftStart,
      shiftEnd,
      companyId,
      companySlug,
      role = "employee",
      employeeId
    } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: "Name, email, and password are required." });
    }

    const cleanEmail = email.toLowerCase().trim();

    // 1. Resolve workspace / company
    let targetCompanyId = (companyId || "").trim();

    // If companySlug was provided, resolve to company record
    if (!targetCompanyId && companySlug) {
      const cleanSlug = companySlug.toLowerCase().trim();
      const compRes = await query(
        "SELECT id, status FROM companies WHERE LOWER(slug) = $1 OR LOWER(id) = $1",
        [cleanSlug]
      );
      if (compRes.rows.length === 0) {
        return res.status(404).json({ error: `Workspace '${companySlug}' not found.` });
      }
      if (compRes.rows[0].status === "deactive") {
        return res.status(400).json({ error: "This organization workspace has been deactivated." });
      }
      targetCompanyId = compRes.rows[0].id;
    }

    // Auto-discovery via verified email domain if still no company
    if (!targetCompanyId && cleanEmail.includes("@")) {
      const emailDomain = cleanEmail.split("@")[1];
      const domainRes = await query(
        "SELECT company_id FROM company_domains WHERE LOWER(domain) = $1 AND status = 'VERIFIED' LIMIT 1",
        [emailDomain]
      );
      if (domainRes.rows.length > 0) {
        targetCompanyId = domainRes.rows[0].company_id;
      }
    }

    // Default domain mapping for legacy Carrezza domain
    if (!targetCompanyId && (cleanEmail.endsWith("@teamcarrezza.com") || cleanEmail === "admin@teamcarrezza.com")) {
      const cgsRes = await query("SELECT id FROM companies WHERE id = 'carrezza-global-solutions' OR slug = 'cgs' LIMIT 1");
      if (cgsRes.rows.length > 0) {
        targetCompanyId = cgsRes.rows[0].id;
      }
    }

    // Enforce workspace requirement: Do not create orphaned users with NULL company_id
    if (!targetCompanyId) {
      return res.status(400).json({
        error: "No organization workspace specified. Please register using your company's workspace link (e.g. /:companySlug/register) or create an organization."
      });
    }

    // Validate that the resolved company exists and is active
    const compCheck = await query("SELECT id, status FROM companies WHERE id = $1", [targetCompanyId]);
    if (compCheck.rows.length === 0) {
      return res.status(404).json({ error: "The specified organization workspace does not exist." });
    }
    if (compCheck.rows[0].status === "deactive") {
      return res.status(400).json({ error: "This organization workspace has been deactivated." });
    }

    const existing = await query("SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER($1)", [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "User with this email already exists." });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const userId = "usr_" + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);

    const insertRes = await query(
      `INSERT INTO users (
         id, name, email, password_hash, department, designation, program_type,
         shift_start, shift_end, company_id, role, employee_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, name, email, role, department, company_id, created_at`,
      [
        userId,
        name.trim(),
        cleanEmail,
        passwordHash,
        department || "General",
        designation || null,
        programType || "Full-time",
        shiftStart || "09:00",
        shiftEnd || "18:00",
        targetCompanyId,
        role,
        employeeId || null
      ]
    );

    const newUser = insertRes.rows[0];
    const token = generateToken({
      id: newUser.id,
      email: newUser.email,
      role: newUser.role,
      companyId: newUser.company_id
    });

    // Send welcome email asynchronously
    sendWelcomeEmail({
      email: newUser.email,
      name: newUser.name,
      employeeId: employeeId || null,
      shiftStart: shiftStart || "09:00",
      shiftEnd: shiftEnd || "18:00",
      role: newUser.role
    }).catch(e => console.error("Error sending welcome email:", e));

    res.status(201).json({ token, user: newUser });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Internal server error during registration." });
  }
};

export const getMe = async (req, res) => {
  try {
    const result = await query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }
    const { password_hash, ...userProfile } = result.rows[0];
    res.json({ user: userProfile });
  } catch (err) {
    console.error("getMe error:", err);
    res.status(500).json({ error: "Failed to fetch user profile." });
  }
};

export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email is required." });
    }

    const cleanEmail = email.toLowerCase().trim();
    const result = await query(
      "SELECT id, name, email FROM users WHERE LOWER(TRIM(email)) = LOWER($1) ORDER BY (password_hash IS NOT NULL) DESC, created_at DESC LIMIT 1",
      [cleanEmail]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No account found with this email address." });
    }

    const user = result.rows[0];
    const jwtSecret = process.env.JWT_SECRET || "hrms_jwt_super_secret_railway_2026";

    // Generate a reset token valid for 30 minutes
    const resetToken = jwt.sign(
      { id: user.id, email: user.email, type: "password_reset" },
      jwtSecret,
      { expiresIn: "30m" }
    );

    // Determine client base URL dynamically
    const origin = req.headers.origin || req.headers.referer;
    let baseUrl = process.env.APP_URL || "https://hrms.teamzuna.in";
    if (origin) {
      try {
        const parsed = new URL(origin);
        baseUrl = parsed.origin;
      } catch (e) {
        // use default baseUrl
      }
    }

    const resetUrl = `${baseUrl}/reset-password?token=${resetToken}&email=${encodeURIComponent(user.email)}`;

    // Dispatch email with prompt response protection (returns within 4s while background finishes)
    const emailPromise = sendPasswordResetEmail({
      email: user.email,
      name: user.name,
      resetToken,
      resetUrl
    });

    const emailResult = await Promise.race([
      emailPromise,
      new Promise((resolve) => setTimeout(() => resolve({ success: true, pending: true }), 4000))
    ]);

    if (!emailResult.success && emailResult.reason === "SMTP_NOT_CONFIGURED") {
      return res.status(500).json({ error: "Email service is not configured on the server." });
    }

    if (!emailResult.success && !emailResult.pending) {
      return res.status(500).json({ error: emailResult.error || "Failed to deliver reset email." });
    }

    res.json({ message: "Password reset email sent successfully. Please check your inbox." });
  } catch (err) {
    console.error("forgotPassword error:", err);
    res.status(500).json({ error: "Internal server error while processing password reset." });
  }
};

export const confirmResetPassword = async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: "Token and new password are required." });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters long." });
    }

    const jwtSecret = process.env.JWT_SECRET || "hrms_jwt_super_secret_railway_2026";
    let decoded;
    try {
      decoded = jwt.verify(token, jwtSecret);
    } catch (err) {
      return res.status(400).json({ error: "Password reset link is invalid or has expired. Please request a new one." });
    }

    if (decoded.type !== "password_reset" || !decoded.id) {
      return res.status(400).json({ error: "Invalid password reset token." });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    const updateRes = await query(
      "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 OR LOWER(TRIM(email)) = LOWER($3) RETURNING id, email, name",
      [passwordHash, decoded.id, decoded.email]
    );
    if (updateRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json({ message: "Password has been successfully reset. You can now log in with your new password." });
  } catch (err) {
    console.error("confirmResetPassword error:", err);
    res.status(500).json({ error: "Internal server error while resetting password." });
  }
};

export const logout = async (req, res) => {
  try {
    const sid = req.user?.sid || req.body?.sessionId;
    const userId = req.user?.id;

    if (sid && userId) {
      await sessionService.revokeSession(sid, userId, userId, "User initiated logout");
    }

    auditService.logAudit({
      userId: userId || null,
      action: "AUTH_LOGOUT",
      resourceType: "auth",
      details: { email: req.user?.email, sessionId: sid },
      req
    });

    res.json({ success: true, message: "Logged out successfully." });
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({ error: "Failed to log out cleanly." });
  }
};

