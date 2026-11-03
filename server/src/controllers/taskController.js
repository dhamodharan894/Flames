import { query } from "../config/db.js";
import auditService from "../services/auditService.js";

export const getTasks = async (req, res) => {
  try {
    const { companyId, projectId, assigneeId, assignedTo, status } = req.query;
    const targetCompanyId = companyId || req.user?.companyId;
    const filterAssignee = assigneeId || assignedTo;

    let sql = `
      SELECT t.*, t.id as "_id", t.assigned_to as assignee_id, t.assigned_to as "assigneeId",
             u.name as assignee_name, u.name as "assigneeName", u.email as assignee_email,
             p.name as project_name, p.name as "projectName",
             att.attendance_id, att.attendance_id as "attendanceId",
             att.status as employee_attendance_status,
             att.is_admin_locked as employee_is_admin_locked,
             att.penalty_status as employee_penalty_status,
             att.penalty_reason as employee_penalty_reason,
             att.penalized_by_task_id as employee_penalized_by_task_id
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      LEFT JOIN projects p ON t.project_id = p.id
      LEFT JOIN (
        SELECT DISTINCT ON (user_id) 
          id as attendance_id, user_id, status, is_admin_locked, penalty_status, penalty_reason, penalized_by_task_id
        FROM attendance 
        WHERE date >= CURRENT_DATE - INTERVAL '1 day'
        ORDER BY user_id, updated_at DESC
      ) att ON att.user_id = t.assigned_to
      WHERE 1=1
    `;
    const params = [];

    if (targetCompanyId) {
      params.push(targetCompanyId);
      sql += ` AND t.company_id = $${params.length}`;
    }

    if (projectId) {
      params.push(projectId);
      sql += ` AND t.project_id = $${params.length}`;
    }

    // Role-based visibility: employees can only view tasks assigned to them
    if (req.user?.role === "employee") {
      params.push(req.user.id);
      sql += ` AND t.assigned_to = $${params.length}`;
    } else if (filterAssignee) {
      params.push(filterAssignee);
      sql += ` AND t.assigned_to = $${params.length}`;
    }

    if (status) {
      params.push(status);
      sql += ` AND t.status = $${params.length}`;
    }

    sql += " ORDER BY t.created_at DESC LIMIT 500";
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error("getTasks error:", err);
    res.status(500).json({ error: "Failed to fetch tasks." });
  }
};

export const createTask = async (req, res) => {
  try {
    // Only authorized admins or project managers can assign tasks
    if (req.user && req.user.role === "employee") {
      return res.status(403).json({ error: "Unauthorized: Only administrators can assign tasks." });
    }

    const {
      title,
      description,
      projectId,
      assigneeId,
      assignedTo,
      priority = "medium",
      dueDate,
      deadline,
      startTime,
      companyId
    } = req.body;

    const targetCompanyId = companyId || req.user?.companyId;
    const creatorId = req.user?.id || null;
    const targetAssignee = assigneeId || assignedTo || null;
    const targetDeadline = deadline || dueDate || null;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Task title is required." });
    }

    if (!targetAssignee) {
      return res.status(400).json({ error: "Assigned employee is required." });
    }

    if (targetDeadline && startTime) {
      const s = new Date(startTime).getTime();
      const d = new Date(targetDeadline).getTime();
      if (!isNaN(s) && !isNaN(d) && d <= s) {
        return res.status(400).json({ error: "Task deadline (end date) must be after start date/time." });
      }
    }

    const id = "task_" + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    const taskMeta = {
      deadlineTimestamp: targetDeadline || null,
      startTime: startTime || null,
      assignedAt: new Date().toISOString()
    };

    const result = await query(
      `INSERT INTO tasks (
        id, company_id, project_id, title, description, assigned_to, created_by,
        priority, due_date, deadline, start_time, status, metadata, assigned_at,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'new', $12, NOW(), NOW(), NOW())
      RETURNING *`,
      [
        id,
        targetCompanyId,
        projectId || null,
        title.trim(),
        description ? description.trim() : "",
        targetAssignee,
        creatorId,
        priority,
        targetDeadline ? new Date(targetDeadline) : null,
        targetDeadline ? new Date(targetDeadline) : null,
        startTime || null,
        JSON.stringify(taskMeta)
      ]
    );

    const taskRow = result.rows[0];

    // Create immediate in-app notification for the assigned employee
    const notifId = "notif_" + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    const deadlineText = targetDeadline ? new Date(targetDeadline).toLocaleString() : "Not specified";
    const notifMessage = `You have been assigned a new task: "${title.trim()}". Deadline: ${deadlineText}. You must open/acknowledge this task within 1 hour.`;

    await query(
      `INSERT INTO notifications (id, user_id, title, message, type, read, link)
       VALUES ($1, $2, $3, $4, 'info', FALSE, '/tasks')`,
      [notifId, targetAssignee, `New Task: ${title.trim()}`, notifMessage]
    );

    const io = req.app?.get("io");
    if (io) {
      if (targetCompanyId) io.to(`company_${targetCompanyId}`).emit("task_created", taskRow);
      io.to(`user_${targetAssignee}`).emit("task_created", taskRow);
      io.emit(`notification_${targetAssignee}`, {
        id: notifId,
        userId: targetAssignee,
        title: `New Task: ${title.trim()}`,
        message: notifMessage,
        type: "info",
        read: false,
        link: "/tasks",
        createdAt: new Date().toISOString()
      });
      io.emit("task_created", taskRow);
    }

    auditService.logAudit({
      userId: creatorId,
      action: "TASK_CREATE",
      resourceType: "task",
      resourceId: taskRow.id,
      details: { title: taskRow.title, priority: taskRow.priority, assignedTo: targetAssignee, deadline: targetDeadline },
      req
    });

    res.status(201).json(taskRow);
  } catch (err) {
    console.error("createTask error:", err);
    res.status(500).json({ error: "Failed to create task." });
  }
};

export const updateTask = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    const allowed = [
      "title", "description", "project_id", "assigned_to", "status",
      "priority", "due_date", "deadline", "start_time", "metadata"
    ];

    for (const key of Object.keys(updates)) {
      let snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      if (key === "assigneeId") snakeKey = "assigned_to";
      if (key === "projectId") snakeKey = "project_id";
      if (key === "dueDate") snakeKey = "due_date";
      if (key === "startTime") snakeKey = "start_time";

      if (allowed.includes(snakeKey)) {
        fields.push(`${snakeKey} = $${idx}`);
        values.push(updates[key]);
        idx++;
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: "No valid fields provided." });
    }

    fields.push("updated_at = CURRENT_TIMESTAMP");
    values.push(id);

    const sql = `UPDATE tasks SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`;
    const result = await query(sql, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Task not found." });
    }

    const updatedTask = result.rows[0];

    // Whenever admin extends task timing or deadline into future, automatically unblock employee attendance
    const effectiveDl = updatedTask.deadline || updatedTask.due_date;
    if (effectiveDl && new Date(effectiveDl).getTime() > Date.now() && updatedTask.assigned_to) {
      await query(
        `UPDATE attendance
         SET status = 'present',
             is_admin_locked = FALSE,
             penalty_status = NULL,
             penalty_reason = NULL,
             updated_at = NOW()
         WHERE user_id = $1 AND (date >= CURRENT_DATE - INTERVAL '1 day') AND is_admin_locked = TRUE`,
        [updatedTask.assigned_to]
      ).catch(() => {});

      await query(
        `UPDATE tasks 
         SET sla_penalty_applied = FALSE, 
             overdue = FALSE, 
             metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{deadlineTimestamp}', to_jsonb($2::text))
         WHERE id = $1`,
        [updatedTask.id, new Date(effectiveDl).toISOString()]
      ).catch(() => {});
    }

    const io = req.app?.get("io");
    if (io) {
      if (updatedTask.company_id) io.to(`company_${updatedTask.company_id}`).emit("task_updated", updatedTask);
      if (updatedTask.assigned_to) io.to(`user_${updatedTask.assigned_to}`).emit("task_updated", updatedTask);
      io.emit("task_updated", updatedTask);
    }

    auditService.logAudit({
      userId: req.user?.id,
      action: "TASK_UPDATE",
      resourceType: "task",
      resourceId: id,
      details: { fieldsUpdated: Object.keys(updates), title: updatedTask.title, status: updatedTask.status },
      req
    });

    res.json(updatedTask);
  } catch (err) {
    console.error("updateTask error:", err);
    res.status(500).json({ error: "Failed to update task." });
  }
};

export const deleteTask = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await query("SELECT * FROM tasks WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Task not found." });
    }
    const task = existing.rows[0];

    await query("DELETE FROM tasks WHERE id = $1", [id]);

    // Also remove from user's metadata.tasks array if present
    if (task.assigned_to) {
      await query(
        `UPDATE users
         SET metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{tasks}',
           (
             SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
             FROM jsonb_array_elements(COALESCE(metadata->'tasks', '[]'::jsonb)) elem
             WHERE elem->>'id' <> $1
           )
         )
         WHERE id = $2 AND metadata->'tasks' IS NOT NULL`,
        [id, task.assigned_to]
      ).catch(() => {});
    }

    // Also remove related hourly and task reports
    await query("DELETE FROM hourly_reports WHERE task_id = $1", [id]).catch(() => {});
    await query("DELETE FROM task_reports WHERE task_id = $1", [id]).catch(() => {});

    const io = req.app?.get("io");
    if (io) {
      if (task.company_id) io.to(`company_${task.company_id}`).emit("task_deleted", { id });
      if (task.assigned_to) io.to(`user_${task.assigned_to}`).emit("task_deleted", { id });
      io.emit("task_deleted", { id });
    }

    res.json({ message: "Task deleted successfully.", id });
  } catch (err) {
    console.error("deleteTask error:", err);
    res.status(500).json({ error: "Failed to delete task." });
  }
};

export const startTaskTimer = async (req, res) => {
  try {
    const { id } = req.params;
    const now = new Date().toISOString();

    const existing = await query("SELECT * FROM tasks WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Task not found." });
    }

    const task = existing.rows[0];
    const meta = (task.metadata && typeof task.metadata === "object") ? task.metadata : {};
    meta.timerStartedAt = now;

    const result = await query(
      `UPDATE tasks
       SET metadata = $1, status = 'in-progress', updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(meta), id]
    );

    const timerPayload = {
      ...result.rows[0],
      timerStartedAt: now,
      status: "in-progress"
    };

    const io = req.app?.get("io");
    if (io) {
      if (task.company_id) io.to(`company_${task.company_id}`).emit("task_timer_started", timerPayload);
      if (task.assigned_to) io.to(`user_${task.assigned_to}`).emit("task_timer_started", timerPayload);
      io.emit("task_timer_started", timerPayload);
    }

    res.json(timerPayload);
  } catch (err) {
    console.error("startTaskTimer error:", err);
    res.status(500).json({ error: "Failed to start task timer." });
  }
};

export const stopTaskTimer = async (req, res) => {
  try {
    const { id } = req.params;
    const { reportText = "", content = "", timeSpentMinutes = 0 } = req.body || {};
    const userId = req.user?.id || req.body?.userId;

    const existing = await query("SELECT * FROM tasks WHERE id = $1", [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: "Task not found." });
    }

    const task = existing.rows[0];
    const meta = (task.metadata && typeof task.metadata === "object") ? task.metadata : {};
    
    let computedMinutes = Number(timeSpentMinutes || 0);
    if (!computedMinutes && meta.timerStartedAt) {
      const startMs = new Date(meta.timerStartedAt).getTime();
      computedMinutes = Math.max(1, Math.round((Date.now() - startMs) / 60000));
    }
    meta.timerStartedAt = null;

    const result = await query(
      `UPDATE tasks
       SET metadata = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(meta), id]
    );

    const text = reportText || content;
    let savedReport = null;
    if (text || computedMinutes > 0) {
      const repId = "tr_" + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
      const repRes = await query(
        `INSERT INTO task_reports (id, task_id, user_id, company_id, content, time_spent_minutes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [repId, id, userId || task.assigned_to, task.company_id, text || "Timer session completed", computedMinutes]
      );
      savedReport = repRes.rows[0];
    }

    const stopPayload = {
      ...result.rows[0],
      timerStartedAt: null,
      report: savedReport
    };

    const io = req.app?.get("io");
    if (io) {
      if (task.company_id) io.to(`company_${task.company_id}`).emit("task_timer_stopped", stopPayload);
      if (task.assigned_to) io.to(`user_${task.assigned_to}`).emit("task_timer_stopped", stopPayload);
      io.emit("task_timer_stopped", stopPayload);
    }

    res.json(stopPayload);
  } catch (err) {
    console.error("stopTaskTimer error:", err);
    res.status(500).json({ error: "Failed to stop task timer." });
  }
};

export const markTaskViewed = async (req, res) => {
  try {
    const { id } = req.params;
    const existingRes = await query("SELECT * FROM tasks WHERE id = $1", [id]);
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: "Task not found." });
    }

    const task = existingRes.rows[0];
    if (task.viewed_at && task.acknowledged_at) {
      return res.json({ ...task, alreadyViewed: true });
    }

    const newStatus = (task.status === "new" || task.status === "pending") ? "accepted" : task.status;

    const result = await query(
      `UPDATE tasks
       SET viewed_at = COALESCE(viewed_at, NOW()),
           acknowledged_at = COALESCE(acknowledged_at, NOW()),
           status = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [newStatus, id]
    );

    const updatedTask = result.rows[0];

    // Whenever admin extends task timing or deadline into future, automatically unblock employee attendance
    const effectiveDl = updatedTask.deadline || updatedTask.due_date;
    if (effectiveDl && new Date(effectiveDl).getTime() > Date.now() && updatedTask.assigned_to) {
      await query(
        `UPDATE attendance
         SET status = 'present',
             is_admin_locked = FALSE,
             penalty_status = NULL,
             penalty_reason = NULL,
             updated_at = NOW()
         WHERE user_id = $1 AND (date >= CURRENT_DATE - INTERVAL '1 day') AND is_admin_locked = TRUE`,
        [updatedTask.assigned_to]
      ).catch(() => {});

      await query(
        `UPDATE tasks 
         SET sla_penalty_applied = FALSE, 
             overdue = FALSE, 
             metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{deadlineTimestamp}', to_jsonb($2::text))
         WHERE id = $1`,
        [updatedTask.id, new Date(effectiveDl).toISOString()]
      ).catch(() => {});
    }

    const io = req.app?.get("io");
    if (io) {
      if (updatedTask.company_id) io.to(`company_${updatedTask.company_id}`).emit("task_viewed", updatedTask);
      if (updatedTask.created_by) io.to(`user_${updatedTask.created_by}`).emit("task_viewed", updatedTask);
      io.emit("task_viewed", updatedTask);
    }

    res.json(updatedTask);
  } catch (err) {
    console.error("markTaskViewed error:", err);
    res.status(500).json({ error: "Failed to record task view." });
  }
};

export const completeTask = async (req, res) => {
  try {
    const { id } = req.params;
    const { completionNotes = "" } = req.body || {};
    const userId = req.user?.id;

    const existingRes = await query("SELECT * FROM tasks WHERE id = $1", [id]);
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: "Task not found." });
    }

    const task = existingRes.rows[0];

    // Block employee modifications if this task is locked due to missed reports
    if (req.user?.role !== "admin" && task.assigned_to && task.sla_penalty_applied) {
      return res.status(403).json({
        error: "Task actions are locked: this task was marked Absent due to missing progress reports (> 10m). Please contact Admin to unlock.",
        locked: true
      });
    }

    const now = new Date();
    let completionStatus = "completed_on_time";

    const meta = (task.metadata && typeof task.metadata === "object") ? task.metadata : {};
    const candidateDeadlines = [
      task.deadline ? new Date(task.deadline).getTime() : 0,
      task.due_date ? new Date(task.due_date).getTime() : 0,
      meta.deadlineTimestamp ? new Date(meta.deadlineTimestamp).getTime() : 0
    ].filter(ts => ts > 0 && !isNaN(ts));
    const exactDeadline = candidateDeadlines.length > 0 ? new Date(Math.max(...candidateDeadlines)) : null;

    if (exactDeadline && !isNaN(exactDeadline.getTime())) {
      if (now.getTime() > exactDeadline.getTime()) {
        completionStatus = "completed_overdue";
      }
    }

    meta.completedAt = now.toISOString();
    meta.completionNotes = completionNotes;
    meta.completedBy = userId;

    const result = await query(
      `UPDATE tasks
       SET status = 'completed',
           completion_status = $1,
           metadata = $2,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [completionStatus, JSON.stringify(meta), id]
    );

    // Also sync completion state to user's metadata.tasks array
    if (task.assigned_to) {
      await query(
        `UPDATE users
         SET metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{tasks}',
           (
             SELECT jsonb_agg(
               CASE WHEN elem->>'id' = $1 THEN jsonb_set(elem, '{completed}', 'true'::jsonb) ELSE elem END
             )
             FROM jsonb_array_elements(COALESCE(metadata->'tasks', '[]'::jsonb)) elem
           )
         )
         WHERE id = $2 AND metadata->'tasks' IS NOT NULL`,
        [id, task.assigned_to]
      ).catch(() => {});
    }

    // If no other active tasks are penalized, restore attendance to present
    if (task.assigned_to) {
      const remainingPenalized = await query(
        `SELECT id FROM tasks 
         WHERE assigned_to = $1 
           AND status NOT IN ('completed', 'cancelled', 'suspended')
           AND sla_penalty_applied = TRUE
           AND id != $2`,
        [task.assigned_to, id]
      ).catch(() => ({ rows: [] }));
      if (remainingPenalized.rows.length === 0) {
        await query(
          `UPDATE attendance 
           SET status = 'present', 
               is_admin_locked = FALSE, 
               penalty_status = NULL, 
               penalty_reason = NULL,
               penalized_by_task_id = NULL,
               updated_at = NOW() 
           WHERE user_id = $1 AND (date >= CURRENT_DATE - INTERVAL '1 day') AND is_admin_locked = TRUE`,
          [task.assigned_to]
        ).catch(() => {});
      }
    }

    const completedTask = result.rows[0];
    const io = req.app?.get("io");
    if (io) {
      if (completedTask.company_id) io.to(`company_${completedTask.company_id}`).emit("task_completed", completedTask);
      if (completedTask.created_by) io.to(`user_${completedTask.created_by}`).emit("task_completed", completedTask);
      io.emit("task_completed", completedTask);
    }

    auditService.logAudit({
      userId,
      action: "TASK_COMPLETE",
      resourceType: "task",
      resourceId: id,
      details: { title: completedTask.title, completionStatus, dueDate: task.due_date },
      req
    });

    res.json(completedTask);
  } catch (err) {
    console.error("completeTask error:", err);
    res.status(500).json({ error: "Failed to complete task." });
  }
};
