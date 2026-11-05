import express from "express";
import {
  getAttendance,
  checkIn,
  checkOut,
  startBreak,
  endBreak,
  updateAttendance,
  deleteAttendance,
  getAttendanceRules,
  updateAttendanceRules,
  getFaceStatus,
  authorizeFaceEnrollment,
  enrollFace,
  revokeFaceEnrollment,
  requestFaceReenrollment,
  getMyFaceReenrollmentRequest,
  getFaceReenrollmentRequests,
  approveFaceReenrollmentRequest,
  rejectFaceReenrollmentRequest,
  getVerificationAttempts,
  reviewVerificationAttempt,
  createVerificationSession,
  adminRevertPenalty
} from "../controllers/attendanceController.js";
import { authenticateToken, optionalAuth } from "../middlewares/auth.js";

const router = express.Router();

// Rules (Publicly readable)
router.get("/rules", optionalAuth, getAttendanceRules);

router.use(authenticateToken);
router.get("/", getAttendance);
router.post("/check-in", checkIn);
router.post("/check-out", checkOut);
router.post("/start-break", startBreak);
router.post("/end-break", endBreak);
router.post("/resume-work", endBreak);
router.patch("/:id", updateAttendance);
router.delete("/:id", deleteAttendance);
router.post("/rules", updateAttendanceRules);

// Compliance Penalty Resolution
router.post("/:id/revert-penalty", adminRevertPenalty);

// Biometric Face Enrollment & Management
router.get("/face/status", getFaceStatus);
router.post("/face/authorize", authorizeFaceEnrollment);
router.post("/face/enroll", enrollFace);
router.post("/face/revoke", revokeFaceEnrollment);
router.post("/face-reenrollment/request", requestFaceReenrollment);
router.get("/face-reenrollment/my-request", getMyFaceReenrollmentRequest);
router.get("/face-reenrollment/requests", getFaceReenrollmentRequests);
router.put("/face-reenrollment/:id/approve", approveFaceReenrollmentRequest);
router.put("/face-reenrollment/:id/reject", rejectFaceReenrollmentRequest);
router.post("/face/verify-session", createVerificationSession);
router.get("/face/attempts", getVerificationAttempts);
router.post("/face/review", reviewVerificationAttempt);

export default router;
