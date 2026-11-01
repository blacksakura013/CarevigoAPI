// ======================================
// src/middleware/auth.middleware.js
// ======================================

const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Admin = require("../models/Admin");
const ids = require("../services/internalIds.service");
const cookieSessions = require("../services/cookieSession.service");
const { credentialVersion } = require("../utils/adminCredentials");

// ======================================
// VERIFY JWT
// ======================================

module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const cookieMode = cookieSessions.cookieMode(req);
    let decoded;

    if (cookieMode) {
      let accepted = false;
      cookieSessions.browserRequest(req, res, () => { accepted = true; });
      if (!accepted) return;
      decoded = await cookieSessions.authenticate(req);
      res.set("X-Carevigo-Session-Id", decoded.sid);
      if (!req.sessionBootstrap && req.headers["x-carevigo-session-id"] !== decoded.sid) {
        return res.status(409).json({ statusCode: 409, title: "Error", code: "SESSION_CHANGED",
          message: "บัญชีในเบราว์เซอร์เปลี่ยนแล้ว กรุณาโหลดเซสชันใหม่", data: null });
      }
      if (!cookieSessions.csrfGuard(req, res)) return;
      // Revoking an already authenticated cookie must remain possible after its
      // account is disabled or its role changes. This route exposes no account
      // data; all cookie/session, origin, generation and CSRF checks still run.
      if (req.sessionRevocationOnly) return next();
    } else {

    if (!authHeader) {
      return res.status(401).json({
        statusCode: 401,
        title: "Unauthorized",
        message: "Authorization header is required",
      });
    }

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        statusCode: 401,
        title: "Unauthorized",
        message: "Invalid authorization format",
      });
    }

    const token = authHeader.substring(7);

    decoded = jwt.verify(
      token,
      process.env.JWT_SECRET,
      { algorithms: ["HS256"] }
    );
    // A cookie token must never be usable through the legacy Bearer path.
    if (decoded.sid || decoded.csrf) throw new Error("Cookie session requires browser protections");
    }

    if (!decoded.id || !["admin", "patient"].includes(decoded.type)) throw new Error("Invalid account token");
    let internalId;
    if (decoded.internalId !== undefined) {
      if (typeof decoded.internalId !== "string" || !/^[1-9]\d*$/.test(decoded.internalId)) throw new Error("Invalid internal account ID");
      internalId = ids.toInternalId(decoded.internalId);
    }
    if (decoded.type === "patient") {
      if (decoded.role !== "user") throw new Error("Invalid patient role");
      const patient = await (internalId === undefined ? User.findById(decoded.id) : User.findOne({ internalId })).select("+tokenVersion");
      if (!patient || !patient.accountEnabled || !Number.isInteger(decoded.tokenVersion) ||
          decoded.tokenVersion !== patient.tokenVersion || String(patient._id) !== String(decoded.id)) throw new Error("Account session revoked");
      req.patient = patient;
    } else {
      if (!["admin", "superadmin"].includes(decoded.role)) throw new Error("Invalid staff role");
      const admin = await (internalId === undefined ? Admin.findById(decoded.id) : Admin.findOne({ internalId, isActive: true }));
      if (!admin || !admin.isActive || String(admin._id) !== String(decoded.id) || admin.role !== decoded.role) throw new Error("Staff session revoked");
      const version = decoded.tokenVersion === undefined ? 0 : decoded.tokenVersion;
      if (!Number.isSafeInteger(version) || version < 0 || version !== credentialVersion(admin)) throw new Error("Staff credentials revoked");
      decoded.tokenVersion = version;
      req.admin = admin;
    }

    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
      type: decoded.type,
      tokenVersion: decoded.tokenVersion,
      internalId,
    };

    next();

  } catch (err) {
    return res.status(401).json({
      statusCode: 401,
      title: "Unauthorized",
      message: "Invalid or expired token",
    });
  }
};
