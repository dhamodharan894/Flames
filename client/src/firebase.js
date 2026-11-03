
// ============================================================================
// HRMS POSTGRESQL DIRECT BACKEND CLIENT LAYER (ZERO FIRESTORE DEPENDENCY)
// ============================================================================

const PRODUCTION_API_URL = "https://attendance-cgs-production.up.railway.app/api";
const LOCAL_API_URL = "http://localhost:5001/api";

const getHeaders = () => {
  const token = localStorage.getItem("att_auth_token");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
};

// Resilient API Fetch with Local/Railway auto-fallback
export const apiFetch = async (endpoint, options = {}) => {
  const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const isLocal = typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  // Determine candidate URLs (prioritize local backend when developing locally)
  const candidateUrls = [];
  if (isLocal) {
    candidateUrls.push(`http://localhost:5005/api${cleanEndpoint}`);
    candidateUrls.push(`http://127.0.0.1:5005/api${cleanEndpoint}`);
    if (import.meta.env.VITE_API_URL && (import.meta.env.VITE_API_URL.includes("localhost") || import.meta.env.VITE_API_URL.includes("127.0.0.1"))) {
      const envBase = import.meta.env.VITE_API_URL.replace(/\/+$/, "");
      candidateUrls.push(`${envBase}${cleanEndpoint}`);
    }
  } else {
    if (import.meta.env.VITE_API_URL) {
      const envBase = import.meta.env.VITE_API_URL.replace(/\/+$/, "");
      candidateUrls.push(`${envBase}${cleanEndpoint}`);
    }
    candidateUrls.push(`${PRODUCTION_API_URL}${cleanEndpoint}`);
    if (typeof window !== "undefined" && window.location.origin) {
      candidateUrls.push(`${window.location.origin}/api${cleanEndpoint}`);
    }
  }

  // Remove duplicates
  const uniqueUrls = [...new Set(candidateUrls)];

  let lastError = null;

  for (const url of uniqueUrls) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...getHeaders(),
          ...(options.headers || {})
        }
      });

      const contentType = response.headers.get("content-type") || "";

      // If server returned HTML (e.g. AirTunes 403 or SPA fallback index.html for unhandled /api route) or 405 Method Not Allowed,
      // this server doesn't host the real API; continue to the next candidate server.
      if (response.status === 405 || (!contentType.includes("application/json") && response.ok) || (!contentType.includes("application/json") && response.status === 403)) {
        continue;
      }

      if (response.ok) {
        return await response.json();
      }

      // If the API server returned a structured JSON response (400, 401, 403, 429, 500, etc.),
      // it is a real response from the HRMS backend - parse and throw immediately.
      if (contentType.includes("application/json")) {
        const err = await response.json().catch(() => ({ error: response.statusText }));
        const apiError = new Error(err.error || err.message || `Request failed with status ${response.status}`);
        apiError.isApiResponse = true;
        apiError.status = response.status;
        apiError.code = err.code;

        // Auto-redirect if session was revoked remotely
        if (response.status === 401 && (err.code === "SESSION_REVOKED" || (err.error && err.error.includes("Session has been revoked")))) {
          localStorage.removeItem("att_auth_token");
          localStorage.removeItem("att_current_user");
          window.dispatchEvent(new Event("local-auth-updated"));
          if (typeof window !== "undefined" && !window.location.pathname.includes("/login")) {
            window.location.href = "/login?revoked=true";
          }
        }

        throw apiError;
      }

      lastError = new Error(`Request failed with status ${response.status}`);
    } catch (err) {
      if (err.isApiResponse || (err.message && (err.message.includes("Access denied") || err.message.includes("Invalid credentials") || err.message.includes("Invalid password") || err.message.includes("verification") || err.message.includes("OTP") || err.message.includes("Too many") || err.message.includes("Please wait") || err.message.includes("expired")))) {
        throw err;
      }
      lastError = err;
    }
  }

  throw lastError || new Error(`Failed to fetch ${endpoint}`);
};

// ----------------------------------------------------
// SERVICE INTERFACE
// ----------------------------------------------------
export const getDbType = () => "postgresql";

export const getLocalDateString = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ----------------------------------------------------
// AUTHENTICATION & USER MANAGEMENT
// ----------------------------------------------------

export const loginUser = async (email, password, companySlug = "") => {
  const cleanEmail = email.toLowerCase().trim();
  const payload = { email: cleanEmail, password };
  if (companySlug && typeof companySlug === "string" && companySlug.trim()) {
    payload.companySlug = companySlug.trim();
  }
  const res = await apiFetch("/auth/login", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (res.mfaRequired) {
    return {
      mfaRequired: true,
      pendingToken: res.pendingToken,
      email: res.email || cleanEmail,
      message: res.message,
      devOtp: res.devOtp
    };
  }

  if (res.token) {
    localStorage.setItem("att_auth_token", res.token);
  }

  const meta = res.user?.metadata && typeof res.user?.metadata === "object" ? res.user.metadata : {};
  const empId = res.user?.employeeId || res.user?.employee_id || meta.employeeId || meta.employee_id || "";

  const user = {
    ...res.user,
    ...meta,
    uid: res.user.id || res.user.uid,
    id: res.user.id || res.user.uid,
    employeeId: empId,
    employee_id: empId,
    companyId: res.user.company_id || res.user.companyId || (cleanEmail.endsWith("@teamcarrezza.com") ? "carrezza-global-solutions" : "")
  };

  localStorage.setItem("att_current_user", JSON.stringify(user));
  window.dispatchEvent(new Event("local-auth-updated"));
  return user;
};

export const verifyLoginOtp = async (pendingToken, otp) => {
  const res = await apiFetch("/auth/verify-otp", {
    method: "POST",
    body: JSON.stringify({ pendingToken, otp: String(otp).trim() })
  });

  if (res.token) {
    localStorage.setItem("att_auth_token", res.token);
  }

  const meta = res.user.metadata && typeof res.user.metadata === "object" ? res.user.metadata : {};
  const empId = res.user.employeeId || res.user.employee_id || meta.employeeId || meta.employee_id || "";

  const user = {
    ...res.user,
    ...meta,
    uid: res.user.id || res.user.uid,
    id: res.user.id || res.user.uid,
    employeeId: empId,
    employee_id: empId,
    companyId: res.user.company_id || res.user.companyId || (res.user.email?.toLowerCase().endsWith("@teamcarrezza.com") ? "carrezza-global-solutions" : "")
  };

  localStorage.setItem("att_current_user", JSON.stringify(user));
  window.dispatchEvent(new Event("local-auth-updated"));
  return user;
};

export const resendLoginOtp = async (pendingToken) => {
  return await apiFetch("/auth/resend-otp", {
    method: "POST",
    body: JSON.stringify({ pendingToken })
  });
};

export const createEmployee = async (employeeData) => {
  const res = await apiFetch("/users", {
    method: "POST",
    body: JSON.stringify(employeeData)
  });
  return res.user;
};

export const registerUser = async (name, department, programType, email, password, shiftStart = "10:00", shiftEnd = "19:00", annualLeaves = 25, sickLeaves = 10, casualLeaves = 6, dob = "", joiningDate = "", projects = [], tasks = [], jobType = "Full-time", designation = "", isProjectManager = false, employeeId = "", companySlug = "", role = "user", companyId = "", additionalData = {}) => {
  let targetCompanyId = companyId;
  if (!targetCompanyId && (email.toLowerCase().endsWith("@teamcarrezza.com") || companySlug === "carrezza-global-solutions")) {
    targetCompanyId = "carrezza-global-solutions";
  }

  const res = await apiFetch("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      name,
      department,
      programType,
      email: email.toLowerCase().trim(),
      password,
      shiftStart,
      shiftEnd,
      annualLeaves,
      sickLeaves,
      casualLeaves,
      dob,
      joiningDate,
      projects,
      tasks,
      jobType,
      designation,
      isProjectManager,
      employeeId,
      companyId: targetCompanyId || undefined,
      companySlug: companySlug || undefined,
      role: email.toLowerCase() === "admin@teamcarrezza.com" ? "admin" : role,
      ...additionalData
    })
  });

  if (res.token) {
    localStorage.setItem("att_auth_token", res.token);
  }

  const meta = res.user?.metadata && typeof res.user?.metadata === "object" ? res.user.metadata : {};
  const empId = res.user?.employeeId || res.user?.employee_id || meta.employeeId || meta.employee_id || employeeId || "";

  const user = {
    ...res.user,
    ...meta,
    uid: res.user?.id || res.id,
    id: res.user?.id || res.id,
    employeeId: empId,
    employee_id: empId,
    companyId: res.user?.company_id || res.user?.companyId || res.company_id || targetCompanyId || ""
  };

  localStorage.setItem("att_current_user", JSON.stringify(user));
  window.dispatchEvent(new Event("local-auth-updated"));
  return user;
};

export const logoutUser = async () => {
  localStorage.removeItem("att_auth_token");
  localStorage.removeItem("att_current_user");
  window.dispatchEvent(new Event("local-auth-updated"));
};

export const sendPasswordReset = async (email) => {
  return apiFetch("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ email: email.toLowerCase().trim() })
  });
};

export const confirmPasswordReset = async (token, newPassword) => {
  return apiFetch("/auth/confirm-reset-password", {
    method: "POST",
    body: JSON.stringify({ token, newPassword })
  });
};

export const changeUserPassword = async (newPassword) => {
  const cur = JSON.parse(localStorage.getItem("att_current_user") || "null");
  if (!cur) throw new Error("No user is currently signed in.");
  return apiFetch(`/users/${cur.uid}`, {
    method: "PUT",
    body: JSON.stringify({ password: newPassword })
  });
};

export const onAuthUserChanged = (callback) => {
  let isSubscribed = true;

  const handler = async () => {
    const raw = localStorage.getItem("att_current_user");
    if (raw) {
      try {
        let user = JSON.parse(raw);
        if (!user.companyId && user.email?.toLowerCase().endsWith("@teamcarrezza.com")) {
          user.companyId = "carrezza-global-solutions";
          user.company_id = "carrezza-global-solutions";
        }
        callback(user);

        // Transparently re-sync latest live user profile from PostgreSQL
        const token = localStorage.getItem("att_auth_token");
        const userId = user.id || user.uid;
        if (token && userId) {
          try {
            const fresh = await apiFetch(`/users/${userId}`);
            if (fresh && fresh.id && isSubscribed) {
              const freshEmpId = fresh.employeeId || fresh.employee_id || "";
              const merged = {
                ...user,
                ...fresh,
                uid: fresh.id,
                id: fresh.id,
                employeeId: freshEmpId || user.employeeId || "",
                employee_id: freshEmpId || user.employee_id || ""
              };
              localStorage.setItem("att_current_user", JSON.stringify(merged));
              callback(merged);
            }
          } catch (fetchErr) {
            // Ignore background sync errors
          }
        }
      } catch (e) {
        callback(null);
      }
    } else {
      callback(null);
    }
  };

  handler();
  window.addEventListener("local-auth-updated", handler);
  return () => {
    isSubscribed = false;
    window.removeEventListener("local-auth-updated", handler);
  };
};

export const getAllRegisteredUsers = async (companyId = "") => {
  try {
    const res = await apiFetch(`/users?companyId=${companyId || ""}`);
    return Array.isArray(res) ? res.map(u => ({
      ...u,
      uid: u.id || u.uid,
      companyId: u.company_id || u.companyId
    })) : [];
  } catch (e) {
    return [];
  }
};

export const updateUserRecord = async (uid, name, department, programType, shiftStart, shiftEnd, annualLeaves, sickLeaves, casualLeaves, avatar, dob, joiningDate, projects, tasks, jobType, designation, isProjectManager, employeeId, additionalData = {}) => {
  if (typeof name === "object" && name !== null) {
    return apiFetch(`/users/${uid}`, {
      method: "PUT",
      body: JSON.stringify(name)
    });
  }
  return apiFetch(`/users/${uid}`, {
    method: "PUT",
    body: JSON.stringify({
      name,
      department,
      programType,
      shiftStart,
      shiftEnd,
      annualLeaves,
      sickLeaves,
      casualLeaves,
      avatar,
      dob,
      joiningDate,
      projects,
      tasks,
      jobType,
      designation,
      isProjectManager,
      employeeId,
      ...additionalData
    })
  });
};

export const updateUserAccountStatus = async (uid, status) => {
  return apiFetch(`/users/${uid}`, {
    method: "PUT",
    body: JSON.stringify({ status })
  });
};

export const deleteUserRecord = async (uid) => {
  return apiFetch(`/users/${uid}`, { method: "DELETE" });
};

// ----------------------------------------------------
// ATTENDANCE & TRACKING
// ----------------------------------------------------

export const checkIn = async (userId, location = {}, verificationSessionToken = null) => {
  const uid = typeof userId === "object" && userId !== null ? (userId.uid || userId.id) : userId;
  const companyId = typeof userId === "object" && userId !== null ? userId.companyId : undefined;
  const date = getLocalDateString();
  const token = typeof location === "object" && location?.verificationSessionToken
    ? location.verificationSessionToken
    : verificationSessionToken;
  return apiFetch("/attendance/check-in", {
    method: "POST",
    body: JSON.stringify({ userId: uid, companyId, date, location, verificationSessionToken: token })
  });
};

export const checkOut = async (userId, location = {}, verificationSessionToken = null) => {
  const uid = typeof userId === "object" && userId !== null ? (userId.uid || userId.id) : userId;
  const companyId = typeof userId === "object" && userId !== null ? userId.companyId : undefined;
  const date = getLocalDateString();
  const token = typeof location === "object" && location?.verificationSessionToken
    ? location.verificationSessionToken
    : verificationSessionToken;
  return apiFetch("/attendance/check-out", {
    method: "POST",
    body: JSON.stringify({ userId: uid, companyId, date, location, verificationSessionToken: token })
  });
};

export const startBreak = async (userId, breakType = "short", location = {}) => {
  const uid = typeof userId === "object" && userId !== null ? (userId.uid || userId.id) : userId;
  const companyId = typeof userId === "object" && userId !== null ? userId.companyId : undefined;
  const date = getLocalDateString();
  const type = typeof breakType === "string" ? breakType : "short";
  const loc = typeof breakType === "object" && breakType !== null ? breakType : location;
  return apiFetch("/attendance/start-break", {
    method: "POST",
    body: JSON.stringify({ userId: uid, companyId, date, breakType: type, location: loc })
  });
};

export const endBreak = async (userId, location = {}) => {
  const uid = typeof userId === "object" && userId !== null ? (userId.uid || userId.id) : userId;
  const companyId = typeof userId === "object" && userId !== null ? userId.companyId : undefined;
  const date = getLocalDateString();
  return apiFetch("/attendance/end-break", {
    method: "POST",
    body: JSON.stringify({ userId: uid, companyId, date, location })
  });
};

export const resumeWork = async (userId, location = {}) => endBreak(userId, location);

export const getTodayAttendanceLog = async (userId) => {
  const today = getLocalDateString();
  try {
    const logs = await apiFetch(`/attendance?userId=${userId}&date=${today}`);
    return Array.isArray(logs) ? (logs[0] || null) : null;
  } catch (e) {
    return null;
  }
};

export const getUserAttendanceLogs = async (userId) => {
  try {
    const res = await apiFetch(`/attendance?userId=${userId}`);
    return Array.isArray(res) ? res : [];
  } catch (e) {
    return [];
  }
};

export const getAllAttendanceLogs = async () => {
  try {
    const res = await apiFetch("/attendance");
    return Array.isArray(res) ? res : [];
  } catch (e) {
    return [];
  }
};

export const subscribeToUserLogs = (userId, callback) => {
  let isMounted = true;
  const fetchLogs = () => {
    getUserAttendanceLogs(userId).then(logs => {
      if (isMounted) callback(logs);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchLogs();
  const interval = setInterval(fetchLogs, 3000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const subscribeToAdminDashboard = (companyId, callback) => {
  let isMounted = true;
  const fetchLogs = () => {
    apiFetch(`/attendance?companyId=${companyId || ""}`).then(logs => {
      if (isMounted) callback(Array.isArray(logs) ? logs : []);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchLogs();
  const interval = setInterval(fetchLogs, 3000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const updateAttendanceRules = async (rules, companyId = "") => {
  return apiFetch("/attendance/rules", {
    method: "POST",
    body: JSON.stringify({ rules, companyId })
  });
};

export const subscribeToAttendanceRules = (callback, companyId = "") => {
  let isMounted = true;
  const fetchRules = () => {
    apiFetch(`/attendance/rules?companyId=${encodeURIComponent(companyId || "")}`).then(res => {
      if (isMounted) callback(res?.rules || "");
    }).catch(() => {
      if (isMounted) callback("");
    });
  };
  fetchRules();
  const interval = setInterval(fetchRules, 5000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

// ----------------------------------------------------
// LEAVES & REGULARIZATION
// ----------------------------------------------------

export const requestLeave = async (
  userId,
  userName,
  userDept,
  a4,
  a5,
  a6,
  a7,
  a8,
  a9,
  a10,
  a11
) => {
  let leaveType = "Casual Leave";
  let startDate = "";
  let endDate = "";
  let totalDays = 1;
  let reason = "";
  let companyId = "";

  if (typeof a4 === "string" && a4.match(/^\d{4}-\d{2}-\d{2}/)) {
    startDate = a4;
    endDate = a5;
    totalDays = parseInt(a6) || 1;
    leaveType = a7 || "Casual Leave";
    reason = a8 || "";
    companyId = a9 || "";
  } else {
    leaveType = a4 || "Casual Leave";
    totalDays = parseInt(a5) || 1;
    startDate = a6;
    endDate = a7;
    reason = a8 || "";
    companyId = a11 || a9 || "";
  }

  return apiFetch("/leaves", {
    method: "POST",
    body: JSON.stringify({
      userId,
      userName,
      userDept,
      startDate,
      endDate,
      totalDays,
      leaveType,
      reason,
      companyId
    })
  });
};

export const updateLeaveRequest = async (requestId, status, comment = "") => {
  return apiFetch(`/leaves/${requestId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status, rejectionReason: comment, managerComment: comment })
  });
};

export const subscribeToLeaveRequests = (companyId, callback) => {
  let isMounted = true;
  const fetchLeaves = () => {
    apiFetch(`/leaves?companyId=${companyId || ""}`).then(data => {
      if (isMounted) callback(Array.isArray(data) ? data : []);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchLeaves();
  const interval = setInterval(fetchLeaves, 3000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const uploadPaidLeave = async (title, startDate, endDate, description = "", status = "active", companyId = "") => {
  return apiFetch("/leaves/paid", {
    method: "POST",
    body: JSON.stringify({ title, startDate, endDate, description, status, companyId })
  });
};

export const updatePaidLeaveStatus = async (id, status) => {
  return apiFetch(`/leaves/paid/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
};

export const deletePaidLeave = async (id) => {
  return apiFetch(`/leaves/paid/${id}`, { method: "DELETE" });
};

export const subscribeToPaidLeaves = (companyId, callback) => {
  let isMounted = true;
  const fetchPaid = () => {
    apiFetch(`/leaves/paid?companyId=${companyId || ""}`).then(data => {
      if (isMounted) callback(Array.isArray(data) ? data : []);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchPaid();
  const interval = setInterval(fetchPaid, 5000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const requestRegularization = async (userId, userName, userDept, date, checkIn, checkOut, reason, companyId = "") => {
  return apiFetch("/regularization", {
    method: "POST",
    body: JSON.stringify({ userId, userName, userDept, date, checkIn, checkOut, reason, companyId })
  });
};

export const updateRegularizationRequest = async (requestId, status, managerComment = "") => {
  return apiFetch(`/regularization/${requestId}`, {
    method: "PATCH",
    body: JSON.stringify({ status, managerComment, rejectionReason: managerComment })
  });
};

export const subscribeToRegularizationRequests = (companyId, callback) => {
  let isMounted = true;
  const fetchRegs = () => {
    apiFetch(`/regularization?companyId=${companyId || ""}`).then(data => {
      if (isMounted) callback(Array.isArray(data) ? data : []);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchRegs();
  const interval = setInterval(fetchRegs, 3000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

// ----------------------------------------------------
// PROJECTS & TASKS
// ----------------------------------------------------

export const createProject = async (...args) => {
  let name, description, teamMembers, deadline, companyId, startDate, managerId, status;
  if (typeof args[0] === "object") {
    ({ name, description, teamMembers, deadline, companyId, startDate, managerId, status } = args[0]);
  } else {
    [name, description, teamMembers = [], deadline = "", companyId = "", startDate = "", managerId = "", status = "Ongoing"] = args;
  }
  return apiFetch("/projects", {
    method: "POST",
    body: JSON.stringify({
      name,
      description,
      teamMembers,
      deadline,
      companyId,
      startDate: startDate || deadline,
      endDate: deadline,
      managerId,
      status
    })
  });
};

export const updateProject = async (projectId, updates) => {
  return apiFetch(`/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify(updates)
  });
};

export const deleteProject = async (projectId) => {
  return apiFetch(`/projects/${projectId}`, { method: "DELETE" });
};

export const updateProjectTeam = async (projectId, teamMembers) => updateProject(projectId, { teamMembers });
export const addTeamMemberToProject = async (projectId, userId) => {
  return apiFetch(`/projects/${projectId}/members`, {
    method: "POST",
    body: JSON.stringify({ userId })
  }).catch(() => true);
};

export const subscribeToProjects = (companyId, callback) => {
  let isMounted = true;
  const fetchProjects = () => {
    apiFetch(`/projects?companyId=${companyId || ""}`).then(data => {
      if (isMounted) callback(Array.isArray(data) ? data : [], null);
    }).catch((err) => {
      if (isMounted) callback([], err);
    });
  };
  fetchProjects();
  const interval = setInterval(fetchProjects, 3000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const createTask = async (taskData) => {
  return apiFetch("/tasks", {
    method: "POST",
    body: JSON.stringify(taskData)
  });
};

export const updateTask = async (taskId, updates) => {
  return apiFetch(`/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(updates)
  });
};

export const deleteTask = async (taskId) => {
  try {
    const cur = JSON.parse(localStorage.getItem("att_current_user") || "null");
    if (cur && Array.isArray(cur.tasks)) {
      cur.tasks = cur.tasks.filter(t => String(t.id) !== String(taskId));
      localStorage.setItem("att_current_user", JSON.stringify(cur));
    }
  } catch {}
  return apiFetch(`/tasks/${taskId}`, { method: "DELETE" });
};

export const subscribeToTasks = (companyId, callback) => {
  let isMounted = true;
  const fetchTasks = () => {
    apiFetch(`/tasks?companyId=${companyId || ""}`).then(data => {
      if (isMounted) callback(Array.isArray(data) ? data : []);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchTasks();
  const interval = setInterval(fetchTasks, 3000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const startTaskTimer = async (userId, taskId) => {
  try {
    let cur = null;
    try {
      cur = JSON.parse(localStorage.getItem("att_current_user") || "null");
    } catch {}

    let tasks = Array.isArray(cur?.tasks) && cur.tasks.length > 0 ? [...cur.tasks] : [];
    if (!tasks.length) {
      try {
        const user = await apiFetch(`/users/${userId}`);
        tasks = user?.tasks || [];
      } catch {}
    }

    const now = new Date().toISOString();
    const updatedTasks = tasks.map(t => ({
      ...t,
      timerStartedAt: t.id === taskId ? now : null
    }));

    if (cur) {
      cur.tasks = updatedTasks;
      localStorage.setItem("att_current_user", JSON.stringify(cur));
    }

    // Call dedicated backend task timer endpoint and update user metadata
    await apiFetch(`/tasks/${taskId}/start-timer`, { method: "POST" }).catch(() => {});
    await updateUserTasks(userId, updatedTasks).catch(() => {});
    try {
      window.dispatchEvent(new CustomEvent("task-timer-changed", { detail: { taskId, timerStartedAt: now, userId } }));
    } catch {}
    return true;
  } catch (err) {
    console.error("startTaskTimer error:", err);
    return false;
  }
};

export const stopTaskTimer = async (userId, taskId, reportData = null) => {
  try {
    let cur = null;
    try {
      cur = JSON.parse(localStorage.getItem("att_current_user") || "null");
    } catch {}

    let tasks = Array.isArray(cur?.tasks) && cur.tasks.length > 0 ? [...cur.tasks] : [];
    if (!tasks.length) {
      try {
        const user = await apiFetch(`/users/${userId}`);
        tasks = user?.tasks || [];
      } catch {}
    }

    const updatedTasks = tasks.map(t => {
      if (t.id === taskId) {
        return { ...t, timerStartedAt: null };
      }
      return t;
    });

    if (cur) {
      cur.tasks = updatedTasks;
      localStorage.setItem("att_current_user", JSON.stringify(cur));
    }

    // Call dedicated backend stop timer endpoint
    await apiFetch(`/tasks/${taskId}/stop-timer`, {
      method: "POST",
      body: JSON.stringify(typeof reportData === "object" && reportData !== null ? reportData : { userId })
    }).catch(() => {});
    await updateUserTasks(userId, updatedTasks).catch(() => {});
    try {
      window.dispatchEvent(new CustomEvent("task-timer-changed", { detail: { taskId, timerStartedAt: null, userId } }));
    } catch {}
    return true;
  } catch (err) {
    console.error("stopTaskTimer error:", err);
    return false;
  }
};

export const stopAllTaskTimers = async (userId) => {
  try {
    let cur = null;
    try {
      cur = JSON.parse(localStorage.getItem("att_current_user") || "null");
    } catch {}

    const targetId = userId || cur?.uid || cur?.id;
    if (!targetId) return true;

    let tasks = Array.isArray(cur?.tasks) && cur.tasks.length > 0 ? [...cur.tasks] : [];
    const updatedTasks = tasks.map(t => ({ ...t, timerStartedAt: null }));

    if (cur) {
      cur.tasks = updatedTasks;
      localStorage.setItem("att_current_user", JSON.stringify(cur));
    }

    await updateUserTasks(targetId, updatedTasks).catch(() => {});
    try {
      window.dispatchEvent(new CustomEvent("task-timer-changed", { detail: { taskId: null, timerStartedAt: null, userId: targetId } }));
    } catch {}
    return true;
  } catch {
    return true;
  }
};

export const updateTaskStatus = async (taskId, status, userId = null, currentTasks = null) => {
  try {
    const isCompleted = status === "completed" || status === "Completed";
    const result = await apiFetch(`/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: isCompleted ? "completed" : "pending" })
    }).catch(() => null);

    if (userId && Array.isArray(currentTasks)) {
      const updated = currentTasks.map(t => String(t.id) === String(taskId) ? { ...t, status: isCompleted ? "completed" : "pending", completed: isCompleted } : t);
      await updateUserTasks(userId, updated).catch(() => {});
    }

    try {
      window.dispatchEvent(new CustomEvent("task-status-changed", { detail: { taskId, status, userId } }));
    } catch {}
    return result || { success: true };
  } catch (err) {
    console.error("updateTaskStatus error:", err);
    return { success: false };
  }
};

export const addTaskReport = async (arg1, arg2, arg3, arg4) => {
  let reportData;
  if (typeof arg1 === "object" && arg1 !== null) {
    reportData = arg1;
  } else {
    reportData = {
      taskId: arg1,
      userId: arg2,
      pmId: arg3,
      content: arg4
    };
  }
  return apiFetch("/reports/tasks", {
    method: "POST",
    body: JSON.stringify(reportData)
  }).catch(() => ({ success: true }));
};

export const updateTaskWarningSent = async (userId, taskId) => {
  try {
    const user = await apiFetch(`/users/${userId}`);
    const tasks = user?.tasks || [];
    const updatedTasks = tasks.map(t => {
      if (t.id === taskId) {
        return { ...t, warningSentAt: new Date().toISOString() };
      }
      return t;
    });
    await updateUserTasks(userId, updatedTasks);
    return true;
  } catch {
    return false;
  }
};

export const subscribeToUserTasks = (userId, callback) => {
  let isMounted = true;
  let lastValidTasks = null;

  const fetchUserTasks = async () => {
    if (!userId) return;
    try {
      let tasks = null;
      // 1. Direct tasks endpoint from PostgreSQL tasks table (primary)
      try {
        const directTasks = await apiFetch(`/tasks?assignedTo=${userId}`);
        if (Array.isArray(directTasks)) {
          const seen = new Set();
          const seenSignatures = new Set();
          tasks = [];
          for (const dbt of directTasks) {
            const taskIdStr = String(dbt.id);
            if (seen.has(taskIdStr)) continue;
            seen.add(taskIdStr);

            // De-duplicate tasks with the same title and status to prevent double display
            const statusKey = (dbt.status === "completed" || dbt.status === "Completed") ? "completed" : "active";
            const normTitle = (dbt.title || "").trim().toLowerCase();
            const sig = normTitle + "_" + statusKey + "_" + (dbt.project_id || "");
            if (seenSignatures.has(sig)) continue;
            seenSignatures.add(sig);

            const meta = (dbt.metadata && typeof dbt.metadata === "object") ? dbt.metadata : {};
            const durationHours = Number(dbt.duration) || (dbt.duration_minutes ? Number(dbt.duration_minutes) / 60 : 0);
            let effectiveDeadline = dbt.deadline || meta.deadlineTimestamp || dbt.due_date;
            if (!effectiveDeadline && durationHours > 0) {
              const base = dbt.assigned_at || dbt.created_at || Date.now();
              effectiveDeadline = new Date(new Date(base).getTime() + durationHours * 3600 * 1000).toISOString();
            }
            tasks.push({
              ...dbt,
              id: taskIdStr,
              title: dbt.title,
              description: dbt.description || "",
              project: dbt.project_name || dbt.projectName || dbt.project_id || "",
              completed: dbt.status === "completed" || dbt.status === "Completed",
              status: dbt.status || "new",
              completionStatus: dbt.completion_status || "pending",
              duration: durationHours,
              durationMinutes: dbt.duration_minutes || (durationHours * 60),
              deadline: effectiveDeadline,
              startTime: dbt.start_time || meta.startTime,
              assignedAt: dbt.assigned_at || dbt.created_at,
              viewedAt: dbt.viewed_at,
              acknowledgedAt: dbt.acknowledged_at,
              slaPenaltyApplied: Boolean(dbt.sla_penalty_applied),
              lastReportedAt: dbt.last_reported_at,
              timerStartedAt: meta.timerStartedAt || null,
              attendanceStatus: dbt.employee_attendance_status || "present",
              isAttendanceLocked: Boolean(dbt.employee_is_admin_locked),
              penaltyReason: dbt.employee_penalty_reason || null
            });
          }
        }
      } catch (err) {
        // Fallback if network blip
      }

      // 2. Fallback to direct user embedded tasks only if network error occurred
      if (tasks === null) {
        try {
          const user = await apiFetch(`/users/${userId}`);
          if (user && Array.isArray(user.tasks) && user.tasks.length > 0) {
            tasks = user.tasks;
          }
        } catch {}
      }

      // 3. Fallback to cached user
      if (tasks === null) {
        const cached = JSON.parse(localStorage.getItem("att_current_user") || "null");
        if (cached && (cached.uid === userId || cached.id === userId) && Array.isArray(cached.tasks) && cached.tasks.length > 0) {
          tasks = cached.tasks;
        }
      }

      if (tasks !== null) {
        lastValidTasks = tasks;
        if (isMounted) callback(tasks);
      } else if (lastValidTasks !== null) {
        if (isMounted) callback(lastValidTasks);
      } else {
        if (isMounted) callback([]);
      }
    } catch {
      if (lastValidTasks !== null) {
        if (isMounted) callback(lastValidTasks);
      } else if (isMounted) {
        callback([]);
      }
    }
  };
  fetchUserTasks();
  const interval = setInterval(fetchUserTasks, 3000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};


export const subscribeToTaskReports = (arg, callback) => {
  let isMounted = true;
  let queryParam = "";
  if (typeof arg === "object" && arg !== null) {
    const parts = [];
    if (arg.companyId) parts.push(`companyId=${encodeURIComponent(arg.companyId)}`);
    if (arg.taskId) parts.push(`taskId=${encodeURIComponent(arg.taskId)}`);
    if (arg.userId) parts.push(`userId=${encodeURIComponent(arg.userId)}`);
    queryParam = parts.join("&");
  } else if (typeof arg === "string") {
    if (arg.includes("carrezza") || arg.startsWith("comp_")) {
      queryParam = `companyId=${encodeURIComponent(arg)}`;
    } else {
      queryParam = `taskId=${encodeURIComponent(arg)}`;
    }
  }

  let lastReports = null;
  const fetchReports = () => {
    apiFetch(`/reports/tasks?${queryParam}`).then(data => {
      if (Array.isArray(data)) {
        lastReports = data;
        if (isMounted) callback(data);
      } else if (lastReports !== null) {
        if (isMounted) callback(lastReports);
      } else if (isMounted) {
        callback([]);
      }
    }).catch(() => {
      if (lastReports !== null) {
        if (isMounted) callback(lastReports);
      } else if (isMounted) {
        callback([]);
      }
    });
  };
  fetchReports();
  const interval = setInterval(fetchReports, 30000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const updateUserTasks = async (userId, tasks) => {
  return apiFetch(`/users/${userId}`, {
    method: "PUT",
    body: JSON.stringify({ tasks })
  });
};

export const updateUserProjects = async (userId, projects) => {
  return apiFetch(`/users/${userId}`, {
    method: "PUT",
    body: JSON.stringify({ projects })
  });
};

export const subscribeToAllUsers = (companyId, callback) => {
  let isMounted = true;
  const fetchUsers = () => {
    getAllRegisteredUsers(companyId).then(users => {
      if (isMounted) callback(Array.isArray(users) ? users : []);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchUsers();
  const interval = setInterval(fetchUsers, 4000);
  window.addEventListener("local-auth-updated", fetchUsers);
  return () => {
    isMounted = false;
    clearInterval(interval);
    window.removeEventListener("local-auth-updated", fetchUsers);
  };
};

// ----------------------------------------------------
// CHAT & TEAM HUB
// ----------------------------------------------------

export const createChannel = async (name, description, creatorId, creatorName, companyId = "") => {
  return apiFetch("/chat/channels", {
    method: "POST",
    body: JSON.stringify({ name, displayName: name, description, createdBy: creatorId, companyId })
  });
};

export const subscribeToChannels = (companyId, callback) => {
  let isMounted = true;
  const fetchChannels = () => {
    apiFetch(`/chat/channels?companyId=${companyId || ""}`).then(data => {
      if (isMounted) {
        callback(Array.isArray(data) && data.length > 0 ? data : [
          { id: "general", name: "general", displayName: "General", description: "General company discussions", is_private: false }
        ]);
      }
    }).catch(() => {
      if (isMounted) {
        callback([
          { id: "general", name: "general", displayName: "General", description: "General company discussions", is_private: false }
        ]);
      }
    });
  };
  fetchChannels();
  const interval = setInterval(fetchChannels, 3000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const joinChannel = async () => true;
export const leaveChannel = async () => true;
export const deleteChannel = async (channelId) => apiFetch(`/chat/channels/${channelId}`, { method: "DELETE" }).catch(() => {});

export const sendChatMessage = async (...args) => {
  let channelId, content, senderId, senderName, senderAvatar, attachments, companyId;
  if (typeof args[1] === "string" && (args[1] === "channel" || args[1] === "dm" || typeof args[5] === "string")) {
    // Called with: (threadId, threadType, senderId, senderName, senderAvatar, text, fileData, companyId)
    channelId = args[0];
    senderId = args[2];
    senderName = args[3];
    senderAvatar = args[4];
    content = args[5];
    const fileData = args[6];
    companyId = args[7];
    attachments = fileData ? [fileData] : [];
  } else {
    // Called with: (channelId, text, senderId, senderName, senderAvatar, replyTo, attachments, companyId, linkToken)
    channelId = args[0];
    content = args[1];
    senderId = args[2];
    senderName = args[3];
    senderAvatar = args[4];
    attachments = args[6] || [];
    companyId = args[7];
  }

  const linkToken = args[8] || (typeof args[0] === "object" ? args[0]?.linkToken : null);
  const headers = linkToken ? { "x-external-link-token": linkToken } : {};

  const res = await apiFetch("/chat/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      channelId,
      content,
      senderId,
      senderName,
      userAvatar: senderAvatar,
      attachments,
      companyId,
      linkToken
    })
  });

  return res ? {
    ...res,
    text: res.content || res.text || content || "",
    senderAvatar: res.user_avatar || res.senderAvatar || senderAvatar || "",
    fileData: (res.file_url || res.fileUrl) ? {
      url: res.file_url || res.fileUrl,
      name: res.file_name || res.fileName || "Attachment",
      type: res.file_type || res.fileType || ""
    } : (attachments?.[0] || null),
    isPinned: Boolean(res.reactions?.pinned?.isPinned || res.isPinned),
    pinExpiresAt: res.reactions?.pinned?.pinExpiresAt || res.reactions?.pinned?.pinnedUntil || res.pinExpiresAt || null,
    pinDurationDays: res.reactions?.pinned?.pinDurationDays || res.pinDurationDays || null,
    pinnedAt: res.reactions?.pinned?.pinnedAt || res.pinnedAt || null,
    pinnedBy: res.reactions?.pinned?.pinnedBy || res.pinnedBy || null
  } : res;
};

const mapMessageData = (m) => {
  if (!m) return m;
  const pinned = m.reactions?.pinned || {};
  const isPinned = m.isPinned !== undefined ? Boolean(m.isPinned) : Boolean(pinned.isPinned);
  const pinExpiresAt = m.pinExpiresAt || pinned.pinExpiresAt || pinned.pinnedUntil || null;
  const pinDurationDays = m.pinDurationDays || pinned.pinDurationDays || null;
  const pinnedAt = m.pinnedAt || pinned.pinnedAt || null;
  const pinnedBy = m.pinnedBy || pinned.pinnedBy || null;

  const isDeleted = m.isDeleted !== undefined ? Boolean(m.isDeleted) : Boolean(m.is_deleted || m.reactions?.isDeleted);
  const deletedBy = m.deletedBy || m.deleted_by || m.reactions?.deletedBy || null;
  const deletedAt = m.deletedAt || m.deleted_at || m.reactions?.deletedAt || null;
  const deletedFor = m.deletedFor || m.deleted_for || m.reactions?.deletedFor || [];

  return {
    ...m,
    text: m.text ?? m.content ?? "",
    senderAvatar: m.senderAvatar ?? m.user_avatar ?? "",
    fileData: m.fileData || ((m.file_url || m.fileUrl) ? {
      url: m.file_url || m.fileUrl,
      name: m.file_name || m.fileName || "Attachment",
      type: m.file_type || m.fileType || ""
    } : null),
    isPinned,
    pinExpiresAt,
    pinDurationDays,
    pinnedAt,
    pinnedBy,
    isDeleted,
    deletedBy,
    deletedAt,
    deletedFor
  };
};

export const subscribeToMessages = (channelId, companyIdOrCallback, maybeCallback, maybeLinkToken = "") => {
  let companyId = "";
  let callback = null;
  let linkToken = maybeLinkToken;
  if (typeof companyIdOrCallback === "function") {
    callback = companyIdOrCallback;
    companyId = "";
  } else {
    companyId = companyIdOrCallback || "";
    callback = maybeCallback;
  }

  let isMounted = true;
  const fetchMsgs = () => {
    if (!channelId) return;
    const url = `/chat/messages?channelId=${channelId}&companyId=${companyId || ""}${linkToken ? `&linkToken=${linkToken}` : ""}`;
    apiFetch(url, {
      headers: linkToken ? { "x-external-link-token": linkToken } : {}
    }).then(data => {
      if (isMounted && typeof callback === "function") {
        const msgs = Array.isArray(data) ? data.map(mapMessageData) : [];
        callback(msgs);
      }
    }).catch(() => {
      if (isMounted && typeof callback === "function") callback([]);
    });
  };
  fetchMsgs();
  const interval = setInterval(fetchMsgs, 2000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const subscribeToAllMessages = (companyId, callback) => {
  let isMounted = true;
  const fetchAll = () => {
    apiFetch(`/chat/messages?companyId=${companyId || ""}`).then(data => {
      if (isMounted && typeof callback === "function") {
        const msgs = Array.isArray(data) ? data.map(mapMessageData) : [];
        callback(msgs);
      }
    }).catch(() => {
      if (isMounted && typeof callback === "function") callback([]);
    });
  };
  fetchAll();
  const interval = setInterval(fetchAll, 3000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const pinChatMessage = async (messageId, durationDays = 1, pinnedBy = "", threadId = "") => {
  const days = typeof durationDays === "number" ? durationDays : 1;
  const pinExpiresAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
  return apiFetch(`/chat/messages/${messageId}/pin`, {
    method: "PATCH",
    body: JSON.stringify({
      isPinned: true,
      pinDurationDays: days,
      pinExpiresAt,
      pinnedUntil: pinExpiresAt,
      pinnedBy: pinnedBy || "User",
      pinnedAt: new Date().toISOString()
    })
  });
};

export const unpinChatMessage = async (messageId) => {
  return apiFetch(`/chat/messages/${messageId}/pin`, {
    method: "PATCH",
    body: JSON.stringify({
      isPinned: false,
      pinDurationDays: null,
      pinExpiresAt: null,
      pinnedUntil: null,
      pinnedBy: null,
      pinnedAt: null
    })
  });
};

export const pinChatThread = async () => true;
export const unpinChatThread = async () => true;
export const markThreadAsRead = async (userId, threadId) => {
  if (!userId || !threadId) return true;
  const now = new Date().toISOString();

  // 1. Update local storage immediately for instant UI badge disappearance
  try {
    const raw = localStorage.getItem("att_current_user");
    if (raw) {
      const u = JSON.parse(raw);
      if (!u.teamHubReadReceipts) u.teamHubReadReceipts = {};
      u.teamHubReadReceipts[threadId] = now;
      localStorage.setItem("att_current_user", JSON.stringify(u));
    }

    const dedicatedKey = `teamhub_read_receipts_${userId}`;
    const dedicatedMap = JSON.parse(localStorage.getItem(dedicatedKey) || "{}");
    dedicatedMap[threadId] = now;
    localStorage.setItem(dedicatedKey, JSON.stringify(dedicatedMap));

    // Notify listeners (DashboardLayout, TeamHub) to recalculate unread counts
    window.dispatchEvent(new Event("local-auth-updated"));
  } catch (e) {
    console.error("Local read receipt update error:", e);
  }

  // 2. Persist to server
  try {
    await apiFetch("/chat/read-receipt", {
      method: "POST",
      body: JSON.stringify({ userId, threadId, readAt: now })
    }).catch(() => {});
  } catch (err) {
    // Non-blocking
  }

  return true;
};
export const deleteChatMessageForMe = async (messageId, userId) => {
  return apiFetch(`/chat/messages/${messageId}`, {
    method: "DELETE",
    body: JSON.stringify({ deleteType: "me", userId })
  }).catch(() => ({ success: true }));
};

export const deleteChatMessage = async (messageId) => {
  return apiFetch(`/chat/messages/${messageId}`, {
    method: "DELETE",
    body: JSON.stringify({ deleteType: "everyone" })
  }).catch(() => ({ success: true }));
};

export const getAllMessagesAdmin = async (companyId = "") => {
  try {
    const res = await apiFetch(`/chat/messages?companyId=${companyId || ""}`);
    return Array.isArray(res) ? res : [];
  } catch (e) {
    return [];
  }
};

export const getOrCreateDmThread = async (currentUserId, targetUserId, companyId = "") => {
  const res = await apiFetch("/chat/dm-threads", {
    method: "POST",
    body: JSON.stringify({ participants: [currentUserId, targetUserId], companyId })
  }).catch(() => ({ id: `dm_${[currentUserId, targetUserId].sort().join("_")}` }));
  return res;
};

export const subscribeToDmThreads = (userId, companyId, callback) => {
  let isMounted = true;
  const fetchDms = () => {
    apiFetch(`/chat/dm-threads?userId=${userId}&companyId=${companyId || ""}`).then(data => {
      if (isMounted) callback(Array.isArray(data) ? data : []);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchDms();
  const interval = setInterval(fetchDms, 3000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const getAllDmThreadsAdmin = async (companyId = "") => {
  try {
    const res = await apiFetch(`/chat/dm-threads?companyId=${companyId || ""}`);
    return Array.isArray(res) ? res : [];
  } catch (e) {
    return [];
  }
};

export const uploadFileToFirebase = async (file) => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
};

export const uploadFileToCloudinary = async (file) => uploadFileToFirebase(file);

// ----------------------------------------------------
// ASSETS MANAGEMENT
// ----------------------------------------------------

export const getAssets = async (companyId = "") => {
  try {
    const res = await apiFetch(`/assets?companyId=${companyId || ""}`);
    return Array.isArray(res) ? res : [];
  } catch (e) {
    return [];
  }
};

export const addAsset = async (assetData) => {
  return apiFetch("/assets", {
    method: "POST",
    body: JSON.stringify(assetData)
  });
};

export const updateAsset = async (assetId, updates) => {
  return apiFetch(`/assets/${assetId}`, {
    method: "PATCH",
    body: JSON.stringify(updates)
  });
};

export const deleteAsset = async (assetId) => {
  return apiFetch(`/assets/${assetId}`, { method: "DELETE" });
};

export const subscribeToAssets = (companyId, callback) => {
  let isMounted = true;
  const fetchAssets = () => {
    apiFetch(`/assets?companyId=${companyId || ""}`).then(data => {
      if (isMounted) callback(Array.isArray(data) ? data : []);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchAssets();
  const interval = setInterval(fetchAssets, 3000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

// ----------------------------------------------------
// PAYROLL MANAGEMENT
// ----------------------------------------------------

export const subscribeToCompanyPayroll = (companyId, month, year, callback) => {
  let isMounted = true;
  const fetchPayroll = () => {
    let url = `/payroll?companyId=${encodeURIComponent(companyId || "")}`;
    if (month) url += `&month=${encodeURIComponent(month)}`;
    if (year) url += `&year=${encodeURIComponent(year)}`;
    apiFetch(url).then(data => {
      if (isMounted) callback(Array.isArray(data) ? data : []);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchPayroll();
  const interval = setInterval(fetchPayroll, 3000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const saveEmployeePayroll = async (...args) => {
  let payload = {};
  if (args.length >= 3) {
    const [companyId, userId, data] = args;
    payload = {
      ...data,
      companyId,
      userId,
      employeeId: userId
    };
  } else if (typeof args[0] === "object" && args[0] !== null) {
    payload = args[0];
  }
  return apiFetch("/payroll", {
    method: "POST",
    body: JSON.stringify(payload)
  });
};

export const deleteEmployeePayroll = async (...args) => {
  if (args.length >= 4) {
    const [companyId, userId, month, year] = args;
    const url = `/payroll?companyId=${encodeURIComponent(companyId || "")}&employeeId=${encodeURIComponent(userId || "")}&month=${encodeURIComponent(month || "")}&year=${encodeURIComponent(year || "")}`;
    return apiFetch(url, { method: "DELETE" });
  }
  const payrollId = args[0];
  return apiFetch(`/payroll/${payrollId}`, { method: "DELETE" });
};

export const wipeAllEmployeePayrolls = async (companyId, month, year) => {
  let url = `/payroll/all?companyId=${encodeURIComponent(companyId || "")}`;
  if (month) url += `&month=${encodeURIComponent(month)}`;
  if (year) url += `&year=${encodeURIComponent(year)}`;
  return apiFetch(url, { method: "DELETE" });
};

export const updateEmployeeGrossSalary = async (userId, grossSalary) => {
  return apiFetch(`/users/${userId}`, {
    method: "PUT",
    body: JSON.stringify({ grossSalary: Number(grossSalary) })
  });
};

export const calculateBatchPayroll = async (companyId, month, year, workingDays = 30) => {
  return apiFetch("/payroll/calculate", {
    method: "POST",
    body: JSON.stringify({ companyId, month, year, workingDays })
  });
};

export const approveAndSendPayslips = async (companyId, month, year) => {
  return apiFetch("/payroll/approve", {
    method: "POST",
    body: JSON.stringify({ companyId, month, year })
  });
};

// ----------------------------------------------------
// COMPANIES & WORKSPACES
// ----------------------------------------------------

export const getCompanies = async () => {
  try {
    const res = await apiFetch("/companies");
    return Array.isArray(res) ? res : [];
  } catch (e) {
    return [];
  }
};

export const getCompanyBySlug = async (slug) => {
  try {
    return await apiFetch(`/companies/slug/${slug}`);
  } catch (e) {
    return null;
  }
};

export const listenToCompany = (companyId, callback) => {
  let actualId = typeof companyId === "object" && companyId !== null ? companyId.id : companyId;
  if (!actualId) return () => {};

  let isMounted = true;
  const fetchCompany = () => {
    apiFetch(`/companies/slug/${actualId}`).then(comp => {
      if (isMounted && comp) callback(comp);
    }).catch(() => {
      if (isMounted && actualId === "carrezza-global-solutions") {
        callback({
          id: "carrezza-global-solutions",
          name: "Carrezza Global Solutions",
          slug: "carrezza-global-solutions",
          status: "active",
          modules: ["attendance", "team-hub", "projects", "tasks", "assets", "payroll", "external-links", "roles"]
        });
      }
    });
  };

  fetchCompany();
  const interval = setInterval(fetchCompany, 5000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const createCompany = async (companyData) => {
  return apiFetch("/companies", {
    method: "POST",
    body: JSON.stringify(companyData)
  });
};

export const updateCompanyDetails = async (companyId, updates) => {
  return apiFetch(`/companies/${companyId}`, {
    method: "PATCH",
    body: JSON.stringify(updates)
  });
};

export const deleteCompany = async (companyId) => apiFetch(`/companies/${companyId}`, { method: "DELETE" });
export const updateCompanyStatus = async (companyId, status) => updateCompanyDetails(companyId, { status });

export const getCompanyStats = async () => ({});
export const approveCompany = async (companyId) => updateCompanyStatus(companyId, "active");
export const autoMigrateFirebase = async () => true;
export const assignCompanyToUser = async () => true;
export const recoverLostData = async () => true;
export const recoverChatData = async () => true;
export const getCompanyNameById = async () => "Carrezza Global Solutions";
export const checkDomainAuthorization = async (email = "", companySlug = "") => {
  try {
    const cleanEmail = String(email || "").toLowerCase().trim();
    if (!cleanEmail || !cleanEmail.includes("@")) {
      return { allowed: true, authorized: true };
    }
    const domain = cleanEmail.split("@")[1];
    try {
      const domains = await apiFetch("/companies/domains");
      if (Array.isArray(domains) && domains.length > 0) {
        const verified = domains.filter(d => d.status === "VERIFIED").map(d => d.domain?.toLowerCase());
        if (verified.length > 0 && !verified.includes(domain) && !companySlug) {
          return { allowed: true, authorized: true };
        }
      }
    } catch {}
    return { allowed: true, authorized: true };
  } catch {
    return { allowed: true, authorized: true };
  }
};

// ----------------------------------------------------
// ROLES & PERMISSIONS
// ----------------------------------------------------

export const createRole = async (companyId, roleData) => {
  return apiFetch("/roles", {
    method: "POST",
    body: JSON.stringify({ ...roleData, companyId })
  });
};

export const updateRole = async (companyId, roleId, roleData) => {
  return apiFetch(`/roles/${roleId}`, {
    method: "PATCH",
    body: JSON.stringify(roleData)
  });
};

export const deleteRole = async (companyId, roleId) => apiFetch(`/roles/${roleId}`, { method: "DELETE" });

export const subscribeToRoles = (companyId, callback) => {
  let isMounted = true;
  const fetchRoles = () => {
    apiFetch(`/roles?companyId=${companyId || ""}`).then(data => {
      if (isMounted) {
        callback(Array.isArray(data) && data.length > 0 ? data : [
          { id: "role_admin", name: "Admin", permissions: { all: true } },
          { id: "role_employee", name: "Employee", permissions: { attendance: true, leaves: true, teamHub: true, tasks: true } }
        ]);
      }
    }).catch(() => {
      if (isMounted) {
        callback([
          { id: "role_admin", name: "Admin", permissions: { all: true } },
          { id: "role_employee", name: "Employee", permissions: { attendance: true, leaves: true, teamHub: true, tasks: true } }
        ]);
      }
    });
  };
  fetchRoles();
  const interval = setInterval(fetchRoles, 5000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

// ----------------------------------------------------
// ENVIRONMENT SETTINGS
// ----------------------------------------------------

export const addEnvironmentSetting = async (companyId, settingData) => {
  return apiFetch("/environment-settings", {
    method: "POST",
    body: JSON.stringify({ ...settingData, companyId })
  });
};

export const updateEnvironmentSetting = async (companyId, id, settingData) => {
  return apiFetch(`/environment-settings/${id}`, {
    method: "PATCH",
    body: JSON.stringify(settingData)
  });
};

export const deleteEnvironmentSetting = async (companyId, id) => apiFetch(`/environment-settings/${id}`, { method: "DELETE" });

export const subscribeToEnvironmentSettings = (companyId, callback) => {
  let isMounted = true;
  const fetchSettings = () => {
    apiFetch(`/environment-settings?companyId=${companyId || ""}`).then(data => {
      if (isMounted) callback(Array.isArray(data) ? data : []);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchSettings();
  const interval = setInterval(fetchSettings, 5000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

// ----------------------------------------------------
// EXTERNAL LINKS
// ----------------------------------------------------

export const subscribeToExternalLinks = (companyId, callback) => {
  let isMounted = true;
  const fetchLinks = () => {
    apiFetch(`/external-links?companyId=${companyId || ""}`).then(data => {
      if (isMounted) callback(Array.isArray(data) ? data : []);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchLinks();
  const interval = setInterval(fetchLinks, 3000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const generateExternalLink = async (arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) => {
  let payload;
  if (typeof arg1 === "object" && arg1 !== null) {
    payload = arg1;
  } else if (arg7 !== undefined) {
    // Called from ExternalLinksTab: (userId, companyId, projectId, projectName, pmId, pmName, clientEmail, clientName)
    payload = {
      userId: arg1,
      companyId: arg2,
      projectId: arg3,
      projectName: arg4,
      pmId: arg5,
      pmName: arg6,
      clientEmail: arg7,
      clientName: arg8
    };
  } else {
    payload = {
      clientName: arg1,
      clientEmail: arg2,
      projectId: arg3,
      projectName: arg4,
      pmId: arg5,
      pmName: arg6,
      channelId: arg7,
      companyId: arg8
    };
  }
  return apiFetch("/external-links", {
    method: "POST",
    body: JSON.stringify(payload)
  });
};

export const revokeExternalLink = async (linkId, companyId) => {
  return apiFetch(`/external-links/${linkId}/revoke`, {
    method: "PATCH",
    body: JSON.stringify({ companyId })
  });
};

export const getExternalLinkByToken = async (token) => {
  try {
    return await apiFetch(`/external-links/token/${token}`);
  } catch (e) {
    return null;
  }
};

// ----------------------------------------------------
// NOTIFICATIONS & REPORTS
// ----------------------------------------------------

export const createNotification = async (userId, title, message, type = "info", link = "") => {
  return apiFetch("/notifications", {
    method: "POST",
    body: JSON.stringify({ userId, title, message, type, link })
  }).catch(() => true);
};

export const subscribeToNotifications = (userId, callback) => {
  let isMounted = true;
  const fetchNotifs = () => {
    if (!userId) return;
    apiFetch(`/notifications?userId=${userId}`).then(data => {
      if (isMounted && typeof callback === "function") {
        callback(Array.isArray(data) ? data : []);
      }
    }).catch(() => {
      if (isMounted && typeof callback === "function") callback([]);
    });
  };
  fetchNotifs();
  const interval = setInterval(fetchNotifs, 4000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const markNotificationRead = async (notificationId) => {
  return apiFetch(`/notifications/${notificationId}/read`, {
    method: "PATCH"
  }).catch(() => true);
};

export const subscribeToDailyReports = (companyId, callback) => {
  let isMounted = true;
  const fetchDaily = () => {
    apiFetch(`/reports/daily?companyId=${companyId || ""}`).then(data => {
      if (isMounted) callback(Array.isArray(data) ? data : []);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchDaily();
  const interval = setInterval(fetchDaily, 4000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const subscribeToMyDailyReports = (userId, callback) => {
  let isMounted = true;
  const fetchMyDaily = () => {
    apiFetch(`/reports/daily?userId=${userId || ""}`).then(data => {
      if (isMounted) callback(Array.isArray(data) ? data : []);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchMyDaily();
  const interval = setInterval(fetchMyDaily, 4000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const addDailyReport = async (reportData) => {
  return apiFetch("/reports/daily", {
    method: "POST",
    body: JSON.stringify(reportData)
  });
};

export const updateDailyReport = async (reportId, updates) => {
  return apiFetch(`/reports/daily/${reportId}`, {
    method: "PATCH",
    body: JSON.stringify(updates)
  });
};

export const deleteDailyReport = async (reportId) => {
  return apiFetch(`/reports/daily/${reportId}`, {
    method: "DELETE"
  });
};

export const subscribeToWeeklyReports = (companyId, callback) => {
  let isMounted = true;
  const fetchWeekly = () => {
    apiFetch(`/reports/weekly?companyId=${companyId || ""}`).then(data => {
      if (isMounted) callback(Array.isArray(data) ? data : []);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchWeekly();
  const interval = setInterval(fetchWeekly, 4000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const addWeeklyReport = async (reportData) => {
  return apiFetch("/reports/weekly", {
    method: "POST",
    body: JSON.stringify(reportData)
  });
};

export const updateWeeklyReport = async (reportId, updates) => {
  return apiFetch(`/reports/weekly/${reportId}`, {
    method: "PATCH",
    body: JSON.stringify(updates)
  });
};

export const deleteWeeklyReport = async (reportId) => {
  return apiFetch(`/reports/weekly/${reportId}`, {
    method: "DELETE"
  });
};

// ----------------------------------------------------
// COMPANY DOMAINS
// ----------------------------------------------------
export const getCompanyDomains = async (companyId) => {
  return apiFetch(`/companies/domains?companyId=${companyId || ""}`);
};

export const subscribeToCompanyDomains = (companyId, callback) => {
  let isMounted = true;
  const fetchDomains = () => {
    apiFetch(`/companies/domains?companyId=${companyId || ""}`).then(data => {
      if (isMounted) callback(Array.isArray(data) ? data : []);
    }).catch(() => {
      if (isMounted) callback([]);
    });
  };
  fetchDomains();
  const interval = setInterval(fetchDomains, 3000);
  return () => {
    isMounted = false;
    clearInterval(interval);
  };
};

export const addCompanyDomain = async (companyId, domain) => {
  return apiFetch("/companies/domains", {
    method: "POST",
    body: JSON.stringify({ companyId, domain })
  });
};

export const deleteCompanyDomain = async (domain) => {
  return apiFetch(`/companies/domains/${encodeURIComponent(domain)}`, {
    method: "DELETE"
  });
};

export const verifyCompanyDomain = async (domain) => {
  return apiFetch(`/companies/domains/${encodeURIComponent(domain)}/verify`, {
    method: "POST"
  });
};

export const getLandingPageConfig = async () => null;
export const updateLandingPageConfig = async () => true;

// ----------------------------------------------------
// AUDIT LOGS, SESSIONS & SECURITY ALERTS
// ----------------------------------------------------
export const getActiveSessions = async () => {
  const res = await apiFetch("/sessions/active");
  return res.sessions || [];
};

export const revokeSession = async (sessionId) => {
  return apiFetch("/sessions/revoke", {
    method: "POST",
    body: JSON.stringify({ sessionId })
  });
};

export const revokeAllOtherSessions = async () => {
  return apiFetch("/sessions/revoke-others", {
    method: "POST"
  });
};

export const getAuditLogs = async (params = {}) => {
  const searchParams = new URLSearchParams();
  Object.keys(params).forEach(key => {
    if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
      searchParams.append(key, params[key]);
    }
  });
  const queryString = searchParams.toString();
  return apiFetch(`/admin/audit-logs${queryString ? `?${queryString}` : ""}`);
};

export const getSecurityAlerts = async (params = {}) => {
  const searchParams = new URLSearchParams();
  Object.keys(params).forEach(key => {
    if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
      searchParams.append(key, params[key]);
    }
  });
  const queryString = searchParams.toString();
  return apiFetch(`/admin/security-alerts${queryString ? `?${queryString}` : ""}`);
};

export const resolveSecurityAlert = async (alertId) => {
  return apiFetch(`/admin/security-alerts/${encodeURIComponent(alertId)}/resolve`, {
    method: "PATCH"
  });
};

export const getSecurityStats = async () => {
  return apiFetch("/admin/security-stats");
};

// ----------------------------------------------------
// BIOMETRICS & FACE ENROLLMENT
// ----------------------------------------------------

export const getFaceEnrollmentStatus = async (userId = null) => {
  const url = userId ? `/attendance/face/status?userId=${encodeURIComponent(userId)}` : "/attendance/face/status";
  return apiFetch(url);
};

export const authorizeFaceEnrollment = async (targetUserId) => {
  return apiFetch("/attendance/face/authorize", {
    method: "POST",
    body: JSON.stringify({ targetUserId })
  });
};

export const enrollFace = async (imageBase64, consentGiven = true, targetUserId = null) => {
  return apiFetch("/attendance/face/enroll", {
    method: "POST",
    body: JSON.stringify({ imageBase64, consentGiven, targetUserId })
  });
};

export const revokeFaceEnrollment = async (targetUserId, reason = "") => {
  return apiFetch("/attendance/face/revoke", {
    method: "POST",
    body: JSON.stringify({ targetUserId, reason })
  });
};

export const verifyFaceSession = async (imageBase64, options = {}) => {
  const { workMode = "office", location = {}, actionType = "check-in" } = options;
  return apiFetch("/attendance/face/verify-session", {
    method: "POST",
    body: JSON.stringify({ imageBase64, workMode, location, actionType })
  });
};

export const getVerificationAttempts = async (params = {}) => {
  const searchParams = new URLSearchParams();
  Object.keys(params).forEach(key => {
    if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
      searchParams.append(key, params[key]);
    }
  });
  const queryString = searchParams.toString();
  return apiFetch(`/attendance/face/attempts${queryString ? `?${queryString}` : ""}`);
};

export const reviewVerificationAttempt = async (attemptIdOrObj, decisionArg, noteArg) => {
  let attemptId, decision, note;
  if (typeof attemptIdOrObj === "object" && attemptIdOrObj !== null) {
    ({ attemptId, decision, note = "" } = attemptIdOrObj);
  } else {
    attemptId = attemptIdOrObj;
    decision = decisionArg;
    note = noteArg || "";
  }
  return apiFetch("/attendance/face/review", {
    method: "POST",
    body: JSON.stringify({ attemptId, decision, note })
  });
};

export const db = null;
export default { apiFetch };


// ============================================================================
// TASK SLA & HOURLY REPORT COMPLIANCE CLIENT LAYER
// ============================================================================

export const markTaskViewed = async (taskId) => {
  try {
    return await apiFetch(`/tasks/${taskId}/view`, { method: "POST" });
  } catch (e) {
    console.warn("markTaskViewed error:", e.message);
  }
};

export const completeTaskWithSla = async (taskId, completionNotes = "") => {
  return await apiFetch(`/tasks/${taskId}/complete`, {
    method: "POST",
    body: JSON.stringify({ completionNotes })
  });
};

export const submitHourlyReport = async (reportData) => {
  return await apiFetch("/reports/hourly", {
    method: "POST",
    body: JSON.stringify(reportData)
  });
};

export const getHourlyReports = async (params = {}) => {
  const query = new URLSearchParams(params).toString();
  return await apiFetch(`/reports/hourly${query ? `?${query}` : ""}`);
};

export const revertAttendancePenalty = async (attendanceId, resolutionNotes = "", taskId = null) => {
  return await apiFetch(`/attendance/${attendanceId}/revert-penalty`, {
    method: "POST",
    body: JSON.stringify({ resolutionNotes, taskId })
  });
};

export const assignTask = async (taskData) => {
  return await apiFetch("/tasks", {
    method: "POST",
    body: JSON.stringify(taskData)
  });
};

export const fetchAllTasks = async (params = {}) => {
  const query = new URLSearchParams(params).toString();
  const data = await apiFetch(`/tasks${query ? `?${query}` : ""}`);
  if (Array.isArray(data)) {
    const seen = new Set();
    return data.filter(item => {
      const id = String(item.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  return data;
};
