const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const response = require("../utils/response");
const { pickProfile, safePatient } = require("../utils/patientProfile");
const { refreshUserThaiCvRisk } = require("../services/thaiCvRisk.service");
const ids = require("../services/internalIds.service");
const { documentFilter } = require("../utils/internalQueries");
const cookieSessions = require("../services/cookieSession.service");
const { validateAgreements, agreementProof, sendAgreementError } = require("../utils/legal");

const attempts = new Map();
const LOCKOUT_MS = 15 * 60 * 1000;
const validPassword = password => typeof password === "string" && Buffer.byteLength(password, "utf8") <= 72 &&
  (/^\d{6}$/.test(password) || password.length >= 8);
const tokenFor = patient => jwt.sign({ id: String(patient._id), role: "user", type: "patient", tokenVersion: patient.tokenVersion,
  ...(ids.getInternalId(patient) === undefined ? {} : { internalId: ids.getInternalId(patient).toString() }) },
  process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "8h" });
const invalidLogin = res => response.error({ res, statusCode: 401, message: "เลขบัตรประชาชนหรือรหัสผ่านไม่ถูกต้อง" });

exports.login = async (req, res) => {
  try {
    const { citizenId, password } = req.body || {};
    if (typeof citizenId !== "string" || !/^\d{13}$/.test(citizenId) || !validPassword(password)) return invalidLogin(res);
    const key = crypto.createHash("sha256").update(citizenId).digest("hex");
    const now = Date.now();
    if (attempts.size > 10000) for (const [attemptKey, attempt] of attempts) if (attempt.until <= now) attempts.delete(attemptKey);
    let attempt = attempts.get(key);
    if (attempt && attempt.until <= now) { attempts.delete(key); attempt = null; }
    if (attempt?.failures >= 5) return response.error({ res, statusCode: 429, message: "เข้าสู่ระบบไม่สำเร็จหลายครั้ง กรุณารอ 15 นาทีแล้วลองอีกครั้ง" });
    const patient = await User.findOne({ citizenId }).select("+passwordHash +tokenVersion");
    // A fixed-cost comparison also runs when the account does not exist.
    const hash = patient?.passwordHash || "$2b$12$A0JDR5v3VxXwRW4tLVXWmewD1q1bL7QdGTTUXJH65bL9pa/QkA2HG";
    const matches = await bcrypt.compare(password, hash);
    if (!patient?.accountEnabled || !patient.passwordHash || !matches) {
      attempts.set(key, { failures: (attempt?.failures || 0) + 1, until: attempt?.until || now + LOCKOUT_MS });
      return invalidLogin(res);
    }
    attempts.delete(key);
    return response.success({ res, message: "เข้าสู่ระบบสำเร็จ", data: {
      ...(cookieSessions.cookieMode(req) ? { session: await cookieSessions.issue(req, res, "patient", patient) } : { accessToken: tokenFor(patient) }),
      patient: safePatient(patient), requiresPasswordChange: patient.requiresPasswordChange === true
    } });
  } catch { return response.error({ res, message: "เข้าสู่ระบบไม่สำเร็จ กรุณาลองอีกครั้ง" }); }
};

exports.me = async (req, res) => {
  try {
    const patient = safePatient(req.patient);
    const thaiCvRisk = await refreshUserThaiCvRisk(req.patient);
    patient.thaiCvRisk = thaiCvRisk;
    return response.success({ res, data: { patient, thaiCvRisk, requiresPasswordChange: patient.requiresPasswordChange } });
  } catch { return response.error({ res, message: "โหลดข้อมูลส่วนตัวไม่สำเร็จ" }); }
};

exports.updateMe = async (req, res) => {
  try {
    const legalAgreement = agreementProof(validateAgreements(req.body?.agreements, "patient-consent"), "patient-consent", req.user);
    const profile = pickProfile(req.body);
    const changes = { $set: { ...profile, legalAgreement }, $push: { legalAgreementHistory: legalAgreement } };
    const patient = await (ids.getInternalId(req.patient) === undefined
      ? User.findByIdAndUpdate(req.patient._id, changes, { new: true, runValidators: true })
      : User.findOneAndUpdate(documentFilter(req.patient), changes, { new: true, runValidators: true }));
    if (!patient) return response.error({ res, statusCode: 404, message: "ไม่พบข้อมูลบัญชี กรุณาเข้าสู่ระบบอีกครั้ง" });
    let thaiCvRisk = patient.thaiCvRisk || null;
    let assessmentRefreshPending = false;
    try { thaiCvRisk = await refreshUserThaiCvRisk(patient); }
    catch {
      // The profile and acceptance audit are already durable. A later GET /me
      // retries the assessment, without making the patient repeat this save.
      assessmentRefreshPending = true;
    }
    return response.success({ res, message: "บันทึกข้อมูลส่วนตัวแล้ว", data: { patient: { ...safePatient(patient), thaiCvRisk }, thaiCvRisk, requiresPasswordChange: false,
      ...(assessmentRefreshPending ? { assessmentRefreshPending: true } : {}) } });
  } catch (error) {
    if (sendAgreementError(error, res)) return;
    return response.error({ res, statusCode: 400, message: /[\u0E00-\u0E7F]/.test(error.message) ? error.message : "ข้อมูลส่วนตัวไม่ถูกต้อง" });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, password } = req.body || {};
    if (!validPassword(currentPassword) || !validPassword(password)) return response.error({ res, statusCode: 400, message: "ใช้รหัสตัวเลข 6 หลัก หรือรหัสผ่านอย่างน้อย 8 ตัวอักษร และไม่เกิน 72 ไบต์" });
    if (password === currentPassword) return response.error({ res, statusCode: 400, message: "กรุณาตั้งรหัสใหม่ให้ต่างจากรหัสเดิม" });
    const patient = await (ids.getInternalId(req.patient) === undefined
      ? User.findById(req.patient._id) : User.findOne(documentFilter(req.patient))).select("+passwordHash +tokenVersion");
    if (!patient || !(await bcrypt.compare(currentPassword, patient.passwordHash))) return response.error({ res, statusCode: 400, message: "รหัสผ่านปัจจุบันไม่ถูกต้อง" });
    const passwordHash = await bcrypt.hash(password, 12);
    const updated = await User.findOneAndUpdate({ ...documentFilter(patient), tokenVersion: req.user.tokenVersion },
      { $set: { passwordHash, requiresPasswordChange: false }, $inc: { tokenVersion: 1 } },
      { new: true, runValidators: true }).select("+tokenVersion");
    if (!updated) return response.error({ res, statusCode: 401, message: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง" });
    let authentication;
    if (cookieSessions.cookieMode(req)) {
      await cookieSessions.revokeAccount("patient", updated._id, updated.tokenVersion);
      authentication = { session: await cookieSessions.issue(req, res, "patient", updated) };
    } else authentication = { accessToken: tokenFor(updated) };
    return response.success({ res, message: "เปลี่ยนรหัสผ่านแล้ว", data: { ...authentication, patient: safePatient(updated), requiresPasswordChange: false } });
  } catch { return response.error({ res, message: "เปลี่ยนรหัสผ่านไม่สำเร็จ" }); }
};

exports.provisionAccount = async (req, res) => {
  try {
    let { password } = req.body || {};
    if (password === undefined || password === "") password = crypto.randomInt(0, 1000000).toString().padStart(6, "0");
    if (typeof password !== "string" || !/^\d{6}$/.test(password)) return response.error({ res, statusCode: 400, message: "รหัสเริ่มต้นต้องเป็นตัวเลข 6 หลัก" });
    const passwordHash = await bcrypt.hash(password, 12);
    const patient = await User.findByIdAndUpdate(req.params.id,
      { $set: { passwordHash, accountEnabled: true, requiresPasswordChange: true }, $inc: { tokenVersion: 1 } }, { new: true, runValidators: true });
    if (!patient) return response.error({ res, statusCode: 404, message: "ไม่พบผู้รับบริการ" });
    attempts.delete(crypto.createHash("sha256").update(patient.citizenId).digest("hex"));
    return response.success({ res, message: "ตั้งรหัสเริ่มต้นแล้ว แจ้งรหัสนี้แก่เจ้าของบัญชีอย่างปลอดภัย", data: { patient: safePatient(patient), requiresPasswordChange: true, temporaryPassword: password } });
  } catch { return response.error({ res, message: "ตั้งรหัสเริ่มต้นไม่สำเร็จ" }); }
};

exports.validPassword = validPassword;
