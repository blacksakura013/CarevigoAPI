const express = require("express");
const router = express.Router();

const authController = require("../controllers/auth.controller");
const authMiddleware = require("../middleware/auth.middleware");
const patientAuth = require("../controllers/patient.auth.controller");
const { requireStaff, requirePatient, requirePatientReady } = require("../middleware/access.middleware");
const rateLimit = require("express-rate-limit");
const cookieSessions = require("../services/cookieSession.service");
const sessionController = require("../controllers/session.controller");
const passwordReset = require("../controllers/passwordReset.controller");
const resetLimitMessage = { statusCode: 429, code: "RESET_RATE_LIMIT", message: "ทำรายการถี่เกินไป กรุณารอแล้วลองอีกครั้ง", data: null };
const forgotLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: resetLimitMessage });
const validateResetLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: resetLimitMessage });
const completeResetLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: resetLimitMessage });
const configuredIpLimit = Number(process.env.PATIENT_LOGIN_IP_LIMIT);
const patientIpLimit = /^\d+$/.test(process.env.PATIENT_LOGIN_IP_LIMIT || "") &&
  Number.isInteger(configuredIpLimit) && configuredIpLimit >= 1 && configuredIpLimit <= 10000 ? configuredIpLimit : 100;
const patientLoginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: patientIpLimit, standardHeaders: true, legacyHeaders: false,
  message: { statusCode: 429, message: "เข้าสู่ระบบถี่เกินไป กรุณารอแล้วลองอีกครั้ง", data: null } });
const staffLoginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false,
  message: { statusCode: 429, message: "เข้าสู่ระบบเจ้าหน้าที่ถี่เกินไป กรุณารอแล้วลองอีกครั้ง", data: null } });

router.get("/session", sessionController.requireCookie, (req, res, next) => { req.sessionBootstrap = true; next(); }, authMiddleware, sessionController.me);
router.post("/logout", sessionController.requireCookie, (req, res, next) => { req.sessionRevocationOnly = true; next(); }, authMiddleware, sessionController.logout);

router.post("/patient/login", cookieSessions.loginRequest("patient"), patientLoginLimit, patientAuth.login);
router.get("/patient/me", authMiddleware, requirePatient, require("../middleware/review.middleware"), patientAuth.me);
router.patch("/patient/me", authMiddleware, requirePatient, requirePatientReady, patientAuth.updateMe);
router.post("/patient/change-password", authMiddleware, requirePatient, patientLoginLimit, patientAuth.changePassword);

router.post("/login", cookieSessions.loginRequest("admin"), staffLoginLimit, authController.login);

// An email capability replaces authentication for recovery. Browser origin and
// admin scope still apply; ambient cookies and CSRF metadata are not consumed.
router.post("/forgot-password", sessionController.requireCookie, cookieSessions.loginRequest("admin"), forgotLimit, passwordReset.forgot);
router.post("/reset-password/validate", sessionController.requireCookie, cookieSessions.loginRequest("admin"), validateResetLimit, passwordReset.validate);
router.post("/reset-password", sessionController.requireCookie, cookieSessions.loginRequest("admin"), completeResetLimit, passwordReset.reset);

router.post(
  "/change-password",
  authMiddleware,
  requireStaff,
  authController.changePassword
);

module.exports = router;
