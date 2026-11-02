import React, { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { 
  createNotification, 
  addTaskReport, 
  subscribeToTaskReports, 
  startTaskTimer, 
  stopTaskTimer,
  subscribeToMyDailyReports,
  addDailyReport,
  deleteDailyReport,
  subscribeToProjects,
  subscribeToUserTasks,
  updateUserTasks,
  updateTaskStatus,
  markTaskViewed,
  completeTaskWithSla,
  submitHourlyReport,
  getHourlyReports,
  revertAttendancePenalty,
  assignTask,
  deleteTask,
  fetchAllTasks,
  subscribeToAllUsers,
  uploadFileToFirebase
} from "../firebase";
import { 
  CheckCircle, Clock, Send, MessageSquare, Play, X, FileText, Download, 
  Square, Activity, Plus, Trash2, AlertTriangle, AlertCircle, ShieldAlert, 
  Check, RotateCcw, Calendar, User, TrendingUp, ListTodo, Eye, Unlock, Filter, Lock
} from "lucide-react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { addStandardPDFHeader, addPDFFooter } from "../utils/pdfHeader";
import FileCard from "../components/FileCard";

export default function TaskManagement() {
  const { currentUser } = useAuth();
  const { showToast } = useToast();
  
  const isAdmin = currentUser?.role === "admin" || currentUser?.role === "superadmin" || currentUser?.isSuperAdmin;

  // Active Tab state
  // Admin default: "monitoring", Employee default: "my-tasks"
  const [activeSubTab, setActiveSubTab] = useState(isAdmin ? "monitoring" : "my-tasks");

  // Core Data States
  const [tasks, setTasks] = useState([]);
  const [adminAllTasks, setAdminAllTasks] = useState([]);
  const [allCompanyUsers, setAllCompanyUsers] = useState([]);
  const [allHourlyReports, setAllHourlyReports] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Modals
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showHourlyReportModal, setShowHourlyReportModal] = useState(false);
  const [showTaskDetailsModal, setShowTaskDetailsModal] = useState(false);
  const [showRevertModal, setShowRevertModal] = useState(false);
  const [selectedTask, setSelectedTask] = useState(null);
  const [selectedAttendanceRecord, setSelectedAttendanceRecord] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Filters
  const [statusFilter, setStatusFilter] = useState("all");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Assign Task Form
  const [assignTitle, setAssignTitle] = useState("");
  const [assignDesc, setAssignDesc] = useState("");
  const [assignEmployeeId, setAssignEmployeeId] = useState("");
  const [assignProjectId, setAssignProjectId] = useState("");
  const [assignPriority, setAssignPriority] = useState("medium");
  const [assignStartTime, setAssignStartTime] = useState("");
  const [assignDeadline, setAssignDeadline] = useState("");

  // Hourly Progress Report Form
  const [reportTaskId, setReportTaskId] = useState("");
  const [reportWorkCompleted, setReportWorkCompleted] = useState("");
  const [reportProgressPercent, setReportProgressPercent] = useState(50);
  const [reportPendingWork, setReportPendingWork] = useState("");
  const [reportIssuesBlockers, setReportIssuesBlockers] = useState("");

  // Revert Penalty Form
  const [revertNotes, setRevertNotes] = useState("");

  // Daily Activity Log states (preserved existing functionality)
  const [dailyReports, setDailyReports] = useState([]);
  const [showAddLogModal, setShowAddLogModal] = useState(false);
  const [dailyLogPage, setDailyLogPage] = useState(1);
  const logsPerPage = 10;
  const [logDate, setLogDate] = useState(new Date().toISOString().split("T")[0]);
  const [logHours, setLogHours] = useState(8);
  const [logTasksCompleted, setLogTasksCompleted] = useState("");
  const [logIssuesFaced, setLogIssuesFaced] = useState("");
  const [logStatus, setLogStatus] = useState("Completed");
  const [pendingFile, setPendingFile] = useState(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [logProjectIds, setLogProjectIds] = useState([]);
  const [selectedDownloadProject, setSelectedDownloadProject] = useState("All");
  const [taskReports, setTaskReports] = useState({});

  // Real-time ticking clock for countdowns
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // Fetch Projects
  useEffect(() => {
    if (!currentUser?.companyId) return;
    const unsub = subscribeToProjects(currentUser.companyId, (data) => {
      setProjects(data || []);
    });
    return unsub;
  }, [currentUser?.companyId]);

  // Fetch Company Users for Admin Assignment
  useEffect(() => {
    if (!currentUser?.companyId || !isAdmin) return;
    const unsub = subscribeToAllUsers(currentUser.companyId, (data) => {
      const activeUsers = (data || []).filter(u => u.status !== "terminated" && u.role !== "superadmin");
      setAllCompanyUsers(activeUsers);
    });
    return unsub;
  }, [currentUser?.companyId, isAdmin]);

  // Fetch Employee Tasks (for employee or admin my-tasks)
  useEffect(() => {
    if (!currentUser?.uid) return;
    const unsubscribe = subscribeToUserTasks(currentUser.uid, (rawTasks) => {
      // Deduplicate tasks by unique ID
      const seenTaskIds = new Set();
      const uniqueTasks = [];
      (rawTasks || []).forEach(t => {
        const idKey = String(t.id);
        if (!seenTaskIds.has(idKey)) {
          seenTaskIds.add(idKey);
          uniqueTasks.push(t);
        }
      });

      uniqueTasks.forEach(t => {
        if (t.timerStartedAt) {
          const start = new Date(t.timerStartedAt).getTime();
          if (Date.now() - start > 12 * 3600 * 1000) {
            stopTaskTimer(currentUser.uid, t.id, t.assignedBy).catch(() => {});
          }
        }
      });
      const sorted = [...uniqueTasks].sort((a, b) => {
        const dateA = a.assignedAt ? new Date(a.assignedAt).getTime() : 0;
        const dateB = b.assignedAt ? new Date(b.assignedAt).getTime() : 0;
        return dateB - dateA;
      });
      setTasks(sorted);
      setLoading(false);
    });
    return unsubscribe;
  }, [currentUser?.uid]);

  // Fetch Admin Company-Wide Tasks
  const refreshAdminTasks = async () => {
    if (!isAdmin || !currentUser?.companyId) return;
    try {
      const allTasks = await fetchAllTasks({ companyId: currentUser.companyId });
      if (Array.isArray(allTasks)) {
        setAdminAllTasks(allTasks);
      }
    } catch (err) {
      console.warn("Failed to fetch admin company tasks:", err.message);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      refreshAdminTasks();
      const interval = setInterval(refreshAdminTasks, 10000);
      return () => clearInterval(interval);
    }
  }, [isAdmin, currentUser?.companyId]);

  // Fetch Hourly Reports Stream
  const refreshHourlyReports = async () => {
    if (!currentUser?.companyId) return;
    setReportsLoading(true);
    try {
      const params = isAdmin ? { companyId: currentUser.companyId } : { userId: currentUser.uid };
      const reps = await getHourlyReports(params);
      if (Array.isArray(reps)) {
        setAllHourlyReports(reps);
      }
    } catch (err) {
      console.warn("Failed to fetch hourly reports:", err.message);
    } finally {
      setReportsLoading(false);
    }
  };

  useEffect(() => {
    refreshHourlyReports();
    const interval = setInterval(refreshHourlyReports, 15000);
    return () => clearInterval(interval);
  }, [currentUser?.companyId, currentUser?.uid, isAdmin]);

  // Subscribe to Daily Activity Logs
  useEffect(() => {
    if (!currentUser?.uid) return;
    const unsubscribe = subscribeToMyDailyReports(currentUser.uid, (data) => {
      setDailyReports(data || []);
    });
    return unsubscribe;
  }, [currentUser?.uid]);

  // Auto-mark tasks as viewed when employee views the "my-tasks" tab
  useEffect(() => {
    if (activeSubTab === "my-tasks" && tasks.length > 0) {
      tasks.forEach(t => {
        if (!t.viewed_at && !t.viewedAt && t.id) {
          markTaskViewed(t.id).catch(() => {});
        }
      });
    }
  }, [activeSubTab, tasks]);

  // ----------------------------------------------------
  // COMPUTED METRICS FOR ADMIN MONITORING
  // ----------------------------------------------------
  const adminMetrics = useMemo(() => {
    const total = adminAllTasks.length;
    const completed = adminAllTasks.filter(t => t.status === "completed" || t.completed).length;
    const inProgress = adminAllTasks.filter(t => t.status === "in-progress" || (t.status === "accepted" && !t.completed)).length;
    
    // Check for overdue tasks
    const overdue = adminAllTasks.filter(t => {
      if (t.status === "completed") return false;
      const dl = t.deadline || t.metadata?.deadlineTimestamp || t.due_date;
      if (!dl) return false;
      return new Date(dl).getTime() < now;
    }).length;

    // Check for unviewed tasks exceeding 1 hour
    const unviewedSlaBreach = adminAllTasks.filter(t => {
      if (t.status === "completed" || t.viewed_at || t.viewedAt) return false;
      const assigned = new Date(t.assigned_at || t.created_at).getTime();
      return (now - assigned) > 60 * 60 * 1000;
    }).length;

    // Penalized employees count
    const penalizedEmployees = adminAllTasks.filter(t => 
      t.employee_attendance_status === "absent" && t.employee_is_admin_locked
    ).length;

    return {
      total,
      completed,
      inProgress,
      overdue,
      unviewedSlaBreach,
      penalizedEmployees
    };
  }, [adminAllTasks, now]);

  // Filtered Admin Tasks
  const filteredAdminTasks = useMemo(() => {
    return adminAllTasks.filter(t => {
      if (statusFilter !== "all") {
        if (statusFilter === "completed" && !(t.status === "completed" || t.completed)) return false;
        if (statusFilter === "in-progress" && t.status !== "in-progress") return false;
        if (statusFilter === "new" && t.status !== "new" && t.status !== "pending") return false;
        if (statusFilter === "overdue") {
          const dl = t.deadline || t.metadata?.deadlineTimestamp || t.due_date;
          if (!dl || new Date(dl).getTime() >= now || t.status === "completed") return false;
        }
        if (statusFilter === "penalized" && !(t.employee_attendance_status === "absent" && t.employee_is_admin_locked)) return false;
      }
      if (assigneeFilter !== "all" && t.assigned_to !== assigneeFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const titleMatch = (t.title || "").toLowerCase().includes(q);
        const nameMatch = (t.assignee_name || t.assigneeName || "").toLowerCase().includes(q);
        if (!titleMatch && !nameMatch) return false;
      }
      return true;
    });
  }, [adminAllTasks, statusFilter, assigneeFilter, searchQuery, now]);

  // ----------------------------------------------------
  // HANDLERS
  // ----------------------------------------------------

  // Admin: Assign New Task
  const handleAssignTaskSubmit = async (e) => {
    e.preventDefault();
    if (!assignTitle.trim()) return showToast("Task title is required.", "warning");
    if (!assignEmployeeId) return showToast("Please select an assigned employee.", "warning");
    if (!assignDeadline) return showToast("Task deadline is required.", "warning");

    setSubmitting(true);
    try {
      const payload = {
        title: assignTitle.trim(),
        description: assignDesc.trim(),
        assignedTo: assignEmployeeId,
        projectId: assignProjectId || null,
        priority: assignPriority,
        startTime: assignStartTime || new Date().toISOString(),
        deadline: new Date(assignDeadline).toISOString(),
        dueDate: new Date(assignDeadline).toISOString(),
        companyId: currentUser.companyId
      };

      await assignTask(payload);
      showToast("Task assigned successfully! Notification dispatched to employee.", "success");
      setShowAssignModal(false);
      setAssignTitle("");
      setAssignDesc("");
      setAssignEmployeeId("");
      setAssignProjectId("");
      setAssignStartTime("");
      setAssignDeadline("");
      refreshAdminTasks();
    } catch (err) {
      console.error("Assign Task error:", err);
      showToast(err.message || "Failed to assign task.", "error");
    } finally {
      setSubmitting(false);
    }
  };

  // Admin: Delete Task
  const handleDeleteAdminTask = async (task) => {
    if (!window.confirm(`Are you sure you want to delete the task "${task.title}"? This will permanently remove the task for the assigned employee.`)) {
      return;
    }
    try {
      await deleteTask(task.id);
      showToast("Task deleted successfully.", "success");
      refreshAdminTasks();
    } catch (err) {
      console.error("Delete task error:", err);
      showToast("Failed to delete task.", "error");
    }
  };

  // Employee: Submit Hourly Progress Report
  const handleHourlyReportSubmit = async (e) => {
    e.preventDefault();
    const targetTaskId = reportTaskId || (selectedTask ? selectedTask.id : null) || (tasks.find(t => !t.completed)?.id);
    if (!targetTaskId) {
      return showToast("Please select a task to report on.", "warning");
    }

    const targetTask = tasks.find(t => t.id === targetTaskId);
    if (targetTask && !isAdmin) {
      const effDl = getEffectiveDeadline(targetTask);
      if (effDl && new Date(effDl).getTime() < Date.now()) {
        return showToast("Task deadline has finished. Progress reporting is locked for this task.", "warning");
      }
    }

    if (!reportWorkCompleted.trim()) return showToast("Summary of work completed is required.", "warning");
    if (!reportPendingWork.trim()) return showToast("Summary of pending work is required.", "warning");

    setSubmitting(true);
    try {
      const payload = {
        taskId: targetTaskId,
        workCompleted: reportWorkCompleted.trim(),
        progressPercentage: Number(reportProgressPercent) || 0,
        pendingWork: reportPendingWork.trim(),
        issuesBlockers: reportIssuesBlockers.trim(),
        summary: reportWorkCompleted.trim(),
        challenges: reportIssuesBlockers.trim(),
        nextHourPlan: reportPendingWork.trim(),
        userId: currentUser.uid,
        companyId: currentUser.companyId
      };

      await submitHourlyReport(payload);

      // Reset the 5-minute cycle to count fresh 5 minutes from now for this specific task
      const todayStr = new Date().toISOString().split("T")[0];
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      try {
        localStorage.setItem(`hourly_cycle_${targetTaskId}_${todayStr}`, nowMs.toString());
      } catch (e) {}

      // Update local task state immediately so only this task's timer is reset
      setTasks(prev => prev.map(t => (t.id === targetTaskId ? {
        ...t,
        lastReportedAt: nowIso,
        last_reported_at: nowIso,
        slaPenaltyApplied: false,
        sla_penalty_applied: false,
        isAttendanceLocked: false,
        attendanceStatus: "present"
      } : t)));

      showToast("Progress report submitted successfully! Timer reset for 5 minutes.", "success");
      setShowHourlyReportModal(false);
      setReportWorkCompleted("");
      setReportPendingWork("");
      setReportIssuesBlockers("");
      setReportProgressPercent(50);
      refreshHourlyReports();
    } catch (err) {
      console.error("Submit Hourly Report error:", err);
      const msg = err.message || "Failed to submit hourly report.";
      showToast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  };

  // Admin: Revert Attendance Penalty
  const handleRevertPenaltySubmit = async (e) => {
    e.preventDefault();
    if (!selectedAttendanceRecord) return;

    setSubmitting(true);
    try {
      await revertAttendancePenalty(selectedAttendanceRecord.id, revertNotes);
      showToast("Attendance penalty successfully reverted! Employee restored to Present.", "success");
      setShowRevertModal(false);
      setSelectedAttendanceRecord(null);
      setRevertNotes("");
      refreshAdminTasks();
    } catch (err) {
      console.error("Revert Penalty error:", err);
      showToast(err.message || "Failed to revert attendance penalty.", "error");
    } finally {
      setSubmitting(false);
    }
  };

  // Employee: Mark Task Complete with SLA Check
  const handleMarkComplete = async (task, isComplete) => {
    try {
      if (!isAdmin) {
        const effDl = getEffectiveDeadline(task);
        if (effDl && new Date(effDl).getTime() < Date.now()) {
          showToast("Task deadline has finished. Functionality is locked for this task.", "warning");
          return;
        }
      }

      if (isComplete) {
        const res = await completeTaskWithSla(task.id);
        const statusMsg = res.completion_status === "completed_on_time" 
          ? "Task completed on time! Excellent job." 
          : "Task marked completed (overdue SLA recorded).";
        showToast(statusMsg, res.completion_status === "completed_on_time" ? "success" : "info");
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, completed: true, status: "completed", completionStatus: res.completion_status } : t));
      } else {
        await updateTaskStatus(task.id, "pending", currentUser.uid);
        showToast("Task marked as in progress.", "info");
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, completed: false, status: "pending" } : t));
      }
    } catch (err) {
      console.error("Complete Task error:", err);
      showToast(err.message || "Failed to update task status.", "error");
    }
  };

  // Helper: Compute effective deadline from explicit deadline, due date, or estimated duration
  const getEffectiveDeadline = (task) => {
    if (!task) return null;
    if (task.deadline) return task.deadline;
    if (task.dueDate || task.due_date) return task.dueDate || task.due_date;
    const durHours = Number(task.duration) || (task.duration_minutes ? Number(task.duration_minutes) / 60 : 0) || (task.durationMinutes ? Number(task.durationMinutes) / 60 : 0);
    if (durHours > 0) {
      const base = task.assignedAt || task.assigned_at || task.start_time || task.startTime || task.created_at || (task.id && !isNaN(Number(String(task.id).replace("task_", ""))) ? Number(String(task.id).replace("task_", "")) : null);
      const baseMs = base ? new Date(base).getTime() : Date.now();
      if (!isNaN(baseMs)) {
        return new Date(baseMs + durHours * 3600 * 1000).toISOString();
      }
    }
    return null;
  };

  // Helper: Format countdown remaining
  const formatCountdown = (deadlineStr) => {
    if (!deadlineStr) return null;
    const dl = new Date(deadlineStr).getTime();
    if (isNaN(dl)) return null;

    const diff = dl - now;
    if (diff <= 0) {
      const overdueMins = Math.floor(Math.abs(diff) / 60000);
      const overdueHrs = Math.floor(overdueMins / 60);
      if (overdueHrs > 0) {
        return { isOverdue: true, text: `Overdue by ${overdueHrs}h ${overdueMins % 60}m` };
      }
      return { isOverdue: true, text: `Overdue by ${overdueMins}m` };
    }

    const totalSeconds = Math.floor(diff / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return {
      isOverdue: false,
      text: `${hours > 0 ? `${hours}h ` : ""}${minutes}m ${seconds}s remaining`
    };
  };

  // Helper: Format next progress report countdown (Enforces 5-minute cycle, 10-minute absence penalty)
  const getNextReportDue = (task) => {
    if (!task) return null;
    const todayStr = new Date().toISOString().split("T")[0];
    const sessionKey = `hourly_cycle_${task.id}_${todayStr}`;
    let baseTime = null;

    // 1. If a report was submitted today for this specific task, count 5 mins from that report:
    const lastReport = task.lastReportedAt || task.last_reported_at;
    if (lastReport) {
      const repTime = new Date(lastReport).getTime();
      const isToday = new Date().toDateString() === new Date(repTime).toDateString();
      if (isToday) {
        baseTime = repTime;
      }
    }

    // 2. Check localStorage if this specific task was submitted today in this browser session
    if (!baseTime) {
      const stored = localStorage.getItem(sessionKey);
      if (stored) {
        const storedTime = parseInt(stored, 10);
        if (!isNaN(storedTime) && new Date().toDateString() === new Date(storedTime).toDateString()) {
          baseTime = storedTime;
        }
      }
    }

    // 3. If task was explicitly extended by admin, baseline from extendedAt
    const meta = (task.metadata && typeof task.metadata === 'object') ? task.metadata : {};
    if (!baseTime && meta.extendedAt) {
      baseTime = new Date(meta.extendedAt).getTime();
    }

    // 4. Fallback to this specific task's own assignment time
    if (!baseTime) {
      const assignTime = task.assignedAt || task.assigned_at || task.createdAt || task.created_at;
      if (assignTime) {
        baseTime = new Date(assignTime).getTime();
      }
    }

    if (!baseTime || isNaN(baseTime)) return null;

    const nextDue = baseTime + 5 * 60 * 1000; // 5 minutes cycle
    const diff = nextDue - now;

    if (diff <= 0) {
      const overdueMins = Math.floor(Math.abs(diff) / 60000);
      const totalElapsedMins = Math.floor((now - baseTime) / 60000);
      if (totalElapsedMins >= 10 || task.isAttendanceLocked || task.attendanceStatus === "absent" || task.slaPenaltyApplied || task.sla_penalty_applied) {
        return { isOverdue: true, isLocked: true, text: "Locked (> 10m without report - Absent)" };
      }
      return { isOverdue: true, isLocked: false, text: `Report overdue by ${overdueMins}m` };
    }

    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return { isOverdue: false, text: `Next report in ${mins}m ${secs}s` };
  };

  return (
    <div className="animate-fade-in pb-12">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-black text-text-main tracking-tight">Task & Activity Management</h1>
            <span className={`px-2.5 py-0.5 text-[11px] font-bold uppercase rounded-full ${
              isAdmin ? "bg-purple-500/10 text-purple-600 border border-purple-500/20" : "bg-blue-500/10 text-blue-600 border border-blue-500/20"
            }`}>
              {isAdmin ? "Admin Workspace" : "Employee Portal"}
            </span>
          </div>
          <p className="text-sm text-text-mut font-medium mt-1">
            Real-time task SLA assignment, 1-hour view compliance, and continuous hourly progress reporting.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-3">
          {isAdmin && (
            <button
              onClick={() => setShowAssignModal(true)}
              className="flex items-center gap-2 bg-brand-primary text-white hover:bg-brand-primary/90 px-4 py-2.5 rounded-[12px] font-bold text-xs shadow-sm transition-all cursor-pointer"
            >
              <Plus size={16} />
              Assign New Task
            </button>
          )}

          {!isAdmin && (
            <button
              onClick={() => {
                const isAnyPenalized = tasks.some(t => !t.completed && (
                  (t.attendanceStatus === "absent" && t.isAttendanceLocked) ||
                  t.slaPenaltyApplied ||
                  t.sla_penalty_applied
                ));
                if (isAnyPenalized) {
                  showToast("Reporting is locked: your attendance was marked Absent due to missing reports (> 10m). Please contact Admin to unlock.", "warning");
                  return;
                }
                const availableTasks = tasks.filter(t => {
                  if (t.completed) return false;
                  const dl = getEffectiveDeadline(t);
                  return !(dl && new Date(dl).getTime() < Date.now());
                });
                if (availableTasks.length === 0) {
                  showToast("Task deadline has finished. Functionality is locked because no active tasks are within deadline.", "warning");
                  return;
                }
                const active = availableTasks[0];
                setSelectedTask(active || null);
                setReportTaskId(active ? active.id : "");
                setShowHourlyReportModal(true);
              }}
              className="flex items-center gap-2 bg-brand-primary text-white hover:bg-brand-primary/90 px-4 py-2.5 rounded-[12px] font-bold text-xs shadow-sm transition-all cursor-pointer"
            >
              <Send size={15} />
              Submit Hourly Report
            </button>
          )}
        </div>
      </div>

      {/* Tabs Navigation */}
      <div className="flex border-b border-border-card mb-6 overflow-x-auto custom-scrollbar">
        {isAdmin && (
          <button
            onClick={() => setActiveSubTab("monitoring")}
            className={`pb-3 px-6 text-sm font-bold border-b-2 transition-colors cursor-pointer flex items-center gap-2 whitespace-nowrap ${
              activeSubTab === "monitoring"
                ? "border-brand-primary text-brand-primary"
                : "border-transparent text-text-mut hover:text-text-main"
            }`}
          >
            <Activity size={16} />
            Task Monitoring & SLA
          </button>
        )}

        <button
          onClick={() => setActiveSubTab("my-tasks")}
          className={`pb-3 px-6 text-sm font-bold border-b-2 transition-colors cursor-pointer flex items-center gap-2 whitespace-nowrap ${
            activeSubTab === "my-tasks"
              ? "border-brand-primary text-brand-primary"
              : "border-transparent text-text-mut hover:text-text-main"
          }`}
        >
          <ListTodo size={16} />
          {isAdmin ? "My Personal Tasks" : "My Assigned Tasks"}
          {tasks.filter(t => !t.completed).length > 0 && (
            <span className="bg-brand-primary/10 text-brand-primary px-2 py-0.5 rounded-full text-xs font-black">
              {tasks.filter(t => !t.completed).length}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveSubTab("hourly-reports")}
          className={`pb-3 px-6 text-sm font-bold border-b-2 transition-colors cursor-pointer flex items-center gap-2 whitespace-nowrap ${
            activeSubTab === "hourly-reports"
              ? "border-brand-primary text-brand-primary"
              : "border-transparent text-text-mut hover:text-text-main"
          }`}
        >
          <TrendingUp size={16} />
          Hourly Progress Reports
          {allHourlyReports.length > 0 && (
            <span className="bg-emerald-500/10 text-emerald-600 px-2 py-0.5 rounded-full text-xs font-black">
              {allHourlyReports.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveSubTab("daily-logs")}
          className={`pb-3 px-6 text-sm font-bold border-b-2 transition-colors cursor-pointer flex items-center gap-2 whitespace-nowrap ${
            activeSubTab === "daily-logs"
              ? "border-brand-primary text-brand-primary"
              : "border-transparent text-text-mut hover:text-text-main"
          }`}
        >
          <Calendar size={16} />
          Daily Activity Log
        </button>
      </div>

      {/* ==================================================================== */}
      {/* 1. ADMIN TASK MONITORING & SLA SECTION */}
      {/* ==================================================================== */}
      {activeSubTab === "monitoring" && isAdmin && (
        <div className="space-y-6">
          {/* KPI Cards Grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <div className="bg-bg-card border border-border-card rounded-[18px] p-4 text-left shadow-sm">
              <span className="text-[11px] font-bold text-text-mut uppercase tracking-wider">Total Tasks</span>
              <p className="text-2xl font-black text-text-main mt-1">{adminMetrics.total}</p>
            </div>

            <div className="bg-bg-card border border-border-card rounded-[18px] p-4 text-left shadow-sm">
              <span className="text-[11px] font-bold text-text-mut uppercase tracking-wider">In Progress</span>
              <p className="text-2xl font-black text-blue-500 mt-1">{adminMetrics.inProgress}</p>
            </div>

            <div className="bg-bg-card border border-border-card rounded-[18px] p-4 text-left shadow-sm">
              <span className="text-[11px] font-bold text-text-mut uppercase tracking-wider">Completed</span>
              <p className="text-2xl font-black text-emerald-500 mt-1">{adminMetrics.completed}</p>
            </div>

            <div className="bg-bg-card border border-border-card rounded-[18px] p-4 text-left shadow-sm">
              <span className="text-[11px] font-bold text-text-mut uppercase tracking-wider">Overdue Tasks</span>
              <p className={`text-2xl font-black mt-1 ${adminMetrics.overdue > 0 ? "text-amber-500" : "text-text-main"}`}>
                {adminMetrics.overdue}
              </p>
            </div>

            <div className="bg-bg-card border border-border-card rounded-[18px] p-4 text-left shadow-sm">
              <span className="text-[11px] font-bold text-text-mut uppercase tracking-wider">Unviewed &gt; 1h SLA</span>
              <p className={`text-2xl font-black mt-1 ${adminMetrics.unviewedSlaBreach > 0 ? "text-red-500" : "text-text-main"}`}>
                {adminMetrics.unviewedSlaBreach}
              </p>
            </div>

            <div className="bg-bg-card border border-border-card rounded-[18px] p-4 text-left shadow-sm">
              <span className="text-[11px] font-bold text-text-mut uppercase tracking-wider">Penalized (Absent)</span>
              <p className={`text-2xl font-black mt-1 ${adminMetrics.penalizedEmployees > 0 ? "text-red-600" : "text-emerald-500"}`}>
                {adminMetrics.penalizedEmployees}
              </p>
            </div>
          </div>

          {/* Filters Bar */}
          <div className="bg-bg-card border border-border-card rounded-[18px] p-4 flex flex-wrap gap-4 items-center justify-between shadow-sm">
            <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[280px]">
              <input
                type="text"
                placeholder="Search tasks or employees..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-bg-base border border-border-card rounded-[10px] px-3.5 py-2 text-xs font-semibold text-text-main placeholder-text-mut focus:outline-none focus:border-brand-primary flex-1 min-w-[200px]"
              />

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="bg-bg-base border border-border-card rounded-[10px] px-3 py-2 text-xs font-semibold text-text-main focus:outline-none focus:border-brand-primary cursor-pointer"
              >
                <option value="all">All Statuses</option>
                <option value="new">New / Unviewed</option>
                <option value="in-progress">In Progress</option>
                <option value="completed">Completed</option>
                <option value="overdue">Overdue</option>
                <option value="penalized">Penalized (Absent)</option>
              </select>

              <select
                value={assigneeFilter}
                onChange={(e) => setAssigneeFilter(e.target.value)}
                className="bg-bg-base border border-border-card rounded-[10px] px-3 py-2 text-xs font-semibold text-text-main focus:outline-none focus:border-brand-primary cursor-pointer"
              >
                <option value="all">All Employees</option>
                {allCompanyUsers.map(u => (
                  <option key={u.id || u.uid} value={u.id || u.uid}>{u.name} ({u.department || "General"})</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={refreshAdminTasks}
                className="flex items-center gap-1.5 px-3 py-2 border border-border-card hover:bg-bg-base rounded-[10px] text-xs font-bold text-text-sec transition-all cursor-pointer"
              >
                <RotateCcw size={14} />
                Refresh
              </button>
            </div>
          </div>

          {/* Task Monitoring Table */}
          <div className="bg-bg-card border border-border-card rounded-[20px] overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-bg-base/60 border-b border-border-card text-text-mut uppercase font-extrabold text-[10px] tracking-wider">
                    <th className="py-3.5 px-4">Task Details</th>
                    <th className="py-3.5 px-4">Assigned To</th>
                    <th className="py-3.5 px-4">Start Time & Deadline</th>
                    <th className="py-3.5 px-4">1-Hour SLA Status</th>
                    <th className="py-3.5 px-4">Attendance Status</th>
                    <th className="py-3.5 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-card">
                  {filteredAdminTasks.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-text-mut font-medium">
                        No tasks match the selected criteria.
                      </td>
                    </tr>
                  ) : (
                    filteredAdminTasks.map(t => {
                      const effectiveDeadline = getEffectiveDeadline(t);
                      const countdown = formatCountdown(effectiveDeadline);
                      const isUnviewedSlaViolated = !t.viewed_at && !t.viewedAt && (now - new Date(t.assigned_at || t.created_at).getTime()) > 60 * 60 * 1000;
                      const isAbsent = t.employee_attendance_status === "absent";
                      const isLocked = Boolean(t.employee_is_admin_locked);

                      return (
                        <tr key={t.id} className="hover:bg-bg-base/30 transition-colors">
                          {/* Task details */}
                          <td className="py-3.5 px-4">
                            <div className="font-bold text-text-main">{t.title}</div>
                            {t.description && (
                              <div className="text-[11px] text-text-mut line-clamp-1 mt-0.5">{t.description}</div>
                            )}
                            <div className="flex items-center gap-2 mt-1">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                t.status === "completed" ? "bg-emerald-500/10 text-emerald-600" :
                                t.status === "in-progress" ? "bg-blue-500/10 text-blue-600" :
                                "bg-purple-500/10 text-purple-600"
                              }`}>
                                {t.status === "completed" ? "Completed" : t.status === "in-progress" ? "In Progress" : "New / Assigned"}
                              </span>
                              {t.project_name && (
                                <span className="text-[10px] font-semibold text-text-mut">Project: {t.project_name}</span>
                              )}
                            </div>
                          </td>

                          {/* Assignee */}
                          <td className="py-3.5 px-4">
                            <div className="font-bold text-text-main">{t.assignee_name || t.assigneeName || "Unassigned"}</div>
                            <div className="text-[11px] text-text-mut">{t.assignee_email || ""}</div>
                          </td>

                          {/* Timings */}
                          <td className="py-3.5 px-4">
                            <div className="text-[11px] font-semibold text-text-sec">
                              Start: {t.start_time || new Date(t.assigned_at || t.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </div>
                            <div className="text-[11px] font-bold text-text-main mt-0.5">
                              Deadline: {effectiveDeadline ? new Date(effectiveDeadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }) : (t.duration ? `${t.duration}h duration` : "None")}
                            </div>
                            {countdown && (
                              <div className={`text-[10px] font-bold mt-1 ${countdown.isOverdue ? "text-amber-500 font-extrabold" : "text-emerald-500"}`}>
                                {countdown.text}
                              </div>
                            )}
                          </td>

                          {/* 1-Hour SLA Status */}
                          <td className="py-3.5 px-4">
                            {t.viewed_at || t.viewedAt ? (
                              <span className="inline-flex items-center gap-1 text-emerald-600 font-bold bg-emerald-500/10 px-2 py-0.5 rounded-full text-[11px]">
                                <Eye size={12} />
                                Viewed at {new Date(t.viewed_at || t.viewedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            ) : isUnviewedSlaViolated ? (
                              <span className="inline-flex items-center gap-1 text-red-600 font-bold bg-red-500/10 px-2 py-0.5 rounded-full text-[11px]">
                                <AlertTriangle size={12} />
                                SLA Breached (&gt;1h Unviewed)
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-purple-600 font-bold bg-purple-500/10 px-2 py-0.5 rounded-full text-[11px] animate-pulse">
                                <Clock size={12} />
                                Awaiting Employee View
                              </span>
                            )}
                          </td>

                          {/* Attendance Status */}
                          <td className="py-3.5 px-4">
                            {isAbsent ? (
                              <div className="space-y-1">
                                <span className="inline-flex items-center gap-1 text-red-600 font-extrabold bg-red-500/15 border border-red-500/30 px-2.5 py-1 rounded-full text-[11px]">
                                  <ShieldAlert size={12} />
                                  Marked Absent
                                </span>
                                {t.employee_penalty_reason && (
                                  <div className="text-[10px] text-red-500 font-medium max-w-[180px] line-clamp-2">
                                    {t.employee_penalty_reason}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-emerald-600 font-bold bg-emerald-500/10 px-2 py-0.5 rounded-full text-[11px]">
                                <Check size={12} />
                                Present
                              </span>
                            )}
                          </td>

                          {/* Actions */}
                          <td className="py-3.5 px-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {isAbsent && isLocked && (
                                <button
                                  onClick={() => {
                                    setSelectedAttendanceRecord({
                                      id: t.attendance_id || t.attendanceId || t.assigned_to,
                                      userName: t.assignee_name || t.assigneeName,
                                      taskTitle: t.title
                                    });
                                    setShowRevertModal(true);
                                  }}
                                  className="inline-flex items-center gap-1 bg-red-500/10 text-red-600 hover:bg-red-500 hover:text-white px-2.5 py-1.5 rounded-[8px] font-bold text-xs transition-colors cursor-pointer"
                                  title="Admin override: restore attendance to Present"
                                >
                                  <Unlock size={12} />
                                  Unlock / Revert
                                </button>
                              )}
                              <button
                                onClick={() => handleDeleteAdminTask(t)}
                                className="p-1.5 text-text-mut hover:text-red-500 hover:bg-red-500/10 rounded-[8px] transition-colors cursor-pointer"
                                title="Delete Task"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* 2. MY ASSIGNED TASKS (EMPLOYEE VIEW & PM PERSONAL TASKS) */}
      {/* ==================================================================== */}
      {activeSubTab === "my-tasks" && (
        <div className="space-y-6">
          {loading ? (
            <div className="flex justify-center p-12 text-text-mut font-semibold">Loading assigned tasks...</div>
          ) : tasks.length === 0 ? (
            <div className="bg-bg-card border border-border-card rounded-[24px] p-12 text-center flex flex-col items-center shadow-sm">
              <div className="w-16 h-16 bg-brand-primary/10 rounded-full flex items-center justify-center mb-4">
                <CheckCircle size={32} className="text-brand-primary" />
              </div>
              <h3 className="text-lg font-bold text-text-main">No Tasks Assigned</h3>
              <p className="text-xs text-text-sec max-w-sm mt-2">
                You have no active tasks assigned right now. When an administrator assigns a task, it will appear here immediately with a 1-hour view acknowledgement requirement.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Active & New Tasks Column */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="font-extrabold text-sm text-text-main uppercase tracking-wider flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse"></span>
                    Active & New Tasks ({tasks.filter(t => !t.completed).length})
                  </h2>
                </div>

                {tasks.filter(t => !t.completed).length === 0 ? (
                  <div className="p-8 border border-dashed border-border-card rounded-[18px] text-center text-text-mut text-xs">
                    No active tasks currently pending.
                  </div>
                ) : (
                  tasks.filter(t => !t.completed).map((task) => {
                    const effectiveDeadline = getEffectiveDeadline(task);
                    const countdown = formatCountdown(effectiveDeadline);
                    const nextReport = getNextReportDue(task);
                    const isNew = task.status === "new" || (!task.viewed_at && !task.viewedAt);
                    const isPenalized = Boolean(
                      (task.attendanceStatus === "absent" && task.isAttendanceLocked) ||
                      task.slaPenaltyApplied ||
                      task.sla_penalty_applied ||
                      (nextReport && nextReport.isLocked)
                    );
                    const isDeadlineFinished = Boolean(
                      !isAdmin && (
                        (countdown && countdown.isOverdue) ||
                        (effectiveDeadline && new Date(effectiveDeadline).getTime() < now)
                      )
                    );
                    const isTaskBlocked = Boolean(!isAdmin && (isDeadlineFinished || isPenalized));

                    return (
                      <div
                        key={task.id}
                        className={`bg-bg-card border rounded-[20px] p-5 shadow-sm transition-all relative overflow-hidden text-left ${
                          isDeadlineFinished
                            ? "border-amber-500/50 bg-amber-500/[0.03]"
                            : isPenalized 
                              ? "border-red-500/40 bg-red-500/[0.02]" 
                              : isNew 
                                ? "border-brand-primary/50 shadow-brand-primary/5" 
                                : "border-border-card hover:border-brand-primary/30"
                        }`}
                      >
                        {/* Status bar */}
                        <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${
                          isDeadlineFinished
                            ? "bg-amber-500"
                            : isPenalized ? "bg-red-500" : isNew ? "bg-brand-primary animate-pulse" : "bg-blue-500"
                        }`}></div>

                        <div className="flex justify-between items-start mb-2">
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="font-bold text-base text-text-main">{task.title}</h3>
                              {isNew && (
                                <span className="bg-brand-primary text-white text-[10px] font-black uppercase px-2 py-0.5 rounded-full animate-bounce">
                                  New
                                </span>
                              )}
                              {isPenalized && (
                                <span className="bg-red-500 text-white text-[10px] font-black uppercase px-2 py-0.5 rounded-full flex items-center gap-1">
                                  <ShieldAlert size={10} />
                                  Attendance Penalized (Absent)
                                </span>
                              )}
                              {isDeadlineFinished && (
                                <span className="bg-amber-500/20 text-amber-400 border border-amber-500/30 text-[10px] font-black uppercase px-2 py-0.5 rounded-full flex items-center gap-1">
                                  <Lock size={10} />
                                  Deadline Expired (Locked)
                                </span>
                              )}
                            </div>
                            {task.project && (
                              <span className="text-[11px] font-semibold text-text-mut">Project: {task.project}</span>
                            )}
                          </div>

                          {/* Complete action */}
                          <button
                            onClick={() => {
                              if (isDeadlineFinished) {
                                showToast("Task deadline has finished. Functionality is locked for this task.", "warning");
                                return;
                              }
                              if (isPenalized) {
                                showToast("Task actions are locked because attendance was marked Absent. Please contact your Admin.", "warning");
                                return;
                              }
                              handleMarkComplete(task, true);
                            }}
                            disabled={isTaskBlocked}
                            className={`flex-shrink-0 w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all ${
                              isTaskBlocked
                                ? "border-red-500/40 text-red-400/70 bg-red-500/10 cursor-not-allowed opacity-60"
                                : "border-border-card text-transparent hover:border-emerald-500 hover:text-emerald-500 hover:bg-emerald-500/10 transition-all cursor-pointer"
                            }`}
                            title={isDeadlineFinished ? "Task deadline has finished. Completion is locked." : "Mark as completed (triggers SLA evaluation)"}
                          >
                            {isDeadlineFinished ? <Lock size={14} /> : <CheckCircle size={16} />}
                          </button>
                        </div>

                        {task.description && (
                          <p className="text-xs text-text-sec mt-2 mb-3 bg-bg-base/40 p-2.5 rounded-[12px] border border-border-card/50">
                            {task.description}
                          </p>
                        )}

                        {/* Deadlines & Timers */}
                        <div className="grid grid-cols-2 gap-2 my-3 p-3 bg-bg-base/50 rounded-[14px] border border-border-card">
                          <div>
                            <span className="text-[10px] font-bold text-text-mut uppercase block">Task Deadline</span>
                            <span className="text-xs font-bold text-text-main">
                              {effectiveDeadline ? (
                                new Date(effectiveDeadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
                              ) : task.duration ? (
                                `${task.duration} hours`
                              ) : (
                                "No deadline"
                              )}
                            </span>
                            {countdown && (
                              <span className={`text-[10px] font-extrabold block mt-0.5 ${countdown.isOverdue ? "text-amber-500" : "text-emerald-500"}`}>
                                {countdown.text}
                              </span>
                            )}
                          </div>

                          <div>
                            <span className="text-[10px] font-bold text-text-mut uppercase block">Hourly Report</span>
                            {isDeadlineFinished ? (
                              <span className="text-xs font-bold text-amber-500 flex items-center gap-1 mt-0.5">
                                <Lock size={11} /> Locked (Deadline passed)
                              </span>
                            ) : isPenalized ? (
                              <span className="text-xs font-bold text-red-500 flex items-center gap-1 mt-0.5">
                                <Lock size={11} /> Locked (Absent Penalty)
                              </span>
                            ) : nextReport ? (
                              <span className={`text-xs font-bold block ${nextReport.isOverdue ? "text-red-500 font-extrabold" : "text-blue-500"}`}>
                                {nextReport.text}
                              </span>
                            ) : (
                              <span className="text-xs font-bold text-text-sec">Due every 5m</span>
                            )}
                          </div>
                        </div>

                        {/* Overdue deadline warning alert */}
                        {isDeadlineFinished && (
                          <div className="mb-3 p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-[12px] flex items-center gap-2 text-[11px] text-amber-500 font-semibold">
                            <Lock size={14} className="flex-shrink-0" />
                            <span>Task deadline has expired. All employee modifications are locked. Contact your administrator if an extension is required.</span>
                          </div>
                        )}

                        {/* Attendance Penalized absent warning alert */}
                        {isPenalized && (
                          <div className="mb-3 p-2.5 bg-red-500/10 border border-red-500/20 rounded-[12px] flex items-center gap-2 text-[11px] text-red-500 font-semibold">
                            <ShieldAlert size={14} className="flex-shrink-0" />
                            <span>Task and reporting are locked: no progress report was submitted for &gt; 10 minutes and attendance was marked Absent. Contact your Administrator to unlock.</span>
                          </div>
                        )}

                        {/* Action buttons on card */}
                        <div className="flex items-center justify-between gap-3 pt-2 border-t border-border-card/60">
                          <button
                            onClick={() => {
                              if (isDeadlineFinished) {
                                showToast("Task deadline has finished. Progress reporting is locked.", "warning");
                                return;
                              }
                              if (isPenalized) {
                                showToast("Reporting is locked because attendance was marked Absent due to missing reports (> 10m). Please contact Admin to unlock.", "warning");
                                return;
                              }
                              setSelectedTask(task);
                              setReportTaskId(task.id);
                              setShowHourlyReportModal(true);
                            }}
                            disabled={isTaskBlocked}
                            className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-[10px] text-xs font-bold transition-all ${
                              isDeadlineFinished
                                ? "bg-amber-500/10 text-amber-400/70 border border-amber-500/20 cursor-not-allowed opacity-60"
                                : isPenalized
                                  ? "bg-red-500/10 text-red-400/70 border border-red-500/20 cursor-not-allowed opacity-60"
                                  : "bg-brand-primary/10 text-brand-primary hover:bg-brand-primary hover:text-white rounded-[10px] text-xs font-bold transition-all cursor-pointer"
                            }`}
                            title={isDeadlineFinished ? "Task deadline has finished. Reporting is locked." : isPenalized ? "Reporting locked: attendance marked Absent." : "Submit Hourly Report"}
                          >
                            {isDeadlineFinished ? <Lock size={13} /> : isPenalized ? <Lock size={13} /> : <Send size={13} />}
                            {isDeadlineFinished ? "Deadline Expired (Locked)" : isPenalized ? "Reporting Locked (Absent)" : "Submit Hourly Report"}
                          </button>

                          <button
                            onClick={() => {
                              setSelectedTask(task);
                              setShowTaskDetailsModal(true);
                            }}
                            className="flex items-center gap-1.5 py-2 px-3 border border-border-card hover:bg-bg-base rounded-[10px] text-xs font-semibold text-text-sec transition-all cursor-pointer"
                          >
                            <FileText size={13} />
                            History
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Completed Tasks Column */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="font-extrabold text-sm text-text-main uppercase tracking-wider flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
                    Completed Tasks ({tasks.filter(t => t.completed).length})
                  </h2>
                </div>

                {tasks.filter(t => t.completed).length === 0 ? (
                  <div className="p-8 border border-dashed border-border-card rounded-[18px] text-center text-text-mut text-xs">
                    No completed tasks yet.
                  </div>
                ) : (
                  tasks.filter(t => t.completed).map((task) => (
                    <div
                      key={task.id}
                      className="bg-bg-card border border-border-card/60 rounded-[18px] p-4 shadow-sm opacity-80 hover:opacity-100 transition-opacity text-left"
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <h4 className="font-bold text-sm text-text-main line-through">{task.title}</h4>
                          <span className={`inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            task.completionStatus === "completed_on_time" 
                              ? "bg-emerald-500/10 text-emerald-600" 
                              : "bg-amber-500/10 text-amber-600"
                          }`}>
                            {task.completionStatus === "completed_on_time" ? "Finished Within Deadline" : "Finished Overdue"}
                          </span>
                        </div>

                        <button
                          onClick={() => {
                            const eff = getEffectiveDeadline(task);
                            if (!isAdmin && eff && new Date(eff).getTime() < Date.now()) {
                              showToast("Cannot reopen task: deadline has expired.", "warning");
                              return;
                            }
                            handleMarkComplete(task, false);
                          }}
                          className="text-[11px] font-bold text-text-mut hover:text-brand-primary cursor-pointer"
                        >
                          Reopen
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* 3. HOURLY PROGRESS REPORTS STREAM */}
      {/* ==================================================================== */}
      {activeSubTab === "hourly-reports" && (
        <div className="space-y-6">
          <div className="flex items-center justify-between flex-wrap gap-4 bg-bg-card border border-border-card rounded-[20px] p-5 shadow-sm">
            <div>
              <h2 className="text-base font-extrabold text-text-main">Chronological Progress Reports Stream</h2>
              <p className="text-xs text-text-mut mt-0.5">
                {isAdmin 
                  ? "Audit employee hourly submissions, track project percentages, and inspect blockers in real time."
                  : "Review your submitted hourly progress updates and verification logs."}
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={refreshHourlyReports}
                className="flex items-center gap-1.5 px-3.5 py-2 border border-border-card hover:bg-bg-base rounded-[10px] text-xs font-bold text-text-sec transition-all cursor-pointer"
              >
                <RotateCcw size={14} />
                Refresh Reports
              </button>
            </div>
          </div>

          {reportsLoading && allHourlyReports.length === 0 ? (
            <div className="flex justify-center p-12 text-text-mut font-semibold">Loading progress reports...</div>
          ) : allHourlyReports.length === 0 ? (
            <div className="bg-bg-card border border-border-card rounded-[24px] p-12 text-center flex flex-col items-center shadow-sm">
              <div className="w-16 h-16 bg-blue-500/10 rounded-full flex items-center justify-center mb-4">
                <TrendingUp size={32} className="text-blue-500" />
              </div>
              <h3 className="text-lg font-bold text-text-main">No Hourly Reports Submitted Today</h3>
              <p className="text-xs text-text-sec max-w-sm mt-2">
                Employees are required to submit hourly progress updates while actively working on tasks.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {allHourlyReports.map((rep) => (
                <div
                  key={rep.id}
                  className="bg-bg-card border border-border-card rounded-[20px] p-5 shadow-sm text-left hover:border-brand-primary/30 transition-all"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-border-card/60">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm text-text-main">{rep.user_name || "Employee"}</span>
                        <span className="text-xs text-text-mut">({rep.user_email || "Active User"})</span>
                        <span className="bg-blue-500/10 text-blue-600 px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase">
                          Hour #{rep.report_hour || 1}
                        </span>
                      </div>
                      <div className="text-xs font-semibold text-brand-primary mt-0.5">
                        Task: {rep.task_title || "General Workplace Shift"}
                      </div>
                    </div>

                    <div className="text-right flex items-center sm:flex-col sm:items-end justify-between gap-1">
                      <span className="text-[11px] font-bold text-text-mut">
                        {new Date(rep.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <span className="text-[10px] text-text-sec font-semibold">
                        {new Date(rep.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4">
                    {/* Work Completed */}
                    <div className="space-y-1">
                      <span className="text-[11px] font-extrabold text-emerald-600 uppercase tracking-wider block">
                        Work Completed
                      </span>
                      <p className="text-xs text-text-main font-medium leading-relaxed bg-bg-base/40 p-2.5 rounded-[12px] border border-border-card/40">
                        {rep.work_completed || rep.summary || "No description provided."}
                      </p>
                    </div>

                    {/* Pending Work */}
                    <div className="space-y-1">
                      <span className="text-[11px] font-extrabold text-blue-600 uppercase tracking-wider block">
                        Pending Work (Next Hour)
                      </span>
                      <p className="text-xs text-text-main font-medium leading-relaxed bg-bg-base/40 p-2.5 rounded-[12px] border border-border-card/40">
                        {rep.pending_work || rep.next_hour_plan || "Proceeding on current milestone."}
                      </p>
                    </div>

                    {/* Progress & Blockers */}
                    <div className="space-y-2">
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <span className="text-[11px] font-extrabold text-text-mut uppercase">Progress</span>
                          <span className="text-xs font-black text-brand-primary">{rep.progress_percentage || 0}%</span>
                        </div>
                        <div className="w-full bg-bg-base rounded-full h-2 overflow-hidden border border-border-card">
                          <div
                            className="bg-brand-primary h-full rounded-full transition-all duration-500"
                            style={{ width: `${Math.min(100, Math.max(0, rep.progress_percentage || 0))}%` }}
                          ></div>
                        </div>
                      </div>

                      {rep.issues_blockers || rep.challenges ? (
                        <div className="p-2 rounded-[10px] bg-amber-500/10 border border-amber-500/20 text-amber-600 text-[11px] font-medium">
                          <strong>Blockers:</strong> {rep.issues_blockers || rep.challenges}
                        </div>
                      ) : (
                        <div className="text-[11px] text-emerald-600 font-semibold flex items-center gap-1">
                          <Check size={12} /> No blockers reported
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* 4. DAILY ACTIVITY LOG (PRESERVED FUNCTIONALITY) */}
      {/* ==================================================================== */}
      {activeSubTab === "daily-logs" && (
        <div className="space-y-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-bg-card border border-border-card rounded-[20px] p-5 shadow-sm">
            <div>
              <h2 className="text-base font-extrabold text-text-main">Daily Activity Log History</h2>
              <p className="text-xs text-text-mut mt-0.5">Summary of work logs, daily tasks done, and exported audit logs.</p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowAddLogModal(true)}
                className="flex items-center gap-2 bg-brand-primary text-white hover:bg-brand-primary/90 px-4 py-2 rounded-[12px] font-bold text-xs shadow-sm transition-all cursor-pointer"
              >
                <Plus size={15} />
                Add Daily Log
              </button>
            </div>
          </div>

          {dailyReports.length === 0 ? (
            <div className="bg-bg-card border border-border-card rounded-[24px] p-12 text-center flex flex-col items-center shadow-sm">
              <Calendar size={32} className="text-text-mut mb-3" />
              <h3 className="text-base font-bold text-text-main">No Daily Activity Logs</h3>
              <p className="text-xs text-text-sec mt-1">Record your first daily activity log to maintain comprehensive history.</p>
            </div>
          ) : (
            <div className="bg-bg-card border border-border-card rounded-[20px] overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-bg-base/60 border-b border-border-card text-text-mut uppercase font-extrabold text-[10px] tracking-wider">
                      <th className="py-3 px-4">Date</th>
                      <th className="py-3 px-4">Hours</th>
                      <th className="py-3 px-4">Tasks Completed</th>
                      <th className="py-3 px-4">Issues Faced</th>
                      <th className="py-3 px-4">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-card">
                    {dailyReports.map((log) => (
                      <tr key={log.id} className="hover:bg-bg-base/30 transition-colors">
                        <td className="py-3.5 px-4 font-bold text-text-main">{log.date}</td>
                        <td className="py-3.5 px-4 font-semibold text-text-sec">{log.hours || 8}h</td>
                        <td className="py-3.5 px-4 text-text-main max-w-xs">{log.tasksCompleted || log.tasks_done || "—"}</td>
                        <td className="py-3.5 px-4 text-text-sec max-w-xs">{log.issuesFaced || log.blockers || "None"}</td>
                        <td className="py-3.5 px-4">
                          <span className="bg-emerald-500/10 text-emerald-600 px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase">
                            {log.status || "Completed"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL: ADMIN ASSIGN TASK */}
      {/* ==================================================================== */}
      {showAssignModal && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-bg-card border border-border-card rounded-[24px] max-w-xl w-full p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto custom-scrollbar">
            <div className="flex justify-between items-center pb-4 border-b border-border-card mb-5">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full bg-brand-primary/10 flex items-center justify-center text-brand-primary">
                  <ListTodo size={18} />
                </div>
                <h3 className="font-extrabold text-base text-text-main">Assign New Employee Task</h3>
              </div>
              <button onClick={() => setShowAssignModal(false)} className="text-text-mut hover:text-text-main cursor-pointer">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleAssignTaskSubmit} className="space-y-4 text-left">
              <div>
                <label className="text-xs font-bold text-text-main block mb-1.5">Task Title *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Implement OAuth Flow or Security Audit"
                  value={assignTitle}
                  onChange={(e) => setAssignTitle(e.target.value)}
                  className="w-full bg-bg-base border border-border-card rounded-[12px] p-3 text-xs font-semibold text-text-main focus:outline-none focus:border-brand-primary"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-text-main block mb-1.5">Assign To Employee *</label>
                  <select
                    required
                    value={assignEmployeeId}
                    onChange={(e) => setAssignEmployeeId(e.target.value)}
                    className="w-full bg-bg-base border border-border-card rounded-[12px] p-3 text-xs font-semibold text-text-main focus:outline-none focus:border-brand-primary cursor-pointer"
                  >
                    <option value="">Select Employee...</option>
                    {allCompanyUsers.map(u => (
                      <option key={u.id || u.uid} value={u.id || u.uid}>
                        {u.name} — {u.department || "General"}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-bold text-text-main block mb-1.5">Project (Optional)</label>
                  <select
                    value={assignProjectId}
                    onChange={(e) => setAssignProjectId(e.target.value)}
                    className="w-full bg-bg-base border border-border-card rounded-[12px] p-3 text-xs font-semibold text-text-main focus:outline-none focus:border-brand-primary cursor-pointer"
                  >
                    <option value="">Select Project...</option>
                    {projects.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-text-main block mb-1.5">Task Start Date & Time</label>
                  <input
                    type="datetime-local"
                    value={assignStartTime}
                    onChange={(e) => setAssignStartTime(e.target.value)}
                    className="w-full bg-bg-base border border-border-card rounded-[12px] p-3 text-xs font-semibold text-text-main focus:outline-none focus:border-brand-primary"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-text-main block mb-1.5">Task Deadline (Target SLA) *</label>
                  <input
                    type="datetime-local"
                    required
                    value={assignDeadline}
                    onChange={(e) => setAssignDeadline(e.target.value)}
                    className="w-full bg-bg-base border border-border-card rounded-[12px] p-3 text-xs font-semibold text-text-main focus:outline-none focus:border-brand-primary"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-text-main block mb-1.5">Priority</label>
                <select
                  value={assignPriority}
                  onChange={(e) => setAssignPriority(e.target.value)}
                  className="w-full bg-bg-base border border-border-card rounded-[12px] p-3 text-xs font-semibold text-text-main focus:outline-none focus:border-brand-primary cursor-pointer"
                >
                  <option value="low">Low Priority</option>
                  <option value="medium">Medium Priority</option>
                  <option value="high">High Priority</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-bold text-text-main block mb-1.5">Task Description</label>
                <textarea
                  rows={3}
                  placeholder="Provide detailed instructions and deliverables..."
                  value={assignDesc}
                  onChange={(e) => setAssignDesc(e.target.value)}
                  className="w-full bg-bg-base border border-border-card rounded-[12px] p-3 text-xs font-semibold text-text-main focus:outline-none focus:border-brand-primary"
                />
              </div>

              <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-[12px] text-[11px] text-blue-600 font-medium">
                <strong>SLA Rule:</strong> The employee will receive an immediate notification with the deadline and must open or acknowledge this task within <strong>1 hour</strong>. If unviewed, attendance is automatically marked absent.
              </div>

              <div className="flex justify-end gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setShowAssignModal(false)}
                  className="px-4 py-2.5 border border-border-card rounded-[10px] text-xs font-bold text-text-sec hover:bg-bg-base cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2.5 bg-brand-primary text-white rounded-[10px] text-xs font-bold hover:bg-brand-primary/90 transition-all cursor-pointer shadow-sm disabled:opacity-50"
                >
                  {submitting ? "Assigning..." : "Assign Task"}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {/* ==================================================================== */}
      {/* MODAL: SUBMIT HOURLY PROGRESS REPORT */}
      {/* ==================================================================== */}
      {showHourlyReportModal && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-bg-card border border-border-card rounded-[24px] max-w-xl w-full p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto custom-scrollbar">
            <div className="flex justify-between items-center pb-4 border-b border-border-card mb-5">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center text-emerald-600">
                  <TrendingUp size={18} />
                </div>
                <h3 className="font-extrabold text-base text-text-main">Submit Hourly Progress Report</h3>
              </div>
              <button onClick={() => setShowHourlyReportModal(false)} className="text-text-mut hover:text-text-main cursor-pointer">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleHourlyReportSubmit} className="space-y-4 text-left">
              <div>
                <label className="text-xs font-bold text-text-main block mb-1.5">Select Active Task *</label>
                <select
                  required
                  value={reportTaskId || (selectedTask ? selectedTask.id : "")}
                  onChange={(e) => {
                    setReportTaskId(e.target.value);
                    const found = tasks.find(t => t.id === e.target.value);
                    if (found) setSelectedTask(found);
                  }}
                  className="w-full bg-bg-base border border-border-card rounded-[12px] p-3 text-xs font-semibold text-text-main focus:outline-none focus:border-brand-primary cursor-pointer"
                >
                  <option value="">Select an assigned task...</option>
                  {tasks.filter(t => !t.completed).map(t => {
                    const effDl = getEffectiveDeadline(t);
                    const isExpired = Boolean(!isAdmin && effDl && new Date(effDl).getTime() < Date.now());
                    return (
                      <option key={t.id} value={t.id} disabled={isExpired}>
                        {t.title} {t.project ? `(${t.project})` : ""} {isExpired ? " [Deadline Finished - Locked]" : ""}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label className="text-xs font-bold text-text-main block mb-1.5">Work Completed During This Hour *</label>
                <textarea
                  required
                  rows={3}
                  placeholder="Detail the code written, research conducted, or bugs fixed..."
                  value={reportWorkCompleted}
                  onChange={(e) => setReportWorkCompleted(e.target.value)}
                  className="w-full bg-bg-base border border-border-card rounded-[12px] p-3 text-xs font-semibold text-text-main focus:outline-none focus:border-brand-primary"
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs font-bold text-text-main">Current Progress Percentage</label>
                  <span className="text-xs font-black text-brand-primary">{reportProgressPercent}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={reportProgressPercent}
                  onChange={(e) => setReportProgressPercent(e.target.value)}
                  className="w-full accent-brand-primary cursor-pointer"
                />
              </div>

              <div>
                <label className="text-xs font-bold text-text-main block mb-1.5">Pending Work (Next Hour Plan) *</label>
                <textarea
                  required
                  rows={2}
                  placeholder="What will you work on during the upcoming hour?"
                  value={reportPendingWork}
                  onChange={(e) => setReportPendingWork(e.target.value)}
                  className="w-full bg-bg-base border border-border-card rounded-[12px] p-3 text-xs font-semibold text-text-main focus:outline-none focus:border-brand-primary"
                />
              </div>

              <div>
                <label className="text-xs font-bold text-text-main block mb-1.5">Issues or Blockers (Optional)</label>
                <textarea
                  rows={2}
                  placeholder="Any roadblocks, dependencies, or unanswered questions..."
                  value={reportIssuesBlockers}
                  onChange={(e) => setReportIssuesBlockers(e.target.value)}
                  className="w-full bg-bg-base border border-border-card rounded-[12px] p-3 text-xs font-semibold text-text-main focus:outline-none focus:border-brand-primary"
                />
              </div>

              <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-[12px] text-[11px] text-amber-600 font-medium">
                <strong>Continuous Compliance Rule:</strong> You must submit a progress report every 5 minutes. If 10 minutes pass without a submission, attendance will be locked as Absent.
              </div>

              <div className="flex justify-end gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setShowHourlyReportModal(false)}
                  className="px-4 py-2.5 border border-border-card rounded-[10px] text-xs font-bold text-text-sec hover:bg-bg-base cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2.5 bg-brand-primary text-white rounded-[10px] text-xs font-bold hover:bg-brand-primary/90 transition-all cursor-pointer shadow-sm disabled:opacity-50"
                >
                  {submitting ? "Submitting..." : "Submit Report"}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {/* ==================================================================== */}
      {/* MODAL: REVERT ATTENDANCE PENALTY (ADMIN ONLY) */}
      {/* ==================================================================== */}
      {showRevertModal && selectedAttendanceRecord && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-bg-card border border-border-card rounded-[24px] max-w-md w-full p-6 shadow-2xl relative text-left">
            <div className="flex justify-between items-center pb-4 border-b border-border-card mb-4">
              <div className="flex items-center gap-2.5 text-amber-500">
                <Unlock size={20} />
                <h3 className="font-extrabold text-base text-text-main">Revert Attendance Penalty</h3>
              </div>
              <button onClick={() => setShowRevertModal(false)} className="text-text-mut hover:text-text-main cursor-pointer">
                <X size={18} />
              </button>
            </div>

            <p className="text-xs text-text-sec mb-4">
              You are about to restore attendance to <strong>Present</strong> and lift the lock for <strong>{selectedAttendanceRecord.userName}</strong>.
            </p>

            <form onSubmit={handleRevertPenaltySubmit} className="space-y-4">
              <div>
                <label className="text-xs font-bold text-text-main block mb-1.5">Administrative Resolution Notes</label>
                <textarea
                  rows={3}
                  required
                  placeholder="Explain why this penalty is being lifted (e.g. system downtime, verified offline work)..."
                  value={revertNotes}
                  onChange={(e) => setRevertNotes(e.target.value)}
                  className="w-full bg-bg-base border border-border-card rounded-[12px] p-3 text-xs font-semibold text-text-main focus:outline-none focus:border-brand-primary"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowRevertModal(false)}
                  className="px-4 py-2 border border-border-card rounded-[10px] text-xs font-bold text-text-sec hover:bg-bg-base cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 bg-emerald-600 text-white rounded-[10px] text-xs font-bold hover:bg-emerald-700 transition-all cursor-pointer shadow-sm disabled:opacity-50"
                >
                  {submitting ? "Reverting..." : "Revert & Unlock"}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {/* ==================================================================== */}
      {/* MODAL: ADD DAILY LOG (PRESERVED) */}
      {/* ==================================================================== */}
      {showAddLogModal && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-bg-card border border-border-card rounded-[24px] max-w-lg w-full p-6 shadow-2xl relative text-left">
            <div className="flex justify-between items-center pb-4 border-b border-border-card mb-4">
              <h3 className="font-extrabold text-base text-text-main">Add Daily Activity Log</h3>
              <button onClick={() => setShowAddLogModal(false)} className="text-text-mut hover:text-text-main cursor-pointer">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={async (e) => {
              e.preventDefault();
              if (!logTasksCompleted.trim()) return showToast("Tasks completed is required.", "warning");
              setSubmitting(true);
              try {
                await addDailyReport(currentUser.uid, {
                  date: logDate,
                  hours: logHours,
                  tasksCompleted: logTasksCompleted,
                  issuesFaced: logIssuesFaced,
                  status: logStatus
                });
                showToast("Daily activity log saved!", "success");
                setShowAddLogModal(false);
                setLogTasksCompleted("");
                setLogIssuesFaced("");
              } catch (err) {
                showToast("Failed to save log.", "error");
              } finally {
                setSubmitting(false);
              }
            }} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-text-main block mb-1">Date</label>
                  <input
                    type="date"
                    value={logDate}
                    onChange={(e) => setLogDate(e.target.value)}
                    className="w-full bg-bg-base border border-border-card rounded-[10px] p-2.5 text-xs text-text-main"
                  />
                </div>
                <div>
                  <label className="text-xs font-bold text-text-main block mb-1">Hours Spent</label>
                  <input
                    type="number"
                    min="1"
                    max="24"
                    value={logHours}
                    onChange={(e) => setLogHours(e.target.value)}
                    className="w-full bg-bg-base border border-border-card rounded-[10px] p-2.5 text-xs text-text-main"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-text-main block mb-1">Tasks Completed *</label>
                <textarea
                  required
                  rows={3}
                  value={logTasksCompleted}
                  onChange={(e) => setLogTasksCompleted(e.target.value)}
                  placeholder="Summary of daily deliverables..."
                  className="w-full bg-bg-base border border-border-card rounded-[10px] p-2.5 text-xs text-text-main"
                />
              </div>

              <div>
                <label className="text-xs font-bold text-text-main block mb-1">Issues Faced</label>
                <textarea
                  rows={2}
                  value={logIssuesFaced}
                  onChange={(e) => setLogIssuesFaced(e.target.value)}
                  placeholder="Any technical or logistical obstacles..."
                  className="w-full bg-bg-base border border-border-card rounded-[10px] p-2.5 text-xs text-text-main"
                />
              </div>

              <div className="flex justify-end gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setShowAddLogModal(false)}
                  className="px-4 py-2 border border-border-card rounded-[10px] text-xs font-bold text-text-sec cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 bg-brand-primary text-white rounded-[10px] text-xs font-bold hover:bg-brand-primary/90 cursor-pointer disabled:opacity-50"
                >
                  Save Log
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
