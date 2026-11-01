const User = require("../models/User");
const response = require("../utils/response");

const PERSONAL_FIELDS = ["firstName", "lastName", "gender", "birthDate", "phone"];
const PERSONAL_PROJECTION = Object.fromEntries([["_id", 0], ...PERSONAL_FIELDS.map(field => [field, 1])]);

exports.patientProfile = async (req, res) => {
  const query = req.query || {};
  if (Object.keys(query).length !== 1 || typeof query.citizenId !== "string" || !/^\d{13}$/.test(query.citizenId)) {
    return response.error({ res, statusCode: 400, message: "กรุณาระบุเฉพาะเลขบัตรประชาชน 13 หลักในช่อง citizenId" });
  }
  try {
    // Public prefill is limited to an approved official profile. Pending guest
    // snapshots and all clinical/account fields remain outside this projection.
    const patient = await User.findOne({ citizenId: query.citizenId, status: "active", isVerified: true }, PERSONAL_PROJECTION).lean();
    const data = patient ? Object.fromEntries(PERSONAL_FIELDS.map(field => [field, typeof patient[field] === "string" ? patient[field] : ""])) : null;
    return response.success({ res, data });
  } catch {
    return response.error({ res, message: "ค้นหาข้อมูลผู้รับบริการไม่สำเร็จ กรุณาลองอีกครั้ง" });
  }
};
