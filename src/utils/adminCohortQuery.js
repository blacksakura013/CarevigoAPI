const DAY = 86400000, OFFSET = 7 * 3600000;
const TYPES = ["blood_pressure", "sugar", "cholesterol", "bmi", "unknown"];
const STATUSES = ["approved", "pending", "rejected", "unknown"];
const DISEASES = [
  { id: "diabetes", label: "เบาหวาน", aliases: ["diabetes", "diabetes mellitus", "dm", "เบาหวาน", "โรคเบาหวาน"] },
  { id: "hypertension", label: "ความดันโลหิตสูง", aliases: ["hypertension", "ht", "high blood pressure", "ความดัน", "ความดันสูง", "ความดันโลหิตสูง", "โรคความดันโลหิตสูง"] },
  { id: "heart", label: "โรคหัวใจ", aliases: ["heart", "heart disease", "cardiovascular disease", "หัวใจ", "โรคหัวใจ"] },
  { id: "stroke", label: "หลอดเลือดสมอง", aliases: ["stroke", "cva", "cerebrovascular disease", "หลอดเลือดสมอง", "โรคหลอดเลือดสมอง"] },
  { id: "cancer", label: "มะเร็ง", aliases: ["cancer", "มะเร็ง", "โรคมะเร็ง"] },
  { id: "dyslipidemia", label: "ไขมันในเลือดสูง", aliases: ["dyslipidemia", "hyperlipidemia", "cholesterol", "high cholesterol", "ไขมัน", "ไขมันสูง", "ไขมันในเลือด", "ไขมันในเลือดสูง", "ไขมันในเส้นเลือด"] },
  { id: "other", label: "โรคอื่น ๆ", aliases: [] },
  { id: "none", label: "ยืนยันว่าไม่มีโรคประจำตัว", aliases: [] },
  { id: "unknown", label: "ยังไม่ระบุโรคประจำตัว", aliases: [] },
];
const KEYS = new Set(["from", "to", "disease", "search", "activity", "page", "limit"]);
function invalid() {
  const error = new Error("ตัวกรองรายงานไม่ถูกต้อง กรุณาระบุช่วงวันที่ไม่เกิน 366 วัน และตรวจสอบเงื่อนไขการค้นหา");
  error.code = "INVALID_COHORT_QUERY";
  throw error;
}
function day(value) {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return invalid();
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return invalid();
  return new Date(date.getTime() - OFFSET);
}
function integer(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return invalid();
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : invalid();
}
function adminCohortQuery(query = {}, now = new Date()) {
  if (!query || typeof query !== "object" || Array.isArray(query) || Object.keys(query).some(key => !KEYS.has(key)) || Object.values(query).some(value => typeof value !== "string")) return invalid();
  const asOf = new Date(now), today = new Date(asOf.getTime() + OFFSET).toISOString().slice(0, 10);
  const from = query.from ?? `${today.slice(0, 7)}-01`, to = query.to ?? today;
  if ((query.from === undefined) !== (query.to === undefined)) return invalid();
  const start = day(from), end = new Date(day(to).getTime() + DAY), days = (end - start) / DAY;
  if (days < 1 || days > 366 || to > today) return invalid();
  const disease = query.disease ?? "all", activity = query.activity ?? "all", search = (query.search ?? "").trim();
  if (!["all", ...DISEASES.map(item => item.id)].includes(disease) || !["all", "recorded", "none"].includes(activity) || search.length > 100 || /[\u0000-\u001f\u007f]/.test(search)) return invalid();
  const page = integer(query.page, 1), limit = integer(query.limit, 20, 50), skip = (page - 1) * limit;
  if (!Number.isSafeInteger(skip)) return invalid();
  return { start, end, asOf, page, limit, skip, disease, activity, search,
    searchRegex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    range: { from, to, asOf: asOf.toISOString(), timeZone: "Asia/Bangkok", bucket: days <= 92 ? "day" : "month" } };
}
function emptyCounts() {
  return { total: 0, ...Object.fromEntries(STATUSES.map(status => [status, 0])), byType: Object.fromEntries(TYPES.map(type => [type, 0])) };
}
function buckets(range) {
  const result = [];
  if (range.bucket === "day") {
    for (let value = day(range.from); value < new Date(day(range.to).getTime() + DAY); value = new Date(value.getTime() + DAY))
      result.push(new Date(value.getTime() + OFFSET).toISOString().slice(0, 10));
  } else {
    const date = new Date(`${range.from.slice(0, 7)}-01T00:00:00.000Z`);
    while (date.toISOString().slice(0, 7) <= range.to.slice(0, 7)) {
      result.push(date.toISOString().slice(0, 7)); date.setUTCMonth(date.getUTCMonth() + 1);
    }
  }
  return result;
}
module.exports = { adminCohortQuery, emptyCounts, buckets, TYPES, STATUSES, DISEASES };
