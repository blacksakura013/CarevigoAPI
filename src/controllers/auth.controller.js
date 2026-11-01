// ======================================
// src/controllers/auth.controller.js
// ======================================

const Admin = require("../models/Admin");
const bcrypt = require("bcrypt");
const crypto = require("node:crypto");
const tokenService = require("../services/token.service");
const response = require("../utils/response");
const ids = require("../services/internalIds.service");
const cookieSessions = require("../services/cookieSession.service");
const { credentialVersion, versionFilter } = require("../utils/adminCredentials");
const { documentFilter } = require("../utils/internalQueries");

// ======================================
// LOGIN
// POST /api/auth/login
// ======================================
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    // ===============================
    // VALIDATION
    // ===============================
    if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password || Buffer.byteLength(password, "utf8") > 72) {
      return response.error({
        res,
        statusCode: 400,
        message: "Email and password are required",
      });
    }

    // ===============================
    // NORMALIZE EMAIL
    // ===============================
    const normalizedEmail = email.trim().toLowerCase();

    // ===============================
    // FIND ADMIN
    // ===============================
    let admin = await Admin.findOne({
      email: normalizedEmail,
      isActive: true,
    });

    if (!admin) {
      return response.error({
        res,
        statusCode: 404,
        message: "Admin not found",
      });
    }

    // ===============================
    // PASSWORD NOT CONFIGURED
    // ===============================
    if (!admin.password) {
      return response.error({
        res,
        statusCode: 403,
        message: "Password not configured",
      });
    }

    // ===============================
    // VERIFY PASSWORD
    // ===============================
    const hashed = /^\$2[aby]\$\d{2}\$/.test(admin.password);
    const encodedPassword = Buffer.from(password).toString("base64");
    const legacyMatch = !hashed && Buffer.byteLength(encodedPassword) === Buffer.byteLength(admin.password) &&
      crypto.timingSafeEqual(Buffer.from(encodedPassword), Buffer.from(admin.password));
    const matches = hashed ? await bcrypt.compare(password, admin.password) : legacyMatch;
    if (!matches) {
      return response.error({
        res,
        statusCode: 401,
        message: "Invalid password",
      });
    }
    const version = credentialVersion(admin);
    const storedPassword = admin.password;
    const migratedPassword = !hashed ? await bcrypt.hash(password, 12) : undefined;

    // ===============================
    // Persist login/password migration and the allocated internal ID first.
    // ===============================
    // A reset may complete while password verification or legacy hashing waits.
    // Compare the original credential and version atomically so login cannot
    // overwrite the newer password or issue a current token for an old password.
    admin = await Admin.findOneAndUpdate({ $and: [documentFilter(admin), versionFilter(version),
      { password: storedPassword, isActive: true, role: admin.role }] },
    { $set: { lastLogin: new Date(), ...(migratedPassword ? { password: migratedPassword } : {}) } },
    { new: true, runValidators: true });
    if (!admin) return response.error({ res, statusCode: 401, message: "ข้อมูลเข้าสู่ระบบเปลี่ยนแล้ว กรุณาลองอีกครั้ง" });
    const identity = {
      id: admin._id,
      internalId: ids.getInternalId(admin),
      email: admin.email,
      role: admin.role,
      type: "admin",
      tokenVersion: credentialVersion(admin),
    };
    const authentication = cookieSessions.cookieMode(req)
      ? { session: await cookieSessions.issue(req, res, "admin", admin) }
      : tokenService.generateTokenPair(identity);

    // ===============================
    // RESPONSE
    // ===============================
    return response.success({
      res,
      message: "Login success",
      data: {
        ...authentication,
        admin: {
          id: admin._id,
          email: admin.email,
          role: admin.role,
          lastLogin: admin.lastLogin,
        },
      },
    });

  } catch (err) {
    return response.error({
      res,
      statusCode: 500,
      message: "เข้าสู่ระบบเจ้าหน้าที่ไม่สำเร็จ กรุณาลองอีกครั้ง",
    });
  }
};

// ======================================
// CHANGE PASSWORD
// POST /api/auth/change-password
// ======================================
exports.changePassword = async (req, res) => {
  try {
    const { password } = req.body || {};

    if (typeof password !== "string" || password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
      return response.error({
        res,
        statusCode: 400,
        message: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร และไม่เกิน 72 ไบต์",
      });
    }

    const admin = await (req.user.internalId === undefined ? Admin.findById(req.user.id) : Admin.findOne({ internalId: req.user.internalId }));

    if (!admin) {
      return response.error({
        res,
        statusCode: 404,
        message: "Admin not found",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const expectedVersion = req.user.tokenVersion === undefined ? 0 : req.user.tokenVersion;
    const updated = await Admin.findOneAndUpdate({ $and: [documentFilter(admin), versionFilter(expectedVersion), { isActive: true }] },
      { $set: { password: passwordHash }, $inc: { tokenVersion: 1 },
        $unset: { passwordResetTokenHash: 1, passwordResetExpiresAt: 1 } }, { new: true, runValidators: true });
    if (!updated) return response.error({ res, statusCode: 401, message: "ข้อมูลเข้าสู่ระบบเปลี่ยนแล้ว กรุณาเข้าสู่ระบบอีกครั้ง" });

    let session;
    if (cookieSessions.cookieMode(req)) {
      await cookieSessions.revokeAccount("admin", updated._id, credentialVersion(updated));
      session = await cookieSessions.issue(req, res, "admin", updated);
    }

    return response.success({
      res,
      message: "Password updated successfully",
      data: session ? { session, admin: { id: updated._id, email: updated.email, role: updated.role, lastLogin: updated.lastLogin } } : null,
    });

  } catch (err) {
    return response.error({
      res,
      statusCode: 500,
      message: "เปลี่ยนรหัสผ่านไม่สำเร็จ กรุณาลองอีกครั้ง",
    });
  }
};
