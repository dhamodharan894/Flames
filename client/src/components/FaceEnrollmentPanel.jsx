import { useEffect, useMemo, useState } from "react";
import CameraCapture from "./CameraCapture";
import {
  authorizeFaceEnrollment,
  enrollFace,
  getFaceEnrollmentStatus,
  getVerificationAttempts,
  reviewVerificationAttempt,
  getFaceReenrollmentRequests,
  approveFaceReenrollmentRequest,
  rejectFaceReenrollmentRequest
} from "../firebase";
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Search,
  Camera,
  UserCheck,
  UserX,
  Clock,
  Eye,
  Filter,
  ChevronRight,
  FileText
} from "lucide-react";

export default function FaceEnrollmentPanel({ users, showToast }) {
  const [activeSubTab, setActiveSubTab] = useState("enrollment"); // "enrollment" | "verification-review"
  const [employees, setEmployees] = useState([]);
  const [enrollmentStatuses, setEnrollmentStatuses] = useState({});
  const [selectedId, setSelectedId] = useState("");
  const [consentRecorded, setConsentRecorded] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [replacementTarget, setReplacementTarget] = useState(null);
  const [isReplacementSession, setIsReplacementSession] = useState(false);
  const [busy, setBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const staffList = useMemo(() => Array.isArray(users) ? users : [], [users]);

  // Verification Review Queue States
  const [attempts, setAttempts] = useState([]);
  const [attemptsLoading, setAttemptsLoading] = useState(false);
  const [reviewFilter, setReviewFilter] = useState("pending"); // "all" | "pending" | "approved" | "rejected"
  const [reviewSearch, setReviewSearch] = useState("");
  const [selectedAttemptForReview, setSelectedAttemptForReview] = useState(null);
  const [reviewDecision, setReviewDecision] = useState("approved");
  const [reviewNote, setReviewNote] = useState("");
  const [submittingReview, setSubmittingReview] = useState(false);

  // Re-enrollment Requests States
  const [reenrollmentRequests, setReenrollmentRequests] = useState([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestStatusFilter, setRequestStatusFilter] = useState("pending");
  const [requestSearch, setRequestSearch] = useState("");
  const [processingRequestId, setProcessingRequestId] = useState(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [selectedRequestForReview, setSelectedRequestForReview] = useState(null);

  useEffect(() => {
    if (!staffList.length) return;

    let cancelled = false;
    const loadEnrollmentStatuses = async () => {
      const nextStatuses = {};

      for (const emp of staffList) {
        const userId = emp.uid || emp.id;
        if (!userId) continue;

        try {
          const status = await getFaceEnrollmentStatus(userId);
          nextStatuses[userId] = status || { enrollment_status: "pending", metadata: {} };
        } catch {
          nextStatuses[userId] = { enrollment_status: "pending", metadata: {} };
        }
      }

      if (!cancelled) {
        setEnrollmentStatuses(nextStatuses);
      }
    };

    loadEnrollmentStatuses();
    return () => {
      cancelled = true;
    };
  }, [staffList]);

  const loadAttempts = async () => {
    setAttemptsLoading(true);
    try {
      const data = await getVerificationAttempts();
      setAttempts(Array.isArray(data) ? data : []);
    } catch (err) {
      showToast(err.message || "Failed to load verification attempts.", "error");
    } finally {
      setAttemptsLoading(false);
    }
  };

  const loadReenrollmentRequests = async (status = requestStatusFilter) => {
    setRequestsLoading(true);
    try {
      const data = await getFaceReenrollmentRequests(status === "all" ? "" : status);
      setReenrollmentRequests(Array.isArray(data) ? data : []);
    } catch (err) {
      showToast(err.message || "Failed to load face re-enrollment requests.", "error");
    } finally {
      setRequestsLoading(false);
    }
  };

  useEffect(() => {
    loadAttempts();
  }, []);

  useEffect(() => {
    loadReenrollmentRequests(requestStatusFilter);
  }, [requestStatusFilter]);

  const selectedEmployee = staffList.find(u => (u.uid || u.id) === selectedId);
  const selectedStatus = selectedId ? enrollmentStatuses[selectedId] : null;
  const isAuthorized = Boolean(selectedStatus?.metadata?.selfEnrollmentAuthorized);

  const handleAuthorize = async (empId) => {
    const targetId = empId || selectedId;
    if (!targetId) return showToast("Select an employee first.", "warning");
    setBusy(true);
    try {
      await authorizeFaceEnrollment(targetId);
      setEnrollmentStatuses(prev => ({
        ...prev,
        [targetId]: {
          ...(prev[targetId] || {}),
          metadata: { ...(prev[targetId]?.metadata || {}), selfEnrollmentAuthorized: true }
        }
      }));
      showToast("Self-enrollment successfully authorized for employee.", "success");
    } catch (err) {
      showToast(err.message || "Unable to authorize enrollment.", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleInitiateEnrollment = (emp) => {
    if (!emp) return;
    const id = emp.uid || emp.id;
    const isEnrolled = enrollmentStatuses[id]?.enrollment_status === "enrolled";
    setSelectedId(id);
    if (isEnrolled) {
      setReplacementTarget(emp);
    } else {
      setIsReplacementSession(false);
      setConsentRecorded(true);
      setShowCamera(true);
    }
  };

  const handleConfirmReplacement = () => {
    if (!replacementTarget) return;
    const id = replacementTarget.uid || replacementTarget.id;
    setSelectedId(id);
    setIsReplacementSession(true);
    setConsentRecorded(true);
    setReplacementTarget(null);
    setShowCamera(true);
  };

  const handleCaptureComplete = async (imageBase64) => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const res = await enrollFace(imageBase64, consentRecorded, selectedId);
      setShowCamera(false);
      setConsentRecorded(false);

      // Refresh employee's biometric status and enrollment timestamp
      try {
        const refreshedStatus = await getFaceEnrollmentStatus(selectedId);
        setEnrollmentStatuses(prev => ({
          ...prev,
          [selectedId]: refreshedStatus
        }));
      } catch {
        setEnrollmentStatuses(prev => ({
          ...prev,
          [selectedId]: {
            ...(prev[selectedId] || {}),
            enrollment_status: "enrolled",
            enrolled_at: res?.enrolled_at || new Date().toISOString()
          }
        }));
      }

      const empObj = staffList.find(u => (u.uid || u.id) === selectedId) || selectedEmployee;
      const empName = empObj?.name || "Employee";

      if (res?.mode === "replacement" || isReplacementSession) {
        showToast(`Face template successfully replaced and validated for ${empName}.`, "success");
      } else {
        showToast(`Biometric enrollment template saved for ${empName}. Raw image was not stored.`, "success");
      }
    } catch (err) {
      showToast(err.message || "Face enrollment failed.", "error");
    } finally {
      setIsReplacementSession(false);
      setBusy(false);
    }
  };

  const handleOpenReviewModal = (attempt) => {
    setSelectedAttemptForReview(attempt);
    setReviewDecision("approved");
    setReviewNote("");
  };

  const handleSubmitReview = async () => {
    if (!selectedAttemptForReview) return;
    setSubmittingReview(true);
    try {
      const res = await reviewVerificationAttempt(
        selectedAttemptForReview.id,
        reviewDecision,
        reviewNote
      );
      setAttempts(prev =>
        prev.map(a =>
          a.id === selectedAttemptForReview.id
            ? {
                ...a,
                review_status: res.review_status,
                reviewed_by: res.reviewed_by,
                reviewed_at: res.reviewed_at,
                review_note: res.review_note,
                review_decision: reviewDecision
              }
            : a
        )
      );
      showToast(`Verification attempt ${reviewDecision === "approved" ? "approved" : "rejected"} successfully.`, "success");
      setSelectedAttemptForReview(null);
    } catch (err) {
      showToast(err.message || "Failed to submit review decision.", "error");
    } finally {
      setSubmittingReview(false);
    }
  };

  const handleApproveRequest = async (requestId) => {
    if (!requestId) return;
    setProcessingRequestId(requestId);
    try {
      const res = await approveFaceReenrollmentRequest(requestId);
      setReenrollmentRequests(prev =>
        prev.map(item => item.id === requestId ? { ...item, ...res?.request, status: "approved" } : item)
      );
      showToast("Face re-enrollment request approved.", "success");
    } catch (err) {
      showToast(err.message || "Failed to approve the request.", "error");
    } finally {
      setProcessingRequestId(null);
    }
  };

  const handleRejectRequest = async (requestId, reasonOverride = "") => {
    if (!requestId) return;
    setProcessingRequestId(requestId);
    try {
      const res = await rejectFaceReenrollmentRequest(requestId, reasonOverride || rejectionReason || "Not provided");
      setReenrollmentRequests(prev =>
        prev.map(item => item.id === requestId ? { ...item, ...res?.request, status: "rejected" } : item)
      );
      setRejectionReason("");
      setSelectedRequestForReview(null);
      showToast("Face re-enrollment request rejected.", "success");
    } catch (err) {
      showToast(err.message || "Failed to reject the request.", "error");
    } finally {
      setProcessingRequestId(null);
    }
  };

  // Metrics calculation
  const totalStaff = staffList.length;
  const enrolledCount = Object.values(enrollmentStatuses).filter(s => s?.enrollment_status === "enrolled").length;
  const pendingEnrollment = totalStaff - enrolledCount;
  const authorizedCount = Object.values(enrollmentStatuses).filter(s => s?.metadata?.selfEnrollmentAuthorized).length;

  const pendingReviews = attempts.filter(a => a.review_status === "pending");
  const inconclusiveAttempts = attempts.filter(a => a.status === "inconclusive");
  const verifiedAttempts = attempts.filter(a => a.status === "verified");
  const failedAttempts = attempts.filter(a => a.status === "failed");

  // Filtered employees
  const filteredEmployees = useMemo(() => {
    return staffList.filter(emp => {
      const matchesSearch =
        !searchQuery ||
        (emp.name && emp.name.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (emp.email && emp.email.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (emp.department && emp.department.toLowerCase().includes(searchQuery.toLowerCase()));

      const id = emp.uid || emp.id;
      const status = enrollmentStatuses[id]?.enrollment_status || "pending";
      const isAuth = Boolean(enrollmentStatuses[id]?.metadata?.selfEnrollmentAuthorized);

      if (statusFilter === "enrolled") return matchesSearch && status === "enrolled";
      if (statusFilter === "pending") return matchesSearch && status !== "enrolled";
      if (statusFilter === "authorized") return matchesSearch && isAuth;
      return matchesSearch;
    });
  }, [staffList, searchQuery, statusFilter, enrollmentStatuses]);

  // Filtered attempts
  const filteredAttempts = useMemo(() => {
    return attempts.filter(a => {
      const matchesSearch =
        !reviewSearch ||
        (a.user_name && a.user_name.toLowerCase().includes(reviewSearch.toLowerCase())) ||
        (a.user_email && a.user_email.toLowerCase().includes(reviewSearch.toLowerCase())) ||
        (a.id && a.id.toLowerCase().includes(reviewSearch.toLowerCase())) ||
        (a.failure_category && a.failure_category.toLowerCase().includes(reviewSearch.toLowerCase()));

      if (reviewFilter === "all") return matchesSearch;
      if (reviewFilter === "pending") return matchesSearch && a.review_status === "pending";
      if (reviewFilter === "approved") return matchesSearch && a.review_status === "approved";
      if (reviewFilter === "rejected") return matchesSearch && a.review_status === "rejected";
      if (reviewFilter === "inconclusive") return matchesSearch && a.status === "inconclusive";
      if (reviewFilter === "verified") return matchesSearch && a.status === "verified";
      return matchesSearch;
    });
  }, [attempts, reviewSearch, reviewFilter]);

  const formatTimestamp = (ts) => {
    if (!ts) return "—";
    try {
      const d = new Date(ts);
      return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch {
      return String(ts);
    }
  };

  const getFailureLabel = (category) => {
    switch (category) {
      case "liveness_inconclusive":
        return "Liveness Inconclusive (Lighting/Motion)";
      case "liveness_failed":
        return "Spoof / Presentation Attack Detected";
      case "face_not_matched":
        return "Biometric Distance Exceeded Threshold";
      case "face_service_unavailable":
        return "Face Microservice Offline";
      case "enrollment_missing":
        return "Biometric Profile Missing";
      case "session_invalid_or_expired":
        return "Verification Session Expired / Replayed";
      case "geofence_outside":
        return "Outside Geofence Perimeter";
      default:
        return category ? category.replace(/_/g, " ") : "Inconclusive Biometrics";
    }
  };

  return (
    <div className="space-y-6">
      {/* Biometric Template Replacement Confirmation Modal */}
      {replacementTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-bg-card border border-border-card rounded-[24px] max-w-lg w-full p-6 shadow-2xl space-y-5">
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-2xl bg-amber-500/10 text-amber-500 flex-shrink-0">
                <AlertTriangle size={24} />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-bold text-text-main">
                  Replace Face Reference Template
                </h3>
                <p className="text-xs text-text-mut">
                  Biometric Reference Update Confirmation
                </p>
              </div>
            </div>

            {/* Employee Quick Summary */}
            <div className="bg-bg-base/60 border border-border-card rounded-2xl p-3.5 flex items-center justify-between">
              <div>
                <div className="text-xs font-bold text-text-main">{replacementTarget.name}</div>
                <div className="text-[11px] text-text-sec">{replacementTarget.email}</div>
              </div>
              <div className="text-right">
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                  Currently Enrolled
                </span>
                {enrollmentStatuses[replacementTarget.uid || replacementTarget.id]?.enrolled_at && (
                  <div className="text-[10px] text-text-mut mt-1">
                    Enrolled: {formatTimestamp(enrollmentStatuses[replacementTarget.uid || replacementTarget.id]?.enrolled_at)}
                  </div>
                )}
              </div>
            </div>

            {/* Confirmation Message */}
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400 space-y-2">
              <p className="font-semibold text-text-main">
                This employee already has a registered face template. Continuing will replace the existing reference template with the newly captured face.
              </p>
              <p className="text-[11px] text-text-sec">
                The newly captured selfie will be validated with ArcFace face detection, and the resulting mathematical embedding will replace the existing reference vector. Existing biometric consent, attendance logs, and audit records will remain intact.
              </p>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setReplacementTarget(null)}
                disabled={busy}
                className="px-4 py-2 text-xs font-bold rounded-xl border border-border-card text-text-sec hover:text-text-main hover:bg-bg-hover transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmReplacement}
                disabled={busy}
                className="px-4 py-2 text-xs font-bold rounded-xl bg-brand-primary text-white hover:bg-brand-hover transition-colors flex items-center gap-2 shadow-sm"
              >
                <Camera size={14} />
                <span>Continue to Camera Capture</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Active Camera Capture Modal */}
      {showCamera && (
        <CameraCapture
          title={isReplacementSession ? `Replace Face Template: ${selectedEmployee?.name || "Employee"}` : `Enroll Face: ${selectedEmployee?.name || "Employee"}`}
          description={isReplacementSession ? "Position the employee centrally with good lighting. The newly validated face will replace the previous reference template." : "Position the face in good lighting. Only one face should be visible."}
          captureLabel={isReplacementSession ? "Capture & Replace Template" : "Capture Selfie"}
          onCapture={handleCaptureComplete}
          onCancel={() => {
            setShowCamera(false);
            setIsReplacementSession(false);
            setConsentRecorded(false);
          }}
          busy={busy}
        />
      )}

      {/* Main Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border-card pb-5">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-brand-primary/10 text-brand-primary">
              <Shield size={24} />
            </div>
            <div>
              <h1 className="text-2xl font-black text-text-main tracking-tight">
                Attendance Verification & Biometrics
              </h1>
              <p className="text-xs text-text-sec mt-0.5">
                ArcFace reference template enrollment, presentation-attack prevention, and manual verification review.
              </p>
            </div>
          </div>
        </div>

        {/* Top Badges & Tab Buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-600 text-[11px] font-bold">
            <ShieldAlert size={14} />
            <span>Production Safeguards Gate Active</span>
          </div>

          <div className="bg-bg-card border border-border-card p-1 rounded-xl flex gap-1">
            <button
              onClick={() => setActiveSubTab("enrollment")}
              className={`px-3.5 py-1.5 text-xs font-bold rounded-lg transition-all flex items-center gap-2 ${
                activeSubTab === "enrollment"
                  ? "bg-brand-primary text-white shadow-sm"
                  : "text-text-sec hover:text-text-main"
              }`}
            >
              <UserCheck size={14} />
              <span>Biometric Profiles</span>
            </button>

            <button
              onClick={() => setActiveSubTab("verification-review")}
              className={`px-3.5 py-1.5 text-xs font-bold rounded-lg transition-all flex items-center gap-2 ${
                activeSubTab === "verification-review"
                  ? "bg-brand-primary text-white shadow-sm"
                  : "text-text-sec hover:text-text-main"
              }`}
            >
              <FileText size={14} />
              <span>Review Queue</span>
              {pendingReviews.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] font-extrabold bg-amber-500 text-white">
                  {pendingReviews.length}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* SUB-TAB 1: BIOMETRIC ENROLLMENT */}
      {activeSubTab === "enrollment" && (
        <div className="space-y-6">
          {/* Selected Employee Quick Action (e.g. from Staff Directory) */}
          {selectedEmployee && (
            <div className="bg-brand-primary/10 border border-brand-primary/30 rounded-[18px] p-4 flex items-center justify-between flex-wrap gap-3 animate-fade-in">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-brand-primary/20 text-brand-primary flex items-center justify-center font-bold text-sm">
                  {selectedEmployee.name ? selectedEmployee.name.charAt(0).toUpperCase() : "U"}
                </div>
                <div>
                  <div className="text-sm font-bold text-text-main flex items-center gap-2">
                    <span>{selectedEmployee.name}</span>
                    <span className="text-[11px] font-normal text-text-mut">({selectedEmployee.department || "General"})</span>
                    {selectedStatus?.enrollment_status === "enrolled" ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-600 border border-emerald-500/30">
                        Enrolled
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-600 border border-amber-500/30">
                        Pending Enrollment
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-sec">{selectedEmployee.email}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleInitiateEnrollment(selectedEmployee)}
                  disabled={busy}
                  className="px-4 py-2 text-xs font-bold rounded-xl bg-brand-primary text-white hover:bg-brand-hover transition-colors flex items-center gap-2 shadow-sm cursor-pointer disabled:opacity-50"
                >
                  <Camera size={14} />
                  <span>{selectedStatus?.enrollment_status === "enrolled" ? "Re-Enroll Face" : "Enroll Face"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedId("")}
                  className="px-3 py-2 text-xs font-semibold rounded-xl text-text-mut hover:text-text-main hover:bg-bg-card transition-colors cursor-pointer"
                >
                  Clear Selection
                </button>
              </div>
            </div>
          )}

          {/* Quick Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="bg-bg-card border border-border-card rounded-[18px] p-4 shadow-sm">
              <span className="text-[10px] font-bold uppercase tracking-wider text-text-mut block">Total Staff</span>
              <span className="text-2xl font-black text-text-main block mt-1">{totalStaff}</span>
              <span className="text-[11px] text-text-mut mt-0.5 block">Eligible active employees</span>
            </div>
            <div className="bg-bg-card border border-border-card rounded-[18px] p-4 shadow-sm">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 block">Enrolled</span>
              <span className="text-2xl font-black text-emerald-600 block mt-1">{enrolledCount}</span>
              <span className="text-[11px] text-text-mut mt-0.5 block">ArcFace templates active</span>
            </div>
            <div className="bg-bg-card border border-border-card rounded-[18px] p-4 shadow-sm">
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600 block">Pending Enrollment</span>
              <span className="text-2xl font-black text-amber-600 block mt-1">{pendingEnrollment}</span>
              <span className="text-[11px] text-text-mut mt-0.5 block">Awaiting face capture</span>
            </div>
            <div className="bg-bg-card border border-border-card rounded-[18px] p-4 shadow-sm">
              <span className="text-[10px] font-bold uppercase tracking-wider text-brand-primary block">Self-Enroll Authorized</span>
              <span className="text-2xl font-black text-brand-primary block mt-1">{authorizedCount}</span>
              <span className="text-[11px] text-text-mut mt-0.5 block">Authorized for portal capture</span>
            </div>
          </div>

          {/* Controls & Search */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-mut" />
              <input
                type="text"
                placeholder="Search employee by name, email, department..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-2 text-xs bg-bg-card border border-border-card rounded-xl text-text-main placeholder-text-mut focus:outline-none focus:ring-1 focus:ring-brand-primary"
              />
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 bg-bg-card border border-border-card rounded-xl p-1 text-xs">
                <button
                  onClick={() => setStatusFilter("all")}
                  className={`px-3 py-1 rounded-lg font-bold transition-all ${
                    statusFilter === "all" ? "bg-brand-primary text-white" : "text-text-sec hover:text-text-main"
                  }`}
                >
                  All ({staffList.length})
                </button>
                <button
                  onClick={() => setStatusFilter("enrolled")}
                  className={`px-3 py-1 rounded-lg font-bold transition-all ${
                    statusFilter === "enrolled" ? "bg-emerald-600 text-white" : "text-text-sec hover:text-text-main"
                  }`}
                >
                  Enrolled ({enrolledCount})
                </button>
                <button
                  onClick={() => setStatusFilter("pending")}
                  className={`px-3 py-1 rounded-lg font-bold transition-all ${
                    statusFilter === "pending" ? "bg-amber-600 text-white" : "text-text-sec hover:text-text-main"
                  }`}
                >
                  Pending ({pendingEnrollment})
                </button>
                <button
                  onClick={() => setStatusFilter("authorized")}
                  className={`px-3 py-1 rounded-lg font-bold transition-all ${
                    statusFilter === "authorized" ? "bg-indigo-600 text-white" : "text-text-sec hover:text-text-main"
                  }`}
                >
                  Authorized ({authorizedCount})
                </button>
              </div>
            </div>
          </div>

          {/* Employee Directory Table */}
          <div className="bg-bg-card border border-border-card rounded-[20px] overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-border-card bg-bg-base/50 text-[10px] font-extrabold uppercase tracking-wider text-text-mut">
                    <th className="py-3 px-4">Employee</th>
                    <th className="py-3 px-4">Department</th>
                    <th className="py-3 px-4">Biometric Status</th>
                    <th className="py-3 px-4">Self-Enrollment</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-card text-xs">
                  {filteredEmployees.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-text-mut">
                        No employees found matching the filters.
                      </td>
                    </tr>
                  ) : (
                    filteredEmployees.map(emp => {
                      const id = emp.uid || emp.id;
                      const statusObj = enrollmentStatuses[id];
                      const isEnrolled = statusObj?.enrollment_status === "enrolled";
                      const isAuth = Boolean(statusObj?.metadata?.selfEnrollmentAuthorized);
                      const isSelected = id === selectedId;

                      return (
                        <tr 
                          key={id} 
                          className={`transition-colors ${
                            isSelected 
                              ? "bg-brand-primary/10 border-l-4 border-brand-primary" 
                              : "hover:bg-bg-base/30"
                          }`}
                        >
                          <td className="py-3.5 px-4">
                            <div className="font-bold text-text-main">{emp.name}</div>
                            <div className="text-[11px] text-text-mut">{emp.email}</div>
                          </td>
                          <td className="py-3.5 px-4 text-text-sec">
                            {emp.department || "General"}
                          </td>
                          <td className="py-3.5 px-4">
                            {isEnrolled ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                                <CheckCircle2 size={13} />
                                <span>Enrolled</span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                                <Clock size={13} />
                                <span>Pending</span>
                              </span>
                            )}
                          </td>
                          <td className="py-3.5 px-4">
                            {isAuth ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                                <CheckCircle2 size={12} />
                                <span>Authorized</span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-text-mut">
                                <UserX size={12} />
                                <span>Not Authorized</span>
                              </span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-right">
                            <div className="inline-flex items-center gap-2">
                              {!isAuth && (
                                <button
                                  type="button"
                                  onClick={() => handleAuthorize(id)}
                                  disabled={busy}
                                  className="px-2.5 py-1 text-[11px] font-bold rounded-lg border border-brand-primary text-brand-primary hover:bg-brand-primary/10 transition-colors disabled:opacity-50"
                                >
                                  Authorize Self-Enroll
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleInitiateEnrollment(emp)}
                                disabled={busy}
                                className="px-3 py-1 text-[11px] font-bold rounded-lg bg-brand-primary text-white hover:bg-brand-hover transition-colors flex items-center gap-1.5 shadow-sm disabled:opacity-50"
                              >
                                <Camera size={13} />
                                <span>{isEnrolled ? "Re-Enroll Face" : "Enroll Face"}</span>
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

      {/* SUB-TAB 2: VERIFICATION REVIEW QUEUE */}
      {activeSubTab === "verification-review" && (
        <div className="space-y-6">
          {/* Review Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="bg-bg-card border border-border-card rounded-[18px] p-4 shadow-sm">
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600 block">Pending HR Review</span>
              <span className="text-2xl font-black text-amber-600 block mt-1">{pendingReviews.length}</span>
              <span className="text-[11px] text-text-mut mt-0.5 block">Requires HR decision</span>
            </div>
            <div className="bg-bg-card border border-border-card rounded-[18px] p-4 shadow-sm">
              <span className="text-[10px] font-bold uppercase tracking-wider text-orange-600 block">Inconclusive Attempts</span>
              <span className="text-2xl font-black text-orange-600 block mt-1">{inconclusiveAttempts.length}</span>
              <span className="text-[11px] text-text-mut mt-0.5 block">Lighting/liveness inconclusive</span>
            </div>
            <div className="bg-bg-card border border-border-card rounded-[18px] p-4 shadow-sm">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 block">Verified Attempts</span>
              <span className="text-2xl font-black text-emerald-600 block mt-1">{verifiedAttempts.length}</span>
              <span className="text-[11px] text-text-mut mt-0.5 block">Biometrics & GPS passed</span>
            </div>
            <div className="bg-bg-card border border-border-card rounded-[18px] p-4 shadow-sm">
              <span className="text-[10px] font-bold uppercase tracking-wider text-rose-600 block">Failed / Spoof</span>
              <span className="text-2xl font-black text-rose-600 block mt-1">{failedAttempts.length}</span>
              <span className="text-[11px] text-text-mut mt-0.5 block">Mismatch or presentation attack</span>
            </div>
          </div>

          {/* Search, Filter & Refresh */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-mut" />
              <input
                type="text"
                placeholder="Search attempts by employee, reason, attempt ID..."
                value={reviewSearch}
                onChange={e => setReviewSearch(e.target.value)}
                className="w-full pl-9 pr-4 py-2 text-xs bg-bg-card border border-border-card rounded-xl text-text-main placeholder-text-mut focus:outline-none focus:ring-1 focus:ring-brand-primary"
              />
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1 bg-bg-card border border-border-card rounded-xl p-1 text-xs">
                <button
                  onClick={() => setReviewFilter("pending")}
                  className={`px-3 py-1 rounded-lg font-bold transition-all ${
                    reviewFilter === "pending" ? "bg-amber-600 text-white" : "text-text-sec hover:text-text-main"
                  }`}
                >
                  Pending Review ({pendingReviews.length})
                </button>
                <button
                  onClick={() => setReviewFilter("all")}
                  className={`px-3 py-1 rounded-lg font-bold transition-all ${
                    reviewFilter === "all" ? "bg-brand-primary text-white" : "text-text-sec hover:text-text-main"
                  }`}
                >
                  All ({attempts.length})
                </button>
                <button
                  onClick={() => setReviewFilter("approved")}
                  className={`px-3 py-1 rounded-lg font-bold transition-all ${
                    reviewFilter === "approved" ? "bg-emerald-600 text-white" : "text-text-sec hover:text-text-main"
                  }`}
                >
                  Approved
                </button>
                <button
                  onClick={() => setReviewFilter("rejected")}
                  className={`px-3 py-1 rounded-lg font-bold transition-all ${
                    reviewFilter === "rejected" ? "bg-rose-600 text-white" : "text-text-sec hover:text-text-main"
                  }`}
                >
                  Rejected
                </button>
              </div>

              <button
                type="button"
                onClick={loadAttempts}
                disabled={attemptsLoading}
                className="p-2 rounded-xl border border-border-card bg-bg-card text-text-sec hover:text-text-main transition-colors"
                title="Refresh verification attempts"
              >
                <RefreshCw size={15} className={attemptsLoading ? "animate-spin" : ""} />
              </button>
            </div>
          </div>

          {/* Verification Attempts Table */}
          <div className="bg-bg-card border border-border-card rounded-[20px] overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-border-card bg-bg-base/50 text-[10px] font-extrabold uppercase tracking-wider text-text-mut">
                    <th className="py-3 px-4">Attempt ID & Time</th>
                    <th className="py-3 px-4">Employee</th>
                    <th className="py-3 px-4">Attempt Status</th>
                    <th className="py-3 px-4">Biometric Checks</th>
                    <th className="py-3 px-4">Review Status</th>
                    <th className="py-3 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-card text-xs">
                  {attemptsLoading ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-text-mut">
                        <RefreshCw size={20} className="animate-spin mx-auto mb-2 text-brand-primary" />
                        Loading verification attempts...
                      </td>
                    </tr>
                  ) : filteredAttempts.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-text-mut">
                        No verification attempts found matching the criteria.
                      </td>
                    </tr>
                  ) : (
                    filteredAttempts.map(attempt => {
                      const isPending = attempt.review_status === "pending";
                      const isApproved = attempt.review_status === "approved";
                      const isRejected = attempt.review_status === "rejected";

                      return (
                        <tr key={attempt.id} className="hover:bg-bg-base/30 transition-colors">
                          <td className="py-3.5 px-4 font-mono text-[11px]">
                            <div className="font-bold text-text-main">{attempt.id}</div>
                            <div className="text-text-mut font-sans text-[10px]">
                              {formatTimestamp(attempt.attempted_at)}
                            </div>
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="font-bold text-text-main">{attempt.user_name || attempt.user_id}</div>
                            {attempt.user_email && (
                              <div className="text-[11px] text-text-mut">{attempt.user_email}</div>
                            )}
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="space-y-1">
                              <span
                                className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                                  attempt.status === "verified"
                                    ? "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20"
                                    : attempt.status === "inconclusive"
                                    ? "bg-amber-500/10 text-amber-600 border border-amber-500/20"
                                    : "bg-rose-500/10 text-rose-600 border border-rose-500/20"
                                }`}
                                title="Face Embedding Comparison"
                              >
                                {attempt.status === "verified" && <CheckCircle2 size={11} />}
                                {attempt.status === "inconclusive" && <AlertTriangle size={11} />}
                                {attempt.status === "failed" && <XCircle size={11} />}
                                <span className="capitalize">{attempt.status}</span>
                              </span>
                              {attempt.failure_category && (
                                <div className="text-[10px] text-text-mut font-medium">
                                  {getFailureLabel(attempt.failure_category)}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="flex items-center gap-2 text-[10px] flex-wrap">
                              <span
                                className={`px-2 py-0.5 rounded font-mono ${
                                  attempt.face_result === "matched"
                                    ? "bg-emerald-500/10 text-emerald-600"
                                    : attempt.face_result === "not_matched"
                                    ? "bg-rose-500/10 text-rose-600"
                                    : "bg-bg-base text-text-mut"
                                }`}
                                title="Face Embedding Comparison"
                              >
                                Face: {attempt.face_result || "none"}
                              </span>
                              <span
                                className={`px-2 py-0.5 rounded font-mono ${
                                  attempt.liveness_result === "live"
                                    ? "bg-emerald-500/10 text-emerald-600"
                                    : attempt.liveness_result === "spoof"
                                    ? "bg-rose-500/10 text-rose-600"
                                    : "bg-amber-500/10 text-amber-600"
                                }`}
                                title="Liveness Anti-Spoofing"
                              >
                                Live: {attempt.liveness_result || "none"}
                              </span>
                              <span
                                className={`px-2 py-0.5 rounded font-mono ${
                                  attempt.gps_result === "inside"
                                    ? "bg-emerald-500/10 text-emerald-600"
                                    : attempt.gps_result === "outside"
                                    ? "bg-rose-500/10 text-rose-600"
                                    : "bg-bg-base text-text-mut"
                                }`}
                                title="Geofence Distance Check"
                              >
                                GPS: {attempt.gps_result || "none"}
                              </span>
                            </div>
                          </td>
                          <td className="py-3.5 px-4">
                            {isPending && (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-500/15 text-amber-600 border border-amber-500/30">
                                <Clock size={12} />
                                <span>Pending Review</span>
                              </span>
                            )}
                            {isApproved && (
                              <div>
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                                  <CheckCircle2 size={11} />
                                  <span>Approved</span>
                                </span>
                                {attempt.review_note && (
                                  <div className="text-[10px] text-text-mut mt-0.5 line-clamp-1" title={attempt.review_note}>
                                    Note: {attempt.review_note}
                                  </div>
                                )}
                              </div>
                            )}
                            {isRejected && (
                              <div>
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/10 text-rose-600 border border-rose-500/20">
                                  <XCircle size={11} />
                                  <span>Rejected</span>
                                </span>
                                {attempt.review_note && (
                                  <div className="text-[10px] text-text-mut mt-0.5 line-clamp-1" title={attempt.review_note}>
                                    Note: {attempt.review_note}
                                  </div>
                                )}
                              </div>
                            )}
                            {!isPending && !isApproved && !isRejected && (
                              <span className="text-text-mut text-[11px]">Not Required</span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-right">
                            {isPending ? (
                              <button
                                type="button"
                                onClick={() => handleOpenReviewModal(attempt)}
                                className="px-3 py-1 text-xs font-bold rounded-lg bg-amber-600 hover:bg-amber-700 text-white transition-colors shadow-sm"
                              >
                                Review Attempt
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleOpenReviewModal(attempt)}
                                className="px-2.5 py-1 text-[11px] font-semibold rounded-lg border border-border-card text-text-sec hover:text-text-main transition-colors"
                              >
                                View Details
                              </button>
                            )}
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

      {/* Review Decision Modal */}
      {selectedAttemptForReview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-[22px] border border-border-card bg-bg-card p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-black text-text-main tracking-tight">
                  Review Biometric Verification Attempt
                </h3>
                <p className="text-xs text-text-sec mt-0.5">
                  ID: <span className="font-mono">{selectedAttemptForReview.id}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedAttemptForReview(null)}
                className="p-1 rounded-lg text-text-mut hover:text-text-main"
              >
                ✕
              </button>
            </div>

            {/* Attempt Details summary */}
            <div className="rounded-xl border border-border-card bg-bg-base/70 p-4 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-text-mut">Employee:</span>
                <span className="font-bold text-text-main">
                  {selectedAttemptForReview.user_name || selectedAttemptForReview.user_id}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-mut">Attempt Time:</span>
                <span className="text-text-sec">{formatTimestamp(selectedAttemptForReview.attempted_at)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-mut">Biometric Outcome:</span>
                <span className="font-bold uppercase text-amber-600">{selectedAttemptForReview.status}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-mut">Classification:</span>
                <span className="text-text-sec font-medium">
                  {getFailureLabel(selectedAttemptForReview.failure_category)}
                </span>
              </div>
              <div className="flex justify-between pt-1 border-t border-border-card">
                <span className="text-text-mut">Face Result:</span>
                <span className="font-mono">{selectedAttemptForReview.face_result || "N/A"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-mut">Liveness Anti-Spoof:</span>
                <span className="font-mono">{selectedAttemptForReview.liveness_result || "N/A"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-mut">GPS Geofence:</span>
                <span className="font-mono">{selectedAttemptForReview.gps_result || "N/A"}</span>
              </div>
            </div>

            {/* Decision form */}
            <div className="space-y-4">
              <label className="block text-xs font-bold text-text-main">
                Review Decision
                <div className="grid grid-cols-2 gap-3 mt-2">
                  <button
                    type="button"
                    onClick={() => setReviewDecision("approved")}
                    className={`py-2.5 px-3 rounded-xl border text-xs font-bold transition-all flex items-center justify-center gap-2 ${
                      reviewDecision === "approved"
                        ? "border-emerald-500 bg-emerald-500/10 text-emerald-600 shadow-sm"
                        : "border-border-card bg-bg-base text-text-sec hover:text-text-main"
                    }`}
                  >
                    <CheckCircle2 size={16} />
                    <span>Approve Attempt</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setReviewDecision("rejected")}
                    className={`py-2.5 px-3 rounded-xl border text-xs font-bold transition-all flex items-center justify-center gap-2 ${
                      reviewDecision === "rejected"
                        ? "border-rose-500 bg-rose-500/10 text-rose-600 shadow-sm"
                        : "border-border-card bg-bg-base text-text-sec hover:text-text-main"
                    }`}
                  >
                    <XCircle size={16} />
                    <span>Reject Attempt</span>
                  </button>
                </div>
              </label>

              <label className="block text-xs font-bold text-text-main">
                HR Review Note / Justification
                <textarea
                  rows={3}
                  placeholder="e.g. Employee verified in person at desk; camera glare caused liveness check failure."
                  value={reviewNote}
                  onChange={e => setReviewNote(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-border-card bg-bg-base px-3 py-2 text-xs text-text-main placeholder-text-mut focus:outline-none focus:ring-1 focus:ring-brand-primary"
                />
              </label>
            </div>

            {/* Action buttons */}
            <div className="flex items-center justify-end gap-3 pt-3 border-t border-border-card">
              <button
                type="button"
                onClick={() => setSelectedAttemptForReview(null)}
                className="px-4 py-2 text-xs font-bold rounded-xl border border-border-card text-text-sec hover:text-text-main"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmitReview}
                disabled={submittingReview}
                className="px-5 py-2 text-xs font-bold rounded-xl bg-brand-primary text-white hover:bg-brand-hover shadow-md disabled:opacity-50 flex items-center gap-2"
              >
                {submittingReview ? <RefreshCw size={14} className="animate-spin" /> : null}
                <span>Submit Decision</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
