// src/controllers/auth.controller.js

const Admin = require("../models/Admin");

const otpService = require("../services/otp.service");
const emailService = require("../services/email.service");
const tokenService = require("../services/token.service");

const response = require("../utils/response");

// ===============================
// CONFIG
// ===============================
const isDev = process.env.NODE_ENV !== "production";

// ===============================
// REQUEST OTP
// ===============================
exports.requestOTP = async (req, res) => {
  try {

    const { email } = req.body;

    // ===============================
    // VALIDATION
    // ===============================
    if (!email) {
      return response.error({
        res,
        statusCode: 400,
        message: "Email is required"
      });
    }

    // ===============================
    // NORMALIZE EMAIL
    // ===============================
    const normalizedEmail =
      email.trim().toLowerCase();

    console.log("📩 REQUEST OTP:", normalizedEmail);

    // ===============================
    // FIND ADMIN
    // ===============================
    const admin = await Admin.findOne({
      email: normalizedEmail,
      isActive: true
    });

    console.log(
      "👤 ADMIN:",
      admin ? admin.email : null
    );

    if (!admin) {
      return response.error({
        res,
        statusCode: 404,
        message: "Admin not found"
      });
    }

    // ===============================
    // GENERATE OTP
    // ===============================
    const otp =
      await otpService.sendOTP(normalizedEmail);

    console.log("🔐 OTP GENERATED");

    // ===============================
    // SEND EMAIL
    // ===============================
    try {

      await emailService.sendOTPEmail(
        normalizedEmail,
        otp
      );

      console.log("✅ EMAIL SENT");

      return response.success({
        res,
        message: "OTP sent to email",
        data: null
      });

    } catch (emailErr) {

      console.error(
        "❌ EMAIL ERROR:",
        emailErr.message
      );

      // 🔥 fallback mode
      return response.success({
        res,
        message: "OTP generated (email failed)",

        data: isDev
          ? { otp }
          : null
      });
    }

  } catch (err) {

    console.error(
      "❌ REQUEST OTP ERROR:",
      err
    );

    return response.error({
      res,
      message: err.message
    });
  }
};

// ===============================
// VERIFY OTP
// ===============================
exports.verifyOTP = async (req, res) => {
  try {

    const { email, otp } = req.body;

    // ===============================
    // VALIDATION
    // ===============================
    if (!email || !otp) {
      return response.error({
        res,
        statusCode: 400,
        message: "Email and OTP are required"
      });
    }

    // ===============================
    // NORMALIZE EMAIL
    // ===============================
    const normalizedEmail =
      email.trim().toLowerCase();

    console.log(
      "🔎 VERIFY OTP:",
      normalizedEmail
    );

    // ===============================
    // FIND ADMIN
    // ===============================
    const admin = await Admin.findOne({
      email: normalizedEmail,
      isActive: true
    });

    if (!admin) {
      return response.error({
        res,
        statusCode: 404,
        message: "Admin not found"
      });
    }

    // ===============================
    // VERIFY OTP
    // ===============================
    await otpService.verifyOTP(
      normalizedEmail,
      otp
    );

    console.log("✅ OTP VERIFIED");

    // ===============================
    // GENERATE TOKENS
    // ===============================
    const tokens =
      tokenService.generateTokens(admin);

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
        accessToken:
          tokens.accessToken,

        refreshToken:
          tokens.refreshToken,

        admin: {
          id: admin._id,

          email: admin.email,

          role: admin.role,

          lastLogin:
            admin.lastLogin
        }
      }
    });

  } catch (err) {

    console.error(
      "❌ VERIFY OTP ERROR:",
      err
    );

    return response.error({
      res,
      message: err.message
    });
  }
};