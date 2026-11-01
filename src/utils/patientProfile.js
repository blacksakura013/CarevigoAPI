const { normalizeDiseases, SMOKING_STATUSES } = require("./thaiCvRisk");
const PROFILE_FIELDS = ["firstName", "lastName", "gender", "birthDate", "phone", "email", "lineId",
  "emergencyContactName", "emergencyContactPhone", "province", "district", "subdistrict", "address",
  "weight", "height", "education", "maritalStatus", "occupation", "economicStatus", "chronicDiseases",
  "chronicDiseasesConfirmed", "smokingStatus", "smokingQuitMonths", "cancerDetails"];

function pickProfile(body = {}) {
  const profile = {};
  for (const field of PROFILE_FIELDS) {
    if (Object.hasOwn(body, field)) profile[field] = body[field];
  }
  if (Object.hasOwn(body, "sex") && !Object.hasOwn(body, "gender")) profile.gender = body.sex;
  if (profile.chronicDiseases !== undefined) {
    if (!Array.isArray(profile.chronicDiseases) || profile.chronicDiseases.some(value => typeof value !== "string")) throw new Error("กรุณาระบุประวัติโรคให้ถูกต้อง");
    profile.chronicDiseases = normalizeDiseases(profile.chronicDiseases);
  }
  if (profile.chronicDiseasesConfirmed !== undefined && typeof profile.chronicDiseasesConfirmed !== "boolean") throw new Error("กรุณายืนยันประวัติโรคให้ถูกต้อง");
  if (profile.smokingStatus !== undefined && profile.smokingStatus !== "" && !SMOKING_STATUSES.includes(profile.smokingStatus)) throw new Error("กรุณาเลือกประวัติสูบบุหรี่");
  if (profile.smokingQuitMonths !== undefined && profile.smokingQuitMonths !== null && (!Number.isFinite(Number(profile.smokingQuitMonths)) || Number(profile.smokingQuitMonths) < 0)) throw new Error("ระยะเวลาที่เลิกสูบบุหรี่ไม่ถูกต้อง");
  for (const [field, value] of Object.entries(profile)) {
    if (!["chronicDiseases", "chronicDiseasesConfirmed", "weight", "height", "smokingQuitMonths"].includes(field) && typeof value !== "string") throw new Error("รูปแบบข้อมูลส่วนตัวไม่ถูกต้อง");
  }
  return profile;
}

function safePatient(user) {
  const value = user?.toObject ? user.toObject() : { ...user };
  delete value.passwordHash; delete value.tokenVersion;
  value.accountEnabled = value.accountEnabled === true;
  value.requiresPasswordChange = value.requiresPasswordChange === true;
  return value;
}

module.exports = { pickProfile, safePatient, PROFILE_FIELDS };
