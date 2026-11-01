const crypto = require("node:crypto");
const { calculateBMI, calculateCVDRisk } = require("./health");
const ids = require("../services/internalIds.service");
const APPROVED_FILTER = { $or: [{ reviewStatus: "approved" }, { reviewStatus: { $exists: false } }] };
const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");
const tokenFor = (purpose, ...parts) => {
  if (!process.env.JWT_SECRET) throw new Error("Token signing is not configured");
  return crypto.createHmac("sha256", process.env.JWT_SECRET).update([purpose, ...parts.map(String)].join(":" )).digest("base64url");
};
function reviewDeadline(now = new Date()) {
  // Bangkok is UTC+7 all year. 23:59 Bangkok is 16:59 UTC on that calendar day.
  const bangkok = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return new Date(Date.UTC(bangkok.getUTCFullYear(), bangkok.getUTCMonth(), bangkok.getUTCDate(), 16, 59));
}
function normalizeHealthRecord(record) {
  if (!record || typeof record !== "object" || !["blood_pressure", "sugar", "cholesterol", "bmi"].includes(record.type)) throw new Error("ประเภทข้อมูลสุขภาพไม่ถูกต้อง");
  const fields = { blood_pressure: ["systolic", "diastolic", "pulse"], sugar: ["fbs", "hba1c"], cholesterol: ["total", "ldl", "hdl", "triglyceride"], bmi: ["weight", "height"] }[record.type];
  if (!record.value || typeof record.value !== "object" || Array.isArray(record.value)) throw new Error("กรุณาระบุค่าผลตรวจ");
  const value = {};
  for (const [key, item] of Object.entries(record.value)) {
    if (item === "" || item === null || item === undefined) continue;
    if (!fields.includes(key) || !["number", "string"].includes(typeof item) || !Number.isFinite(Number(item)) || Number(item) <= 0 || Number(item) > 100000) throw new Error("ค่าผลตรวจต้องเป็นตัวเลขมากกว่า 0 และอยู่ในช่วงที่บันทึกได้");
    value[key] = Number(item);
  }
  const required = record.type === "blood_pressure" ? ["systolic", "diastolic"] : record.type === "cholesterol" ? ["total"] : [];
  if (required.some(key => !value[key]) || (record.type === "sugar" && !Object.keys(value).length)) throw new Error("กรุณากรอกข้อมูลที่จำเป็นในหมวดที่เลือก");
  const normalized = { type: record.type, value };
  for (const key of ["weight", "height"]) {
    const raw = record[key] ?? (record.type === "bmi" ? value[key] : undefined);
    if (raw === undefined) continue;
    if (!["number", "string"].includes(typeof raw) || !Number.isFinite(Number(raw)) || Number(raw) <= 0 || Number(raw) > 1000) throw new Error("น้ำหนักหรือส่วนสูงไม่ถูกต้อง");
    normalized[key] = Number(raw);
  }
  if (record.type === "bmi" && (!normalized.weight || !normalized.height)) throw new Error("กรุณากรอกน้ำหนักและส่วนสูงให้ครบ");
  if (normalized.weight && normalized.height) {
    normalized.bmi = calculateBMI(normalized.weight, normalized.height);
    normalized.cvdRisk = calculateCVDRisk(normalized.bmi);
  }
  return normalized;
}
function reviewFilter(filters = {}, cutoff) {
  const status = filters.status || "pending";
  if (!["pending", "approved", "rejected", "all"].includes(status) || (filters.search !== undefined && typeof filters.search !== "string")) throw new Error("ตัวกรองรายการไม่ถูกต้อง");
  const filter = {};
  if (status === "approved") Object.assign(filter, APPROVED_FILTER);
  else if (status !== "all") filter.reviewStatus = status;
  if (cutoff) {
    const date = new Date(cutoff);
    if (!Number.isFinite(date.getTime())) throw new Error("เวลาของรายการยืนยันไม่ถูกต้อง");
    filter.$and = [...(filter.$and || []), { $or: [
      { materializedAt: { $lte: date } },
      { $and: [{ materializedAt: { $exists: false } }, { createdAt: { $lte: date } }] }
    ] }];
  }
  if (filters.search?.trim()) {
    const regex = filters.search.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const search = { $or: ["citizenId", "submittedProfile.firstName", "submittedProfile.lastName", "submittedProfile.phone", "submittedProfile.province"].map(key => ({ [key]: { $regex: regex, $options: "i" } })) };
    filter.$and = [...(filter.$and || []), search];
  }
  return filter;
}
function safeReviewRecord(record) {
  const value = record.toObject ? record.toObject() : { ...record };
  return { _id: value._id, type: value.type, value: value.value, weight: value.weight, height: value.height,
    bmi: value.bmi, thaiCvRisk: value.thaiCvRisk, reviewStatus: value.reviewStatus || "approved",
    reviewHistory: value.reviewHistory || [], submittedAt: value.submittedAt || value.createdAt,
    reviewDueAt: value.reviewDueAt, reviewedAt: value.reviewedAt, reviewSource: value.reviewSource, reviewReason: value.reviewReason };
}
function reviewDocumentFilter(document) {
  return ids.identityFilter({ key: ids.getInternalId(document), legacyId: document._id });
}
function submissionRecordsFilter(submission) {
  return ids.relationFilter({ keyField: "submissionKey", key: ids.getInternalId(submission), legacyField: "submissionId", legacyId: submission._id });
}
module.exports = { APPROVED_FILTER, hashToken, tokenFor, reviewDeadline, normalizeHealthRecord, reviewFilter, safeReviewRecord,
  reviewDocumentFilter, submissionRecordsFilter };
