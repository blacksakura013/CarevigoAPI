const sessions = require("../services/cookieSession.service");
const response = require("../utils/response");
const { safePatient } = require("../utils/patientProfile");

exports.me = (req, res) => {
  const data = { session: sessions.metadata(req.cookieSession) };
  if (req.user.type === "patient") {
    data.patient = safePatient(req.patient);
    data.requiresPasswordChange = req.patient.requiresPasswordChange === true;
  } else {
    const admin = req.admin;
    data.admin = { id: admin._id, email: admin.email, role: admin.role, lastLogin: admin.lastLogin };
  }
  return response.success({ res, data });
};

exports.logout = async (req, res) => {
  try {
    await sessions.revoke(req.cookieSession);
    sessions.clearCookie(res, req.cookieSession.type);
    return response.success({ res, message: "ออกจากระบบแล้ว", data: null });
  } catch {
    return response.error({ res, message: "ออกจากระบบไม่สำเร็จ กรุณาลองอีกครั้ง" });
  }
};

exports.requireCookie = (req, res, next) => sessions.cookieMode(req)
  ? next() : response.error({ res, statusCode: 400, message: "This endpoint requires cookie session mode" });
