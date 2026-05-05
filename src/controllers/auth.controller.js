// src/controllers/auth.controller.js
const Admin = require("../models/Admin");
const otpService = require("../services/otp.service");
const emailService = require("../services/email.service");
const tokenService = require("../services/token.service");
const response = require("../utils/response");

exports.requestOTP = async (req, res) => {
  try {
    const { email } = req.body;

    // ✅ validation
    if (!email) {
      return response.error({
        res,
        statusCode: 400,
        message: "Email is required"
      });
    }

    const admin = await Admin.findOne({ email, isActive: true });

    if (!admin) {
      return response.error({
        res,
        statusCode: 404,
        message: "Admin not found"
      });
    }

    const otp = await otpService.sendOTP(email);
    await emailService.sendOTPEmail(email, otp);

    return response.success({
      res,
      message: "OTP sent to email",
      data: null
    });

  } catch (err) {
    return response.error({
      res,
      message: err.message
    });
  }
};

exports.verifyOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;

    // ✅ validation
    if (!email || !otp) {
      return response.error({
        res,
        statusCode: 400,
        message: "Email and OTP are required"
      });
    }

    const admin = await Admin.findOne({ email, isActive: true });

    if (!admin) {
      return response.error({
        res,
        statusCode: 404,
        message: "Admin not found"
      });
    }

    await otpService.verifyOTP(email, otp);

    const tokens = tokenService.generateTokens(admin);

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
    return response.error({
      res,
      message: err.message
    });
  }
};