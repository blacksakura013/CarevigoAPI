// ======================================
// src/controllers/auth.controller.js
// ======================================

const Admin = require("../models/Admin");
const tokenService = require("../services/token.service");
const response = require("../utils/response");

// ======================================
// LOGIN
// POST /api/auth/login
// ======================================
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // ===============================
    // VALIDATION
    // ===============================
    if (!email || !password) {
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
    const admin = await Admin.findOne({
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
    const encodedPassword = Buffer
      .from(password)
      .toString("base64");

    if (encodedPassword !== admin.password) {
      return response.error({
        res,
        statusCode: 401,
        message: "Invalid password",
      });
    }

    // ===============================
    // GENERATE TOKEN
    // ===============================
    const tokens = tokenService.generateTokenPair({
      id: admin._id,
      email: admin.email,
      role: admin.role,
      type: "admin",
    });

    // ===============================
    // UPDATE LAST LOGIN
    // ===============================
    admin.lastLogin = new Date();
    await admin.save();

    // ===============================
    // RESPONSE
    // ===============================
    return response.success({
      res,
      message: "Login success",
      data: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        admin: {
          id: admin._id,
          email: admin.email,
          role: admin.role,
          lastLogin: admin.lastLogin,
        },
      },
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);

    return response.error({
      res,
      statusCode: 500,
      message: err.message,
    });
  }
};

// ======================================
// CHANGE PASSWORD
// POST /api/auth/change-password
// ======================================
exports.changePassword = async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return response.error({
        res,
        statusCode: 400,
        message: "Password is required",
      });
    }

    const admin = await Admin.findById(req.user.id);

    if (!admin) {
      return response.error({
        res,
        statusCode: 404,
        message: "Admin not found",
      });
    }

    admin.password = Buffer
      .from(password)
      .toString("base64");

    await admin.save();

    return response.success({
      res,
      message: "Password updated successfully",
      data: null,
    });

  } catch (err) {
    console.error("CHANGE PASSWORD ERROR:", err);

    return response.error({
      res,
      statusCode: 500,
      message: err.message,
    });
  }
};