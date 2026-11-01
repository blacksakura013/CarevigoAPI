const User = require("../models/User");
const Health = require("../models/Health");
const { calculateBMI, calculateCVDRisk } = require("../utils/health");
const response = require("../utils/response");
const { getPagination } = require("../utils/pagination");
const { refreshUserThaiCvRisk } = require("../services/thaiCvRisk.service");
const ids = require("../services/internalIds.service");
const { documentFilter, healthForUser } = require("../utils/internalQueries");
const { validateAgreements, agreementProof, sendAgreementError } = require("../utils/legal");

// Existing profiles are provisioned by staff; health submission never creates one.
const findOrCreateUser = async (citizenId) => {
  const user = await User.findOne({ citizenId });
  return { user, isNew: false };
};

// 🧪 POST /api/public/health
exports.submitHealth = async (req, res) => {
  try {
    const { citizenId, type, value, weight, height } = req.body || {};
    const legalSource = req.user?.type === "admin" ? "staff-attestation" : "patient-consent";
    const legalAgreement = agreementProof(validateAgreements(req.body?.agreements, legalSource), legalSource, req.user);

    if (typeof citizenId !== "string" || !/^\d{13}$/.test(citizenId) ||
        !["blood_pressure", "sugar", "cholesterol", "bmi"].includes(type)) {
      return response.error({
        res,
        statusCode: 400,
        message: "citizenId and type are required"
      });
    }

    const { user, isNew } = req.patient?.citizenId === citizenId
      ? { user: req.patient, isNew: false } : await findOrCreateUser(citizenId);
    if (!user) return response.error({ res, statusCode: 404, message: "ไม่พบผู้รับบริการ กรุณาติดต่อเจ้าหน้าที่" });
    if (!value || typeof value !== "object" || Array.isArray(value)) return response.error({ res, statusCode: 400, message: "กรุณาระบุค่าผลตรวจ" });
    const supplied = Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== "");
    const fields = {
      blood_pressure: ["systolic", "diastolic", "pulse"], sugar: ["fbs", "hba1c"],
      cholesterol: ["total", "ldl", "hdl", "triglyceride"], bmi: ["weight", "height"]
    }[type];
    if (supplied.some(([name, item]) => !fields.includes(name) || !Number.isFinite(Number(item)) || Number(item) <= 0)) {
      return response.error({ res, statusCode: 400, message: "ค่าผลตรวจต้องเป็นตัวเลขมากกว่า 0" });
    }
    const required = type === "blood_pressure" ? ["systolic", "diastolic"] : type === "cholesterol" ? ["total"] : [];
    if (required.some(name => !Number.isFinite(Number(value[name])) || Number(value[name]) <= 0) ||
        (type === "sugar" && !supplied.length) ||
        (type === "bmi" && (!Number.isFinite(Number(weight)) || !Number.isFinite(Number(height)) || Number(weight) <= 0 || Number(height) <= 0))) {
      return response.error({ res, statusCode: 400, message: "กรุณากรอกค่าที่จำเป็นให้ครบในหมวดที่เลือก" });
    }
    if ((weight !== undefined && (!Number.isFinite(Number(weight)) || Number(weight) <= 0)) ||
        (height !== undefined && (!Number.isFinite(Number(height)) || Number(height) <= 0))) {
      return response.error({ res, statusCode: 400, message: "น้ำหนักและส่วนสูงต้องมากกว่า 0" });
    }

    // 🔓 default: public ไม่ต้อง verify ก็ save ได้
    const isVerified = user.isVerified === true;

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
      userKey: await ids.ensureInternalId(User, user),
      legalAgreement,
      citizenId,
      type,
      value: Object.fromEntries(supplied.map(([name, item]) => [name, Number(item)])),
      weight,
      height,
      bmi,
      cvdRisk,
      isVerified,
      source: req.user?.type === "admin" ? "admin" : "patient",
      reviewStatus: "approved", submittedAt: new Date(), materializedAt: new Date(), reviewedAt: new Date(),
      reviewSource: req.user?.type === "admin" ? "admin" : "patient",
      reviewHistory: [{ at: new Date(), status: "approved", from: null, to: "approved",
        source: req.user?.type === "admin" ? "admin" : "patient", actor: req.user?.id, actorId: req.user?.id,
        adminKey: req.user?.type === "admin" ? req.user.internalId : undefined,
        reason: "บันทึกจากบัญชีที่เข้าสู่ระบบ" }],
      createdAt: new Date()
    });
    let thaiCvRisk = null;
    try {
      thaiCvRisk = await refreshUserThaiCvRisk(user);
      if (ids.getInternalId(record) === undefined) await Health.findByIdAndUpdate(record._id, { $set: { thaiCvRisk } });
      else await Health.findOneAndUpdate(documentFilter(record), { $set: { thaiCvRisk } });
    } catch {
      // A persisted health record remains a successful save even if assessment
      // refresh fails; GET /patient/me can recalculate without duplicating it.
    }

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
        thaiCvRisk,
        recordId: record._id,
        reviewStatus: "approved"
      }
    });

  } catch (err) {
    if (sendAgreementError(err, res)) return;
    return response.error({
      res,
      message: err.message
    });
  }
};

// 📄 GET /api/public/health (load more)
exports.getHealthByCitizen = async (req, res) => {
  try {
    const { citizenId, type } = req.query;

    if (typeof citizenId !== "string" || !citizenId.trim()) {
      return response.error({
        res,
        statusCode: 400,
        message: "citizenId required"
      });
    }

    if (type !== undefined && typeof type !== "string") {
      return response.error({
        res,
        statusCode: 400,
        message: "Invalid health type"
      });
    }

    const { page, limit, skip } = getPagination(req.query);
    const user = req.patient || (req.user ? await User.findOne({ citizenId: citizenId.trim() }) : undefined);
    const filter = user ? healthForUser(user) : { citizenId: citizenId.trim() };
    if (type && type.trim()) filter.type = type.trim();

    const [data, total] = await Promise.all([
      Health.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit),
      Health.countDocuments(filter)
    ]);

    return response.success({
      res,
      message: "Get health success",
      data,
      total,
      page,
      limit
    });

  } catch (err) {
    return response.error({
      res,
      message: err.message
    });
  }
};
