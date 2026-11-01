const { toInternalId } = require("./internalId");

const TERMS_VERSION = "2026-11-01";
const PRIVACY_VERSION = "2026-11-01";
const PURPOSES = ["health-records", "cv-risk-assessment"];

function agreementError(message) {
  return Object.assign(new Error(message), { statusCode: 422, code: "LEGAL_AGREEMENT_REQUIRED" });
}

function validateAgreements(input, source) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      input.termsVersion !== TERMS_VERSION || input.privacyVersion !== PRIVACY_VERSION) {
    throw agreementError("กรุณาอ่านเงื่อนไขการใช้งานและประกาศความเป็นส่วนตัวฉบับปัจจุบัน แล้วทำเครื่องหมายยืนยันก่อนบันทึกข้อมูล");
  }
  if (input.termsAccepted !== true) throw agreementError("กรุณายอมรับเงื่อนไขการใช้งานก่อนบันทึกข้อมูล");
  const agreements = { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, termsAccepted: true };
  if (source === "staff-attestation") {
    if (input.privacyNoticeAcknowledged !== true || input.lawfulAuthorityConfirmed !== true) {
      throw agreementError("กรุณายืนยันว่าได้แจ้งประกาศความเป็นส่วนตัว และมีสิทธิหรืออำนาจในการบันทึกข้อมูลของผู้รับบริการ");
    }
    return { ...agreements, privacyNoticeAcknowledged: true, lawfulAuthorityConfirmed: true };
  }
  if (!["guest-consent", "patient-consent"].includes(source)) throw new TypeError("Invalid agreement source");
  if (input.healthDataConsent !== true) {
    throw agreementError("กรุณายินยอมให้ใช้ข้อมูลสุขภาพเพื่อบันทึก ติดตามสุขภาพ และประเมินความเสี่ยงก่อนบันทึกข้อมูล");
  }
  return { ...agreements, healthDataConsent: true };
}

function agreementProof(agreements, source, user, at = new Date()) {
  return { ...agreements, acceptedAt: at, purposes: [...PURPOSES], source,
    ...(user?.id ? { actorId: String(user.id) } : {}),
    ...(user?.internalId === undefined ? {} : { actorKey: toInternalId(user.internalId) }) };
}

function sendAgreementError(error, res) {
  if (error.code !== "LEGAL_AGREEMENT_REQUIRED") return false;
  res.status(422).json({ statusCode: 422, title: "Error", code: error.code, message: error.message, data: null });
  return true;
}

module.exports = { TERMS_VERSION, PRIVACY_VERSION, PURPOSES, validateAgreements, agreementProof, sendAgreementError };
