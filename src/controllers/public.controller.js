const User = require("../models/User");
const Health = require("../models/Health");
const { calculateBMI, calculateCVDRisk } = require("../utils/health");
const response = require("../utils/response");

// 🔎 helper: find or create draft
const findOrCreateUser = async (citizenId) => {
  let user = await User.findOne({ citizenId });

  if (!user) {
    user = await User.create({
      citizenId,
      status: "pending",
      isVerified: false
    });
    return { user, isNew: true };
  }

  return { user, isNew: false };
};

// 🧪 POST /api/public/health
exports.submitHealth = async (req, res) => {
  try {
    const { citizenId, birthDate, type, value, weight, height } = req.body;

    if (!citizenId || !type) {
      return response.error({
        res,
        statusCode: 400,
        message: "citizenId and type are required"
      });
    }

    const { user, isNew } = await findOrCreateUser(citizenId);

    // 🔓 default: public ไม่ต้อง verify ก็ save ได้
    let isVerified = user?.isVerified || false;

    // 🔐 OPTIONAL: ถ้ามี birthDate และ user มีข้อมูล → ตรวจให้ (ไม่ผ่านก็ไม่ block)
    if (!isNew && user.birthDate && birthDate) {
      const normalize = (d) =>
        new Date(d).toISOString().slice(0, 10);

      if (normalize(user.birthDate) === normalize(birthDate)) {
        isVerified = true; // ยืนยันตัวตนผ่าน
      }
      // ❗ ไม่ throw 403 แล้ว (ปล่อยผ่านเป็น unverified)
    }

    // 📊 BMI + CVD
    let bmi = null;
    let cvdRisk = null;

    if (weight && height) {
      bmi = calculateBMI(weight, height);
      cvdRisk = calculateCVDRisk(bmi);
    }

    // 💾 save
    const record = await Health.create({
      userId: user._id,
      citizenId,
      type,
      value,
      weight,
      height,
      bmi,
      cvdRisk,
      isVerified,
      source: "public",
      date: new Date()
    });

    return response.success({
      res,
      message: isNew
        ? "User not found. Draft created and health saved"
        : "Health data saved",
      data: {
        userId: user._id,       // 🔥 เพิ่มให้ frontend ใช้ต่อ
        verified: isVerified,
        bmi,
        cvdRisk,
        recordId: record._id
      }
    });

  } catch (err) {
    return response.error({
      res,
      message: err.message
    });
  }
};

// 📄 GET /api/public/health (load more)
exports.getHealthByCitizen = async (req, res) => {
  try {
    const { citizenId, page = 1, limit = 10 } = req.query;

    if (!citizenId) {
      return response.error({
        res,
        statusCode: 400,
        message: "citizenId required"
      });
    }

    const p = parseInt(page);
    const l = parseInt(limit);

    const skip = (p - 1) * l;

    const [data, total] = await Promise.all([
      Health.find({ citizenId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(l),
      Health.countDocuments({ citizenId })
    ]);

    return response.success({
      res,
      message: "Get health success",
      data,
      total,
      page: p,
      limit: l
    });

  } catch (err) {
    return response.error({
      res,
      message: err.message
    });
  }
};