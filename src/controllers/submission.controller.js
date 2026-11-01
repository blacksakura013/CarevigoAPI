const crypto = require("node:crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const Health = require("../models/Health");
const Submission = require("../models/Submission");
const { pickProfile } = require("../utils/patientProfile");
const { calculateThaiCvRisk } = require("../utils/thaiCvRisk");
const { reviewDeadline, normalizeHealthRecord, hashToken, tokenFor, safeReviewRecord, submissionRecordsFilter } = require("../utils/review");
const ids = require("../services/internalIds.service");
const { materializeSubmission, prepareNotifications, approveOverdue } = require("../services/review.service");
const response = require("../utils/response");
const { validateAgreements, agreementProof, sendAgreementError } = require("../utils/legal");
const { profileReviewRow } = require("../utils/profileReview");

function receiptToken(submission) { return tokenFor("submission-receipt", submission._id, submission.clientRequestId); }
function submittedResponse(res, submission) {
  return response.success({ res, statusCode: 202, message: "รับข้อมูลแล้ว รอเจ้าหน้าที่ตรวจสอบ", data: {
    submissionId: submission._id, recordIds: submission.records.map(record => record._id), reviewStatus: submission.profileOnly ? submission.profileReviewStatus : "pending",
    submittedAt: submission.submittedAt, ...(submission.profileOnly ? { profileOnly: true } : {}),
    reviewDueAt: submission.reviewDueAt, receiptToken: receiptToken(submission), clientRequestId: submission.clientRequestId
  } });
}

exports.submit = async (req, res) => {
  try {
    const { citizenId, records, profile: input = {} } = req.body || {};
    const agreements = validateAgreements(req.body?.agreements, "guest-consent");
    const clientRequestId = req.body?.clientRequestId || crypto.randomUUID();
    if (typeof citizenId !== "string" || !/^\d{13}$/.test(citizenId) || typeof clientRequestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientRequestId) ||
        !Array.isArray(records) || records.length > 4 || !input || typeof input !== "object" || Array.isArray(input)) {
      return response.error({ res, statusCode: 400, message: "กรุณาตรวจสอบเลขบัตรและข้อมูลสุขภาพไม่เกิน 4 หมวด" });
    }
    const profile = pickProfile(input);
    if (Object.values(profile).some(value => typeof value === "string" && value.length > 1000) ||
        (profile.chronicDiseases && (profile.chronicDiseases.length > 30 || profile.chronicDiseases.some(value => value.length > 200)))) {
      return response.error({ res, statusCode: 400, message: "ข้อมูลส่วนตัวมีความยาวเกินกำหนด" });
    }
    const normalized = records.map(normalizeHealthRecord);
    if (new Set(normalized.map(record => record.type)).size !== normalized.length) return response.error({ res, statusCode: 400, message: "เลือกแต่ละหมวดสุขภาพได้ครั้งเดียวต่อชุดข้อมูล" });
    const requestKeyHash = hashToken(clientRequestId);
    const payloadHash = hashToken(JSON.stringify({ citizenId, profile, records: normalized, agreements }));
    const previous = await Submission.findOne({ requestKeyHash }).select("+payloadHash");
    if (previous) {
      if (previous.payloadHash !== payloadHash) return response.error({ res, statusCode: 409, message: "ชุดข้อมูลนี้ถูกส่งแล้ว หากแก้ไขข้อมูลให้เริ่มรายการใหม่" });
      try { await materializeSubmission(previous); } catch {}
      try { await prepareNotifications(previous); } catch {}
      return submittedResponse(res, previous);
    }
    const legalAgreement = agreementProof(agreements, "guest-consent");
    let user;
    try {
      user = await User.findOneAndUpdate({ citizenId }, { $setOnInsert: {
        ...profile, citizenId, status: "pending", isVerified: false, accountEnabled: false,
        legalAgreement, legalAgreementHistory: [legalAgreement],
        thaiCvRisk: calculateThaiCvRisk(profile)
      } }, { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true });
    } catch (error) {
      if (error.code !== 11000) throw error;
      user = await User.findOne({ citizenId });
    }
    const userKey = await ids.ensureInternalId(User, user);
    const submittedAt = new Date(), id = new mongoose.Types.ObjectId();
    const recordKeys = normalized.length ? await ids.allocateInternalIds("Health", normalized.length) : [];
    const data = { _id: id, internalId: await ids.allocateInternalId("Submission"), userId: user._id, userKey, citizenId, profile, legalAgreement,
      records: normalized.map((record, index) => ({ ...record, _id: new mongoose.Types.ObjectId(), internalId: recordKeys[index] })),
      ...(normalized.length === 0 ? { profileOnly: true, profileReviewStatus: "pending", profileMaterializedAt: submittedAt,
        profileReviewHistory: [{ at: submittedAt, status: "pending", from: null, to: "pending", source: "guest", reason: "ส่งข้อมูลส่วนตัวโดยไม่ระบุผลตรวจสุขภาพ" }] } : {}),
      clientRequestId, requestKeyHash, payloadHash,
      receiptHash: hashToken(tokenFor("submission-receipt", id, clientRequestId)),
      submittedAt, reviewDueAt: reviewDeadline(submittedAt), receiptExpiresAt: new Date(submittedAt.getTime() + 30 * 86400000) };
    let submission;
    try { submission = await Submission.create(data); }
    catch (error) {
      if (error.code !== 11000) throw error;
      submission = await Submission.findOne({ requestKeyHash }).select("+payloadHash");
      if (!submission || submission.payloadHash !== payloadHash) return response.error({ res, statusCode: 409, message: "ชุดข้อมูลซ้ำกับรายการที่ส่งแล้ว" });
    }
    // Submission is the durable recovery source if a record/outbox write fails.
    try { await materializeSubmission(submission); } catch {}
    try { await prepareNotifications(submission); } catch {}
    return submittedResponse(res, submission);
  } catch (error) {
    if (sendAgreementError(error, res)) return;
    return response.error({ res, statusCode: 400, message: /[\u0E00-\u0E7F]/.test(error.message) ? error.message : "ยังรับข้อมูลไม่สำเร็จ กรุณาลองอีกครั้งด้วยชุดข้อมูลเดิม" });
  }
};

exports.receipt = async (req, res) => {
  try {
    const token = req.query.token;
    if (!mongoose.isValidObjectId(req.params.id) || typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return response.error({ res, statusCode: 404, message: "ไม่พบใบรับข้อมูลหรือลิงก์หมดอายุ" });
    let submission = await Submission.findOne({ _id: req.params.id, receiptHash: hashToken(token), receiptExpiresAt: { $gt: new Date() } });
    if (!submission) return response.error({ res, statusCode: 404, message: "ไม่พบใบรับข้อมูลหรือลิงก์หมดอายุ" });
    await approveOverdue();
    if (submission.profileOnly) submission = await Submission.findOne(require("../utils/review").reviewDocumentFilter(submission)) || submission;
    const records = await Health.find(submissionRecordsFilter(submission)).sort({ createdAt: 1, _id: 1 });
    return response.success({ res, data: { submissionId: submission._id, reviewDueAt: submission.reviewDueAt,
      submittedAt: submission.submittedAt, recordCount: submission.records.length,
      processing: !submission.materialized, records: records.map(safeReviewRecord),
      ...(submission.profileOnly ? { profileOnly: true, profileReview: profileReviewRow(submission),
        profileReviewStatus: submission.profileReviewStatus, profileReviewHistory: submission.profileReviewHistory || [] } : {}) } });
  } catch { return response.error({ res, message: "โหลดใบรับข้อมูลไม่สำเร็จ" }); }
};
