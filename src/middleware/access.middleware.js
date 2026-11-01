const response = require("../utils/response");
const isStaff = req => req.user?.type === "admin" && ["admin", "superadmin"].includes(req.user?.role);
const requireStaff = (req, res, next) => isStaff(req) ? next() : response.error({ res, statusCode: 403, message: "เฉพาะเจ้าหน้าที่เท่านั้น" });
const requirePatient = (req, res, next) => req.user?.type === "patient" && req.patient
  ? next() : response.error({ res, statusCode: 403, message: "เฉพาะบัญชีผู้รับบริการเท่านั้น" });
const requirePatientReady = (req, res, next) => req.patient?.requiresPasswordChange
  ? res.status(403).json({ statusCode: 403, title: "Error", code: "PASSWORD_CHANGE_REQUIRED", message: "กรุณาเปลี่ยนรหัสผ่านเริ่มต้นก่อนใช้งาน", data: null }) : next();
const ownCitizen = source => (req, res, next) => {
  if (isStaff(req)) return next();
  if (!req.patient || req[source]?.citizenId !== req.patient.citizenId) {
    return response.error({ res, statusCode: 403, message: "เปิดดูและบันทึกได้เฉพาะข้อมูลของตนเอง" });
  }
  return next();
};
module.exports = { isStaff, requireStaff, requirePatient, requirePatientReady, ownCitizen };
