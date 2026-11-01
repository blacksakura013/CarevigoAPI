const mongoose = require("mongoose");
const Health = require("../models/Health");
const Admin = require("../models/Admin");
const Submission = require("../models/Submission");
const Outbox = require("../models/ReviewOutbox");
const ids = require("../services/internalIds.service");
const response = require("../utils/response");
const { getPagination } = require("../utils/pagination");
const { reviewFilter, hashToken, safeReviewRecord, reviewDocumentFilter, submissionRecordsFilter } = require("../utils/review");
const { approveOverdue, decidePending, decidePendingProfiles } = require("../services/review.service");
const { profileReviewFilter, profileReviewRow } = require("../utils/profileReview");
const { pickProfile } = require("../utils/patientProfile");

const ownerPopulation = query => query.populate({ path: "userId", select: "internalId firstName lastName citizenId province phone" })
  .populate({ path: "userByKey", select: "internalId firstName lastName citizenId province phone" });

function queueRecord(row) {
  const value = row.toObject ? row.toObject() : { ...row };
  const numeric = row.userByKey, legacy = row.userId;
  const user = value.userKey === undefined ? legacy : numeric || null;
  if (user && !user.toHexString) {
    value.userId = Object.fromEntries(["_id", "firstName", "lastName", "citizenId", "province", "phone"].filter(key => user[key] !== undefined).map(key => [key, user[key]]));
  } else value.userId = user || null;
  delete value.userByKey; delete value.submissionByKey;
  return value;
}

exports.list = async (req, res) => {
  try {
    await approveOverdue();
    const { page, limit, skip } = getPagination(req.query);
    const snapshot = req.query.cutoff || new Date().toISOString();
    const filter = reviewFilter(req.query, snapshot);
    const profileFilter = profileReviewFilter(req.query, snapshot);
    const [healthTotal, profileTotal] = await Promise.all([
      Health.countDocuments(filter), Submission.countDocuments(profileFilter),
    ]);
    const total = healthTotal + profileTotal;
    let records;
    if (!profileTotal) {
      records = (await ownerPopulation(Health.find(filter)).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit)).map(queueRecord);
    } else if (skip >= total) records = [];
    else {
      // Let MongoDB merge and paginate the two review entities, then populate
      // only this page. Large page numbers never load all preceding records.
      const pageRows = await Health.aggregate([
        { $match: filter }, { $project: { _id: 1, createdAt: 1, entity: { $literal: "health" } } },
        { $unionWith: { coll: Submission.collection.name, pipeline: [
          { $match: profileFilter }, { $project: { _id: 1, createdAt: "$submittedAt", entity: { $literal: "profile" } } },
        ] } }, { $sort: { createdAt: -1, _id: -1 } }, { $skip: skip }, { $limit: limit },
      ]);
      const [healthRows, profiles] = await Promise.all([
        ownerPopulation(Health.find({ _id: { $in: pageRows.filter(row => row.entity === "health").map(row => row._id) } })),
        ownerPopulation(Submission.find({ profileOnly: true, _id: { $in: pageRows.filter(row => row.entity === "profile").map(row => row._id) } })),
      ]);
      const rows = new Map([
        ...healthRows.map(row => [`health:${row._id}`, queueRecord(row)]),
        ...profiles.map(row => [`profile:${row._id}`, queueRecord(profileReviewRow(row, { privateFields: true }))]),
      ]);
      records = pageRows.map(row => rows.get(`${row.entity}:${row._id}`)).filter(Boolean);
    }
    return res.json({ statusCode: 200, title: "Success", message: "Review queue", data: records, total, page, limit, hasMore: page * limit < total, snapshotAt: new Date(snapshot).toISOString() });
  } catch (error) { return response.error({ res, statusCode: 400, message: /[\u0E00-\u0E7F]/.test(error.message) ? error.message : "โหลดรายการตรวจสอบไม่สำเร็จ" }); }
};

exports.decision = async (req, res) => {
  try {
    await approveOverdue();
    const { ids, all, filters = {}, cutoff, action, reason = "" } = req.body || {};
    if (!["approve", "reject"].includes(action) || typeof reason !== "string" || reason.length > 500) return response.error({ res, statusCode: 400, message: "กรุณาระบุผลการตรวจสอบให้ถูกต้อง" });
    let filter, profileFilter, expected;
    if (all === true) {
      const cutoffDate = new Date(cutoff);
      if (!cutoff || !Number.isFinite(cutoffDate.getTime()) || cutoffDate.getTime() > Date.now() + 1000 || filters.status !== "pending") return response.error({ res, statusCode: 400, message: "กรุณายืนยันรายการรอตรวจสอบพร้อมเวลาของชุดข้อมูล" });
      filter = reviewFilter(filters, cutoff);
      profileFilter = profileReviewFilter(filters, cutoff);
      const counts = await Promise.all([Health.countDocuments(filter), Submission.countDocuments(profileFilter)]);
      expected = counts[0] + counts[1];
    } else {
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== "string" || !mongoose.isValidObjectId(id))) return response.error({ res, statusCode: 400, message: "เลือกรายการที่ต้องการตรวจสอบ 1–100 รายการ" });
      const unique = [...new Set(ids)];
      const [records, profiles] = await Promise.all([
        Health.find({ _id: { $in: unique } }).select("_id internalId"),
        Submission.find({ profileOnly: true, _id: { $in: unique } }).select("_id internalId"),
      ]);
      filter = records.length ? { $or: records.map(reviewDocumentFilter) } : { _id: { $in: [] } }; expected = unique.length;
      profileFilter = profiles.length ? { $or: profiles.map(reviewDocumentFilter) } : { _id: { $in: [] } };
    }
    const decision = { action, source: "admin", actorId: req.user.id, actorKey: req.user.internalId,
      reason: reason.trim() || (action === "approve" ? "เจ้าหน้าที่อนุมัติ" : "เจ้าหน้าที่ยกเลิกรายการ") };
    const changed = await decidePending(filter, decision) + await decidePendingProfiles(profileFilter, decision);
    return response.success({ res, data: { changed, skipped: Math.max(0, expected - changed), matched: expected } });
  } catch { return response.error({ res, message: "บันทึกผลตรวจสอบไม่สำเร็จ กรุณาโหลดสถานะล่าสุดก่อนลองอีกครั้ง" }); }
};

exports.settings = async (req, res) => {
  try {
    await approveOverdue();
    const [activeAdminRecipients, pending, approved, rejected, jobs, profilePending, profileApproved, profileRejected] = await Promise.all([
      Admin.countDocuments({ isActive: true, email: { $nin: [null, ""] } }),
      Health.countDocuments({ reviewStatus: "pending" }),
      Health.countDocuments({ $or: [{ reviewStatus: "approved" }, { reviewStatus: { $exists: false } }] }),
      Health.countDocuments({ reviewStatus: "rejected" }),
      Outbox.aggregate([{ $group: { _id: "$status", total: { $sum: 1 } } }]),
      ...["pending", "approved", "rejected"].map(profileReviewStatus => Submission.countDocuments({ profileOnly: true, profileReviewStatus })),
    ]);
    const outbox = { pending: 0, sent: 0, failed: 0, expired: 0 };
    for (const job of jobs) outbox[job._id === "sending" ? "pending" : job._id] = (outbox[job._id === "sending" ? "pending" : job._id] || 0) + job.total;
    return response.success({ res, data: { timezone: "Asia/Bangkok", autoApprovalTime: "23:59", policy: "same-day", activeAdminRecipients, outbox,
      counts: { pending: pending + profilePending, approved: approved + profileApproved, rejected: rejected + profileRejected } } });
  } catch { return response.error({ res, message: "โหลดการตั้งค่าตรวจสอบไม่สำเร็จ" }); }
};

async function emailScope(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const job = await Outbox.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } });
  if (!job) return null;
  const admin = await Admin.findOne({ $and: [ids.identityFilter({ key: job.adminKey, legacyId: job.adminId }), { isActive: true }] });
  if (!admin) return null;
  const submission = await Submission.findOne(ids.identityFilter({ key: job.submissionKey, legacyId: job.submissionId }));
  return submission ? { job, submission, admin } : null;
}
exports.emailInfo = async (req, res) => {
  try {
    const scope = await emailScope(req.query.token);
    if (!scope) return response.error({ res, statusCode: 410, message: "ลิงก์ไม่ถูกต้อง หมดอายุ หรือไม่มีสิทธิ์แล้ว" });
    // GET only reads. Mail scanners cannot approve/reject by opening a URL.
    const rows = await Health.find(submissionRecordsFilter(scope.submission)).sort({ createdAt: 1, _id: 1 });
    const id = scope.submission.citizenId;
    return response.success({ res, data: { submissionId: scope.submission._id,
      patientName: [scope.submission.profile.firstName, scope.submission.profile.lastName].filter(Boolean).join(" "),
      maskedCitizenId: `${id.slice(0, 1)}********${id.slice(-4)}`, reviewDueAt: scope.submission.reviewDueAt,
      records: scope.submission.profileOnly ? [{ ...profileReviewRow(scope.submission), submittedProfile: pickProfile(scope.submission.profile) }] : rows.map(safeReviewRecord),
      ...(scope.submission.profileOnly ? { profileOnly: true, recordCount: 0 } : {}),
      canDecide: scope.submission.profileOnly ? scope.submission.profileReviewStatus === "pending" : rows.some(row => row.reviewStatus === "pending"), expiresAt: scope.job.expiresAt } });
  } catch { return response.error({ res, message: "โหลดรายการยืนยันไม่สำเร็จ" }); }
};
exports.emailDecision = async (req, res) => {
  try {
    const { token, action } = req.body || {};
    if (!["approve", "reject"].includes(action)) return response.error({ res, statusCode: 400, message: "เลือกอนุมัติหรือยกเลิกรายการ" });
    const scope = await emailScope(token);
    if (!scope) return response.error({ res, statusCode: 410, message: "ลิงก์ไม่ถูกต้อง หมดอายุ หรือไม่มีสิทธิ์แล้ว" });
    await approveOverdue();
    const filter = submissionRecordsFilter(scope.submission);
    const matched = scope.submission.profileOnly ? 1 : await Health.countDocuments(filter);
    const decision = { action, source: "email", actorId: scope.admin._id, actorKey: ids.getInternalId(scope.admin),
      reason: action === "approve" ? "อนุมัติผ่านลิงก์อีเมลและกดยืนยัน" : "ยกเลิกผ่านลิงก์อีเมลและกดยืนยัน" };
    const changed = scope.submission.profileOnly
      ? await decidePendingProfiles(reviewDocumentFilter(scope.submission), decision) : await decidePending(filter, decision);
    return response.success({ res, data: { submissionId: scope.submission._id, changed, skipped: matched - changed } });
  } catch { return response.error({ res, message: "ยืนยันรายการไม่สำเร็จ กรุณาโหลดสถานะล่าสุด" }); }
};
