const KEYS = new Set(["page", "limit", "type", "search", "reviewStatus", "riskLevel", "bmiLevel", "sort"]);
const TYPES = ["all", "blood_pressure", "sugar", "cholesterol", "bmi"];
const BMI_LEVELS = ["all", "underweight", "normal", "risk_low", "risk_medium", "risk_high"];

function invalid() {
  const error = new Error("ตัวกรองหรือเลขหน้ารายการสุขภาพไม่ถูกต้อง");
  error.code = "INVALID_DASHBOARD_QUERY";
  throw error;
}
function integer(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return invalid();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) return invalid();
  return result;
}
function choice(value, allowed, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) return invalid();
  return value;
}

const validRisk = {
  "thaiCvRisk.status": "calculated",
  // BSON Long/Decimal128 do not cross the JSON boundary as Number values.
  // Do not coerce them: decimal rounding could change a clinical threshold.
  "thaiCvRisk.score": { $type: ["double", "int"], $gte: 0, $lte: 100 },
};
const validRiskExpression = { $and: [
  { $eq: ["$thaiCvRisk.status", "calculated"] },
  { $in: [{ $type: "$thaiCvRisk.score" }, ["double", "int"]] },
  { $gte: ["$thaiCvRisk.score", 0] },
  { $lte: ["$thaiCvRisk.score", 100] },
] };

function dashboardHealthQuery(query = {}) {
  if (!query || typeof query !== "object" || Array.isArray(query) || Object.keys(query).some(key => !KEYS.has(key))) return invalid();
  const page = integer(query.page, 1), limit = integer(query.limit, 10, 100);
  const skip = (page - 1) * limit;
  if (!Number.isSafeInteger(skip)) return invalid();
  const type = choice(query.type, TYPES, "all");
  const reviewStatus = choice(query.reviewStatus, ["all", "pending", "approved", "rejected"], "all");
  const riskLevel = choice(query.riskLevel, ["all", "low", "moderate", "high", "unavailable"], "all");
  const bmiLevel = choice(query.bmiLevel, BMI_LEVELS, "all");
  const sort = choice(query.sort, ["newest", "oldest", "name", "risk_desc", "risk_asc"], "newest");
  if (query.search !== undefined && (typeof query.search !== "string" || query.search.length > 100)) return invalid();
  const search = (query.search || "").trim();
  const regex = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filters = [];
  if (type !== "all") filters.push({ type });
  if (reviewStatus === "approved") filters.push({ $or: [{ reviewStatus: "approved" }, { reviewStatus: { $exists: false } }] });
  else if (reviewStatus !== "all") filters.push({ reviewStatus });
  if (bmiLevel !== "all") filters.push({ "cvdRisk.level": bmiLevel });
  if (riskLevel === "unavailable") filters.push({ $nor: [validRisk] });
  else if (riskLevel !== "all") {
    const range = riskLevel === "low" ? { $lt: 10 } : riskLevel === "moderate" ? { $gte: 10, $lte: 20 } : { $gt: 20 };
    filters.push(validRisk, { "thaiCvRisk.score": range });
  }
  return { page, limit, skip, sort, regex, filter: filters.length ? { $and: filters } : {} };
}

function dashboardHealthPipeline(query, userCollection) {
  const join = [
    { $lookup: { from: userCollection, let: { userKey: "$userKey", userId: "$userId" }, pipeline: [
      { $match: { $expr: { $or: [
        { $and: [{ $gt: ["$$userKey", 0] }, { $eq: ["$internalId", "$$userKey"] }] },
        { $and: [{ $eq: [{ $type: "$$userKey" }, "missing"] }, { $eq: ["$_id", "$$userId"] }] },
      ] } } },
      { $project: { internalId: 1, firstName: 1, lastName: 1, phone: 1, province: 1, gender: 1, birthDate: 1, citizenId: 1 } },
    ], as: "_dashboardUser" } },
    { $set: { user: { $ifNull: [{ $arrayElemAt: ["$_dashboardUser", 0] }, null] } } },
  ];
  const fullName = { $trim: { input: { $concat: [{ $ifNull: ["$user.firstName", ""] }, " ", { $ifNull: ["$user.lastName", ""] }] } } };
  const beforePage = [{ $match: query.filter }];
  const joinBeforePage = Boolean(query.regex) || query.sort === "name";
  if (joinBeforePage) beforePage.push(...join, { $set: { _fullName: fullName } });
  if (query.regex) beforePage.push({ $match: { $or: [
    ...["user.firstName", "user.lastName", "user.citizenId", "user.province", "_fullName"].map(field => ({ [field]: { $regex: query.regex, $options: "i" } })),
  ] } });

  let sort = query.sort === "oldest" ? { createdAt: 1, _id: 1 } : { createdAt: -1, _id: -1 };
  const rows = [];
  if (query.sort === "name") sort = { _fullName: 1, createdAt: -1, _id: -1 };
  if (["risk_desc", "risk_asc"].includes(query.sort)) {
    rows.push({ $set: { _riskMissing: { $cond: [validRiskExpression, 0, 1] },
      _riskScore: { $cond: [validRiskExpression, "$thaiCvRisk.score", null] } } });
    sort = { _riskMissing: 1, _riskScore: query.sort === "risk_desc" ? -1 : 1, createdAt: -1, _id: -1 };
  }
  rows.push({ $sort: sort }, { $skip: query.skip }, { $limit: query.limit });
  // A normal page needs only its own user joins. Search/name order must join
  // before pagination so matching and totals cover the whole result set.
  if (!joinBeforePage) rows.push(...join);
  rows.push({ $project: { _id: 1, type: 1, value: 1, bmi: 1, cvdRisk: 1, thaiCvRisk: 1,
    reviewStatus: { $ifNull: ["$reviewStatus", "approved"] }, reviewHistory: { $ifNull: ["$reviewHistory", []] },
    submittedProfile: 1, submittedAt: 1, reviewDueAt: 1, reviewedAt: 1, reviewSource: 1, reviewReason: 1,
    source: 1, createdAt: 1, internalId: 1, userKey: 1, user: 1 } });
  return [...beforePage, { $facet: { total: [{ $count: "value" }], records: rows } }];
}

module.exports = { dashboardHealthQuery, dashboardHealthPipeline };
