const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const Admin = require("../models/Admin");
const sessions = require("../services/cookieSession.service");
const email = require("../services/email.service");
const { allowedOrigins } = require("../config/origins");
const { credentialVersion, versionFilter } = require("../utils/adminCredentials");
const { documentFilter } = require("../utils/internalQueries");
const { smtpFailure } = require("../utils/mailDiagnostics");

const RESET_MS = 30 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const deliveries = new Set();
const tokenHash = token => crypto.createHash("sha256").update(token).digest("hex");
const validToken = token => typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
const validPassword = password => typeof password === "string" && password.length >= 8 && Buffer.byteLength(password, "utf8") <= 72;
const invalidLink = res => res.status(400).json({ statusCode: 400, code: "RESET_LINK_INVALID",
  message: "ลิงก์ตั้งรหัสผ่านไม่ถูกต้อง หมดอายุ หรือถูกใช้แล้ว กรุณาขอลิงก์ใหม่", data: null });
const accepted = res => res.status(202).json({ statusCode: 202,
  message: "หากอีเมลนี้มีบัญชีเจ้าหน้าที่ที่ใช้งานได้ ระบบจะส่งลิงก์ตั้งรหัสผ่านให้ กรุณาตรวจสอบอีเมลและจดหมายขยะ", data: null });
const unsetReset = { passwordResetTokenHash: 1, passwordResetExpiresAt: 1 };

function frontendOrigin(req) {
  const allowlist = allowedOrigins();
  const requestOrigin = req.headers?.origin;
  if (process.env.NODE_ENV !== "production" && allowlist.includes(requestOrigin)) return requestOrigin;
  try {
    const url = new URL(process.env.FRONTEND_URL);
    if (url.username || url.password || !allowlist.includes(url.origin)) return null;
    if (url.protocol === "https:" || process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) return url.origin;
  } catch { /* Do not infer a recipient URL from Host or an untrusted Origin. */ }
  return null;
}

function deliver(message, admin, hash) {
  // SMTP does not delay the public response differently for known accounts.
  // Failed delivery invalidates only this still-current link, without touching
  // a more recent request. No raw capability is persisted in an outbox.
  const task = Promise.resolve().then(() => email.sendAdminPasswordReset(message)).then(() => {
    console.info("Admin password reset delivery", { outcome: "smtp_accepted", at: new Date().toISOString() });
  }).catch(async error => {
    console.warn("Admin password reset delivery", { outcome: "failed", at: new Date().toISOString(), ...smtpFailure(error) });
    try { await Admin.updateOne({ ...documentFilter(admin), passwordResetTokenHash: hash }, { $unset: unsetReset }); } catch { /* Expiry and credential CAS remain authoritative. */ }
  });
  deliveries.add(task);
  task.finally(() => deliveries.delete(task));
}

exports.forgot = async (req, res) => {
  try {
    const supplied = req.body?.email;
    if (typeof supplied !== "string" || supplied.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplied.trim())) return accepted(res);
    const origin = frontendOrigin(req);
    if (!origin) return accepted(res);
    const now = new Date(), token = crypto.randomBytes(32).toString("base64url"), hash = tokenHash(token);
    const admin = await Admin.findOneAndUpdate({ email: supplied.trim().toLowerCase(), isActive: true,
      $or: [{ passwordResetRequestedAt: { $lte: new Date(now.getTime() - COOLDOWN_MS) } }, { passwordResetRequestedAt: { $exists: false } }] },
    { $set: { passwordResetTokenHash: hash, passwordResetExpiresAt: new Date(now.getTime() + RESET_MS), passwordResetRequestedAt: now } },
    { new: true, runValidators: true });
    if (admin) deliver({ recipient: admin.email, resetUrl: `${origin}/admin/reset-password#token=${token}`,
      expiresAt: new Date(now.getTime() + RESET_MS) }, admin, hash);
  } catch (error) {
    console.warn("Admin password reset request", { outcome: "failed", at: new Date().toISOString(), ...smtpFailure(error) });
    // Keep the same public response for unavailable delivery and unknown accounts.
  }
  return accepted(res);
};

async function resetAccount(token) {
  if (!validToken(token)) return null;
  return Admin.findOne({ passwordResetTokenHash: tokenHash(token), passwordResetExpiresAt: { $gt: new Date() }, isActive: true });
}

exports.validate = async (req, res) => {
  try {
    if (!await resetAccount(req.body?.token)) return invalidLink(res);
    return res.status(200).json({ statusCode: 200, data: { valid: true } });
  } catch { return res.status(503).json({ statusCode: 503, message: "ยังตรวจสอบลิงก์ไม่สำเร็จ กรุณาลองอีกครั้ง", data: null }); }
};

exports.reset = async (req, res) => {
  const { token, password, confirmPassword } = req.body || {};
  if (!validToken(token)) return invalidLink(res);
  if (!validPassword(password) || confirmPassword !== password) return res.status(400).json({ statusCode: 400,
    code: "PASSWORD_INVALID", message: "ใช้รหัสผ่านอย่างน้อย 8 ตัวอักษร ไม่เกิน 72 ไบต์ และยืนยันรหัสผ่านให้ตรงกัน", data: null });
  try {
    const admin = await resetAccount(token);
    if (!admin) return invalidLink(res);
    const passwordHash = await bcrypt.hash(password, 12);
    const updated = await Admin.findOneAndUpdate({ $and: [documentFilter(admin), versionFilter(credentialVersion(admin)),
      { isActive: true, passwordResetTokenHash: tokenHash(token), passwordResetExpiresAt: { $gt: new Date() } }] },
    { $set: { password: passwordHash }, $inc: { tokenVersion: 1 }, $unset: unsetReset }, { new: true, runValidators: true });
    if (!updated) return invalidLink(res);
    // The version update already invalidates cookies and legacy Bearer tokens.
    // Session deletion is housekeeping and cannot turn a durable reset into an
    // ambiguous error that asks the person to reuse a consumed link.
    try { await sessions.revokeAccount("admin", updated._id, credentialVersion(updated)); } catch { /* Version checked on every protected request. */ }
    return res.status(200).json({ statusCode: 200, message: "ตั้งรหัสผ่านใหม่แล้ว กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่", data: null });
  } catch { return res.status(503).json({ statusCode: 503, message: "ยังตั้งรหัสผ่านไม่สำเร็จ กรุณาลองอีกครั้ง", data: null }); }
};

exports.flushDeliveries = async () => Promise.allSettled([...deliveries]);
exports.frontendOrigin = frontendOrigin;
exports.validPassword = validPassword;
