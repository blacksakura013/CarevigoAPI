// src/controllers/auth.controller.js

const Admin = require("../models/Admin");

const otpService = require("../services/otp.service");
const emailService = require("../services/email.service");
const tokenService = require("../services/token.service");

const response = require("../utils/response");

// ===============================
// REQUEST OTP
// ===============================
exports.requestOTP = async (req, res) => {
  try {

    const { email } = req.body;

    console.log("📩 REQUEST OTP:", email);

    // ✅ validation
    if (!email) {
      return response.error({
        res,
        statusCode: 400,
        message: "Email is required"
      });
    }

    // ✅ admin
    const admin = await Admin.findOne({
      email,
      isActive: true
    });

    console.log("👤 ADMIN:", admin ? admin.email : null);

    if (!admin) {
      return response.error({
        res,
        statusCode: 404,
        message: "Admin not found"
      });
    }

    // ✅ generate otp
    const otp = await otpService.sendOTP(email);

    console.log("🔐 OTP GENERATED:", otp);

    // ✅ email
    try {

      await emailService.sendOTPEmail(email, otp);

      console.log("✅ EMAIL SENT");

    } catch (emailErr) {

      console.error("❌ EMAIL ERROR:", emailErr.message);

      // 🔥 fallback
      return response.success({
        res,
        message: "OTP generated (email failed)",
        data: {
          otp // remove in production
        }
      });
    }

    return response.success({
      res,
      message: "OTP sent to email",
      data: null
    });

  } catch (err) {

    console.error("❌ REQUEST OTP ERROR:", err);

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

    console.log("🔎 VERIFY OTP:", email);

    // ✅ validation
    if (!email || !otp) {
      return response.error({
        res,
        statusCode: 400,
        message: "Email and OTP are required"
      });
    }

    // ✅ admin
    const admin = await Admin.findOne({
      email,
      isActive: true
    });

    if (!admin) {
      return response.error({
        res,
        statusCode: 404,
        message: "Admin not found"
      });
    }

    // ✅ verify
    await otpService.verifyOTP(email, otp);

    console.log("✅ OTP VERIFIED");

    // ✅ tokens
    const tokens = tokenService.generateTokens(admin);

    // ✅ update login
    admin.lastLogin = new Date();

    await admin.save();

    return response.success({
      res,
      message: "Login success",
      data: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,

        admin: {
          id: admin._id,
          email: admin.email,
          role: admin.role
        }
      }
    });

  } catch (err) {

    console.error("❌ VERIFY OTP ERROR:", err);

    return response.error({
      res,
      message: err.message
    });
  }
};