/**
 * Face Enrollment Validation Service
 * ===================================
 * Validates biometric consent, image payload constraints,
 * and authorization rules before contacting biometric services.
 */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

export function validateEnrollmentPayload({ imageBase64, consentGiven = true }) {
  if (!consentGiven) {
    return {
      valid: false,
      error: "Biometric consent is mandatory before recording a facial reference template."
    };
  }

  if (!imageBase64 || typeof imageBase64 !== "string") {
    return {
      valid: false,
      error: "Valid base64 image data is required."
    };
  }

  const cleanBase64 = imageBase64.includes(",")
    ? imageBase64.split(",")[1]
    : imageBase64;

  if (cleanBase64.length < 200) {
    return {
      valid: false,
      error: "Image payload is too small to represent a valid photograph."
    };
  }

  // Rough estimation of decoded size from base64 length
  const approxBytes = Math.floor((cleanBase64.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    return {
      valid: false,
      error: "Image size exceeds the 5 MB limit. Please provide a standard resolution photo."
    };
  }

  return { valid: true };
}

export function canEnrollFace({
  requesterRole,
  isSelf,
  isAuthorizedByAdmin,
  isAlreadyEnrolled = false,
  isReenrollmentAuthorized = false
}) {
  const role = String(requesterRole || "").toLowerCase();
  const isAdmin = role === "admin" || role === "superadmin" || role === "hr manager";

  // Admins can enroll or re-enroll any user directly
  if (isAdmin) {
    return { allowed: true, mode: isAlreadyEnrolled ? "replacement" : "new" };
  }

  // Self-enrollment requires being the employee AND being authorized
  if (isSelf) {
    if (!isAuthorizedByAdmin) {
      return {
        allowed: false,
        error: "Face self-enrollment has not been authorized by HR or an Administrator."
      };
    }
    if (isAlreadyEnrolled && !isReenrollmentAuthorized) {
      return {
        allowed: false,
        error: "Face template is already enrolled. Self-replacement is not permitted. Please contact your administrator."
      };
    }
    return { allowed: true, mode: isAlreadyEnrolled ? "replacement" : "new" };
  }

  return {
    allowed: false,
    error: "You are not authorized to enroll or modify biometrics for another user."
  };
}

export default {
  validateEnrollmentPayload,
  canEnrollFace
};
