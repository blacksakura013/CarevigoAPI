const User = require("../models/User");
const Health = require("../models/Health");
const response = require("../utils/response");
const { calculateBMI, calculateCVDRisk } = require("../utils/health");

exports.addHealth = async (req, res) => {
  try {
    const { userId, citizenId, type, value, weight, height } = req.body;

    // ===============================
    // ❗ VALIDATE INPUT
    // ===============================
    if (!type || !value) {
      return response.error({
        res,
        statusCode: 400,
        message: "type and value are required",
      });
    }

    const allowedTypes = ["blood_pressure", "sugar", "cholesterol"];

    if (!allowedTypes.includes(type)) {
      return response.error({
        res,
        statusCode: 400,
        message: "Invalid health type",
      });
    }

    // ===============================
    // 👤 FIND USER
    // ===============================
    let user = null;
    let isVerified = false;

    if (userId) {
      user = await User.findById(userId);

      if (!user) {
        return response.error({
          res,
          statusCode: 404,
          message: "User not found",
        });
      }

      isVerified = user.isVerified;
    } else if (citizenId) {
      // validate citizenId
      if (!/^\d{13}$/.test(citizenId)) {
        return response.error({
          res,
          statusCode: 400,
          message: "Invalid citizenId (must be 13 digits)",
        });
      }

      user = await User.findOne({ citizenId });

      // 🔥 create if not exist (public mode)
      if (!user) {
        user = await User.create({
          citizenId,
          status: "pending",
          isVerified: false,
        });
      }

      isVerified = user.isVerified;
    } else {
      return response.error({
        res,
        statusCode: 400,
        message: "userId or citizenId required",
      });
    }

    // ===============================
    // 📊 VALIDATE HEALTH VALUE
    // ===============================
    if (type === "blood_pressure") {
      if (
        !value.systolic ||
        !value.diastolic ||
        !value.pulse
      ) {
        return response.error({
          res,
          statusCode: 400,
          message: "Invalid blood pressure value",
        });
      }
    }

    if (type === "sugar") {
      if (!value.fbs && !value.hba1c) {
        return response.error({
          res,
          statusCode: 400,
          message: "Invalid sugar value",
        });
      }
    }

    if (type === "cholesterol") {
      if (!value.total) {
        return response.error({
          res,
          statusCode: 400,
          message: "Invalid cholesterol value",
        });
      }
    }

    // ===============================
    // ⚖️ BMI + CVD
    // ===============================
    let bmi = null;
    let cvdRisk = null;

    if (weight && height) {
      if (weight <= 0 || height <= 0) {
        return response.error({
          res,
          statusCode: 400,
          message: "Invalid weight or height",
        });
      }

      bmi = calculateBMI(weight, height);
      cvdRisk = calculateCVDRisk(bmi);
    }

    // ===============================
    // 💾 SAVE HEALTH RECORD
    // ===============================
    const record = await Health.create({
      userId: user._id,
      citizenId: user.citizenId,
      type,
      value,
      weight,
      height,
      bmi,
      cvdRisk,
      isVerified,
      source: "public",
      createdAt: new Date(),
    });

    // ===============================
    // 🔥 UPDATE USER (สำคัญ)
    // ===============================
    if (weight || height) {
      await User.findByIdAndUpdate(user._id, {
        ...(weight && { weight }),
        ...(height && { height }),
      });
    }

    // ===============================
    // ✅ RESPONSE
    // ===============================
    return response.success({
      res,
      message: "Health data recorded",
      data: {
        recordId: record._id,
        userId: user._id,
        bmi,
        cvdRisk,
        verified: isVerified,
      },
    });

  } catch (err) {
    console.error("❌ addHealth error:", err);

    return response.error({
      res,
      statusCode: 500,
      message: err.message || "Internal server error",
    });
  }
};