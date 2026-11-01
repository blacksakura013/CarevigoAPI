const User = require("../models/User");
const Health = require("../models/Health");
const response = require("../utils/response");
const { documentFilter, healthForUser } = require("../utils/internalQueries");
const { healthProgressQuery, TYPES } = require("../utils/healthProgressQuery");

const SERIES_LIMIT = 100;
const METRICS = {
  systolic: ["blood_pressure", "$value.systolic"], diastolic: ["blood_pressure", "$value.diastolic"], pulse: ["blood_pressure", "$value.pulse"],
  fbs: ["sugar", "$value.fbs"], hba1c: ["sugar", "$value.hba1c"],
  total: ["cholesterol", "$value.total"], ldl: ["cholesterol", "$value.ldl"], hdl: ["cholesterol", "$value.hdl"], triglyceride: ["cholesterol", "$value.triglyceride"],
  weight: ["bmi", { $ifNull: ["$weight", "$value.weight"] }], height: ["bmi", { $ifNull: ["$height", "$value.height"] }], bmi: ["bmi", "$bmi"],
};
const valueFields = Object.keys(METRICS).filter(key => key !== "bmi");
const validNumber = value => ({ $and: [
  { $in: [{ $type: value }, ["double", "int"]] }, { $gt: [value, 0] }, { $lte: [value, Number.MAX_VALUE] },
] });
const projectedNumber = value => ({ $cond: [validNumber(value), value, "$$REMOVE"] });
const reviewStatus = { $switch: { branches: [
  { case: { $eq: [{ $type: "$reviewStatus" }, "missing"] }, then: "approved" },
  { case: { $in: ["$reviewStatus", ["approved", "pending", "rejected"]] }, then: "$reviewStatus" },
], default: "unknown" } };
const recordProjection = {
  _id: 1, internalId: 1, userKey: 1, type: 1,
  value: Object.fromEntries(valueFields.map(key => [key, projectedNumber(`$value.${key}`)])),
  weight: projectedNumber("$weight"), height: projectedNumber("$height"), bmi: projectedNumber("$bmi"),
  cvdRisk: { level: "$cvdRisk.level", label: "$cvdRisk.label" }, thaiCvRisk: 1,
  recordedAt: "$_progressRecordedAt", createdAt: 1, submittedAt: 1,
  submittedProfile: { birthDate: "$submittedProfile.birthDate", gender: "$submittedProfile.gender" },
  reviewStatus: "$_progressReviewStatus", reviewReason: 1, reviewDueAt: 1, reviewedAt: 1, reviewSource: 1, source: 1,
  reviewHistory: { $map: { input: { $cond: [{ $isArray: "$reviewHistory" }, "$reviewHistory", []] }, as: "entry", in: {
    at: "$$entry.at", status: "$$entry.status", from: "$$entry.from", to: "$$entry.to", source: "$$entry.source", reason: "$$entry.reason",
  } } },
};

function safeRisk(risk) {
  if (!risk || typeof risk !== "object") return null;
  const result = {};
  for (const key of ["status", "level", "label", "reason", "model", "source", "sourceVersion", "displayScore"])
    if (typeof risk[key] === "string") result[key] = risk[key];
  result.score = typeof risk.score === "number" && Number.isFinite(risk.score) ? risk.score : null;
  if (Array.isArray(risk.missing)) result.missing = risk.missing.filter(key => typeof key === "string");
  if (risk.calculatedAt instanceof Date && Number.isFinite(risk.calculatedAt.getTime())) result.calculatedAt = risk.calculatedAt;
  if (risk.inputs && typeof risk.inputs === "object") {
    result.inputs = {};
    for (const key of ["age", "sex", "smokingStatus", "currentSmoker", "diabetes", "systolic", "totalCholesterol", "bloodPressureRecordedAt", "cholesterolRecordedAt", "profileSource"]) {
      const value = risk.inputs[key];
      if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || value instanceof Date)
        result.inputs[key] = value;
    }
  }
  return result;
}
function safeRecord(record) {
  const result = { ...record };
  if (result.thaiCvRisk) result.thaiCvRisk = safeRisk(result.thaiCvRisk);
  return result;
}

function progressPipeline(user, query) {
  const period = { $type: "date", $lt: query.end, $lte: query.asOf, ...(query.start ? { $gte: query.start } : {}) };
  const detail = query.reviewStatus === "all" ? [] : [{ $match: { _progressReviewStatus: query.reviewStatus } }];
  const facets = {
    summary: [{ $group: { _id: null, total: { $sum: 1 },
      ...Object.fromEntries(["approved", "pending", "rejected", "unknown"].map(status => [status, { $sum: { $cond: [{ $eq: ["$_progressReviewStatus", status] }, 1, 0] } }])),
      firstRecordedAt: { $min: "$_progressRecordedAt" }, lastRecordedAt: { $max: "$_progressRecordedAt" },
    } }],
    byType: [{ $group: { _id: { $cond: [{ $in: ["$type", TYPES] }, "$type", "unknown"] }, total: { $sum: 1 } } }],
    records: [...detail, { $skip: query.skip }, { $limit: query.limit }, { $project: recordProjection }],
    detailTotal: [...detail, { $count: "total" }],
    latestApprovedRecords: [
      { $match: { _progressReviewStatus: "approved", type: { $in: TYPES } } },
      { $group: { _id: "$type", record: { $first: "$$ROOT" } } }, { $replaceRoot: { newRoot: "$record" } },
      { $project: recordProjection }, { $sort: { type: 1 } },
    ],
  };
  for (const [key, [type, value]] of Object.entries(METRICS)) {
    const match = { $match: { type, _progressReviewStatus: "approved", $expr: validNumber(value) } };
    const sample = { value, recordedAt: "$_progressRecordedAt", recordId: { $toString: "$_id" } };
    facets[`${key}Stats`] = [match, { $group: { _id: null, total: { $sum: 1 }, first: { $last: sample } } }];
    facets[`${key}Series`] = [match, { $limit: SERIES_LIMIT }, { $project: { _id: 0, ...sample } }];
  }
  return [
    { $match: healthForUser(user) },
    { $set: { _progressRecordedAt: { $ifNull: ["$submittedAt", "$createdAt"] }, _progressReviewStatus: reviewStatus } },
    { $match: { _progressRecordedAt: period } },
    // Sorting once keeps every metric's latest100 bounded without collecting
    // an unbounded history array or guessing progress from the detail page.
    { $sort: { _progressRecordedAt: -1, _id: -1 } }, { $facet: facets },
  ];
}

exports.getProgress = async (req, res) => {
  try {
    const query = healthProgressQuery(req.query);
    const user = await User.findOne(req.patient ? documentFilter(req.patient) : { citizenId: query.citizenId })
      .select("internalId citizenId firstName lastName birthDate gender thaiCvRisk").lean();
    if (!user) return response.error({ res, statusCode: 404, message: "ไม่พบข้อมูลผู้รับบริการ" });
    const [result = {}] = await Health.aggregate(progressPipeline(user, query)).option({ useBigInt64: true }).allowDiskUse(true);
    const summary = { total: 0, approved: 0, pending: 0, rejected: 0, unknown: 0, firstRecordedAt: null, lastRecordedAt: null };
    const { _id, ...stats } = result.summary?.[0] || {};
    Object.assign(summary, stats);
    summary.byType = Object.fromEntries([...TYPES, "unknown"].map(type => [type, 0]));
    for (const group of result.byType || []) if (Object.hasOwn(summary.byType, group._id)) summary.byType[group._id] = group.total;
    const metrics = {};
    for (const key of Object.keys(METRICS)) {
      const metric = result[`${key}Stats`]?.[0], descending = result[`${key}Series`] || [];
      metrics[key] = { total: metric?.total || 0, first: metric?.first || null,
        previous: descending[1] || null, latest: descending[0] || null,
        series: [...descending].reverse(), seriesLimit: SERIES_LIMIT, hasEarlier: (metric?.total || 0) > descending.length };
    }
    const total = result.detailTotal?.[0]?.total || 0;
    return response.success({ res, message: "โหลดข้อมูลติดตามสุขภาพสำเร็จ", total, page: query.page, limit: query.limit,
      data: {
        schemaVersion: 1,
        patient: Object.fromEntries(["citizenId", "firstName", "lastName", "birthDate", "gender"].map(key => [key, user[key] || ""])),
        range: query.range, summary, metrics,
        summaryScope: "all-statuses-in-range", metricsScope: "approved-in-range",
        latestApprovedRecords: (result.latestApprovedRecords || []).map(safeRecord),
        records: (result.records || []).map(safeRecord),
        pagination: { page: query.page, limit: query.limit, total, hasMore: query.page * query.limit < total, reviewStatus: query.reviewStatus },
        currentRisk: safeRisk(user.thaiCvRisk),
      },
    });
  } catch (error) {
    return response.error({ res, statusCode: error.code === "INVALID_PROGRESS_QUERY" ? 400 : 500,
      message: error.code === "INVALID_PROGRESS_QUERY" ? error.message : "โหลดข้อมูลติดตามสุขภาพไม่สำเร็จ กรุณาลองอีกครั้ง" });
  }
};
