import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import {
  getFaceEnrollmentStatus,
  enrollFace,
  requestFaceReenrollment,
  getMyFaceReenrollmentRequest
} from "../firebase";
import CameraCapture from "../components/CameraCapture";
import {
  Shield,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Camera,
  ArrowLeft,
  RefreshCw,
  Lock,
  UserCheck,
  Info,
  ExternalLink
} from "lucide-react";

export default function FaceEnrollment() {
  const { currentUser } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [consentAgreed, setConsentAgreed] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [request, setRequest] = useState(null);
  const [requestReason, setRequestReason] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [showRequestModal, setShowRequestModal] = useState(false);

  const isAdmin =
    currentUser?.role === "admin" ||
    currentUser?.role === "superadmin" ||
    currentUser?.role === "system admin";

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const res = await getFaceEnrollmentStatus();
      setStatus(res || { enrollment_status: "pending" });
    } catch (err) {
      console.error("Failed to load face enrollment status:", err);
      setStatus({ enrollment_status: "pending" });
    } finally {
      setLoading(false);
    }
  };

  const fetchRequest = async () => {
    try {
      const res = await getMyFaceReenrollmentRequest();
      setRequest(res?.request || null);
    } catch (err) {
      console.warn("Failed to load face re-enrollment request:", err);
      setRequest(null);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchRequest();
  }, []);

  const isEnrolled = status?.enrollment_status === "enrolled";
  const isAuthorized = Boolean(status?.metadata?.selfEnrollmentAuthorized);
  const isReenrollAuthorized = Boolean(status?.metadata?.reenrollmentAuthorized);
  const requestStatus = request?.status || "";
  const canCapture = isAdmin || (!isEnrolled && isAuthorized) || (isEnrolled && (isReenrollAuthorized || isAuthorized));
  const canRequestReenrollment = isEnrolled && !isAdmin && requestStatus !== "pending" && requestStatus !== "approved";

  const handleRequestReenrollment = async () => {
    const reason = requestReason.trim();
    if (!reason) {
      showToast("Please provide a short reason for requesting face re-enrollment.", "warning");
      return;
    }
    setRequesting(true);
    try {
      const res = await requestFaceReenrollment(reason);
      setRequest(res?.request || { status: "pending" });
      setRequestReason("");
      setShowRequestModal(false);
      showToast("Face re-enrollment request submitted successfully.", "success");
    } catch (err) {
      showToast(err.message || "Unable to submit face re-enrollment request.", "error");
    } finally {
      setRequesting(false);
    }
  };

  const handleOpenRequestModal = () => {
    setRequestReason("");
    setShowRequestModal(true);
  };

  const handleCaptureComplete = async (imageBase64) => {
    if (!consentAgreed) {
      showToast("Please acknowledge and accept biometric consent before enrolling.", "warning");
      return;
    }
    setSubmitting(true);
    try {
      const res = await enrollFace(imageBase64, true);
      const isRepl = res?.mode === "replacement" || isEnrolled;
      showToast(
        isRepl
          ? "Reference face template replaced successfully! Your updated face template is now active."
          : "Reference face enrolled successfully! You can now verify attendance with selfie capture.",
        "success"
      );
      setShowCamera(false);
      setConsentAgreed(false);
      await fetchStatus();
      await fetchRequest();
    } catch (err) {
      showToast(err.message || "Failed to enroll face. Please ensure your face is well-lit and centered.", "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto py-2">
      {/* Top Navigation & Breadcrumb */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-2 text-xs font-bold text-text-sec hover:text-text-main transition-colors"
        >
          <ArrowLeft size={16} />
          <span>Back</span>
        </button>

        <button
          type="button"
          onClick={fetchStatus}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border-card bg-bg-card text-xs font-bold text-text-sec hover:text-text-main transition-colors"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          <span>Refresh Status</span>
        </button>
      </div>

      {/* Admin Quick Link Banner */}
      {isAdmin && (
        <div className="bg-brand-primary/10 border border-brand-primary/20 rounded-[18px] p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-brand-primary/20 text-brand-primary">
              <ShieldCheck size={20} />
            </div>
            <div>
              <p className="text-xs font-bold text-text-main">Administrator Biometrics Management</p>
              <p className="text-[11px] text-text-sec">
                Manage organization-wide employee face enrollments and review verification attempts in the admin panel.
              </p>
            </div>
          </div>
          <Link
            to="/admin?tab=biometrics"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-brand-primary text-white text-xs font-bold hover:bg-brand-hover transition-colors whitespace-nowrap shadow-sm"
          >
            <span>Admin Biometrics</span>
            <ExternalLink size={13} />
          </Link>
        </div>
      )}

      {/* Header Card */}
      <div className="bg-bg-card border border-border-card rounded-[22px] p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-2xl bg-brand-primary/10 text-brand-primary flex-shrink-0">
              <Shield size={28} />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-text-main tracking-tight">
                Biometric Face Enrollment
              </h1>
              <p className="text-xs text-text-sec mt-1 max-w-xl">
                Manage your facial reference template for secure attendance check-in and check-out. Raw camera images are converted to mathematical vectors and are never stored on disk.
              </p>
            </div>
          </div>

          <div className="flex-shrink-0">
            {loading ? (
              <div className="px-3 py-1.5 rounded-full bg-bg-hover text-text-sec text-xs font-bold flex items-center gap-2">
                <RefreshCw size={12} className="animate-spin" />
                <span>Checking...</span>
              </div>
            ) : isEnrolled ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 text-emerald-500 text-xs font-black border border-emerald-500/20">
                <CheckCircle2 size={14} />
                <span>Enrolled & Ready</span>
              </span>
            ) : isAuthorized ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-500/10 text-blue-500 text-xs font-black border border-blue-500/20">
                <Clock size={14} />
                <span>Authorized for Self-Enrollment</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/10 text-amber-500 text-xs font-black border border-amber-500/20">
                <AlertTriangle size={14} />
                <span>Pending HR Authorization</span>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Enrollment Card */}
      <div className="bg-bg-card border border-border-card rounded-[22px] p-6 shadow-sm space-y-6">
        <div>
          <h2 className="text-base font-bold text-text-main flex items-center gap-2">
            <Camera size={18} className="text-brand-primary" />
            <span>Face Enrollment Action</span>
          </h2>
          <p className="text-xs text-text-sec mt-0.5">
            Follow the organizational biometric policy to record or refresh your reference template.
          </p>
        </div>

        {/* Status Explanation */}
        {!isAuthorized && !isEnrolled && (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400 space-y-1.5">
            <p className="font-bold flex items-center gap-1.5">
              <Lock size={14} />
              <span>HR Authorization Required</span>
            </p>
            <p>
              Your account has not yet been authorized for biometric self-enrollment. Please contact your manager or HR department. Once an administrator approves your request from the Staff Directory, you will be able to capture your reference photo here.
            </p>
          </div>
        )}

        {isEnrolled && !canCapture && (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400 space-y-1.5">
            <p className="font-bold flex items-center gap-1.5">
              <Lock size={14} />
              <span>Re-Enrollment Authorization Required</span>
            </p>
            <p>
              Your facial reference template is currently enrolled. To update or replace your registered template, please contact your administrator or HR department to authorize re-enrollment.
            </p>
          </div>
        )}

        {/* Consent Section */}
        <div className="p-4 rounded-xl bg-bg-hover/50 border border-border-card space-y-3">
          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              id="biometricConsent"
              checked={consentAgreed}
              onChange={(e) => setConsentAgreed(e.target.checked)}
              className="mt-0.5 rounded border-border-card text-brand-primary focus:ring-brand-primary"
            />
            <label htmlFor="biometricConsent" className="text-xs text-text-sec cursor-pointer leading-relaxed">
              <strong className="text-text-main block mb-0.5">Explicit Biometric Consent</strong>
              I consent to the collection and processing of my facial photograph exclusively for attendance verification purposes. I understand that only a mathematical vector representation (ArcFace embedding) is stored securely in the database, and that raw images are immediately discarded in memory.
            </label>
          </div>
        </div>

        {/* Action Button */}
        <div className="flex items-center justify-between pt-2">
          <div className="text-xs text-text-sec">
            {isEnrolled && status?.enrolled_at && (
              <span>Template recorded on: <strong>{new Date(status.enrolled_at).toLocaleDateString()}</strong></span>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              if (!consentAgreed) {
                showToast("Please acknowledge and check the biometric consent before proceeding.", "warning");
                return;
              }
              setShowCamera(true);
            }}
            disabled={!canCapture}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand-primary text-white text-xs font-bold hover:bg-brand-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
          >
            <Camera size={15} />
            <span>{isEnrolled ? "Re-Enroll Reference Template" : "Start Face Capture"}</span>
          </button>
        </div>

        {/* Re-enrollment Request Button */}
        {isEnrolled && !isAdmin && requestStatus !== "pending" && requestStatus !== "approved" && (
          <button
            type="button"
            onClick={handleOpenRequestModal}
            disabled={requesting}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-brand-primary text-white text-xs font-bold hover:bg-brand-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
          >
            <Lock size={15} />
            <span>Request Face Re-enrollment</span>
          </button>
        )}
      </div>

      {showRequestModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="w-full max-w-md rounded-[24px] border border-border-card bg-bg-card p-5 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-black text-text-main">Request Face Re-enrollment</h3>
              <button
                type="button"
                onClick={() => setShowRequestModal(false)}
                className="text-text-sec hover:text-text-main text-sm"
              >
                ✕
              </button>
            </div>

            <label className="block text-xs font-bold text-text-sec mb-2">
              Reason for re-enrollment
            </label>
            <textarea
              value={requestReason}
              onChange={(e) => setRequestReason(e.target.value)}
              rows={4}
              placeholder="Example: Need to refresh my face template after a new appearance."
              className="w-full rounded-xl border border-border-card bg-bg-base p-3 text-xs text-text-main placeholder-text-mut focus:outline-none focus:ring-1 focus:ring-brand-primary resize-none"
            />

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowRequestModal(false)}
                className="px-4 py-2 text-xs font-bold rounded-xl border border-border-card text-text-sec hover:text-text-main"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRequestReenrollment}
                disabled={requesting || !requestReason.trim()}
                className="px-4 py-2 text-xs font-bold rounded-xl bg-brand-primary text-white disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {requesting ? "Submitting..." : "Submit Request"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Camera Capture Modal */}
      {showCamera && (
        <CameraCapture
          title="Face Reference Capture"
          description="Position your face centrally in the frame with good lighting. Remove sunglasses or obstructions."
          captureLabel="Capture & Save Reference"
          previewBeforeCapture={true}
          busy={submitting}
          onCapture={handleCaptureComplete}
          onCancel={() => setShowCamera(false)}
        />
      )}
    </div>
  );
}
