const User = require("../models/User");
const Health = require("../models/Health");
const response = require("../utils/response");
const { adminCohortQuery, emptyCounts, buckets, TYPES, STATUSES, DISEASES } = require("../utils/adminCohortQuery");

const statusExpression = { $switch: { branches: [
  { case: { $eq: [{ $type: "$reviewStatus" }, "missing"] }, then: "approved" },
  { case: { $in: ["$reviewStatus", STATUSES.slice(0, 3)] }, then: "$reviewStatus" },
], default: "unknown" } };
const clinicalFields = ["systolic", "diastolic", "pulse", "fbs", "hba1c", "total", "ldl", "hdl", "triglyceride", "weight", "height"];
const numberProjection = value => ({ $cond: [{ $and: [
  { $in: [{ $type: value }, ["double", "int"]] }, { $gt: [value, 0] }, { $lte: [value, Number.MAX_VALUE] },
] }, value, "$$REMOVE"] });
const typedProjection = (value, type) => ({ $cond: [{ $eq: [{ $type: value }, type] }, value, "$$REMOVE"] });
const latestProjection = { _id: 0, type: 1, recordedAt: "$_cohortRecordedAt",
  value: Object.fromEntries(clinicalFields.map(key => [key, numberProjection(`$value.${key}`)])),
  weight: numberProjection("$weight"), height: numberProjection("$height"), bmi: numberProjection("$bmi"),
  createdAt: typedProjection("$createdAt", "date"), submittedAt: typedProjection("$submittedAt", "date"),
  submittedProfile: { birthDate: typedProjection("$submittedProfile.birthDate", "string"), gender: typedProjection("$submittedProfile.gender", "string") },
};
function recordGroup(id) {
  return { $group: { _id: id, total: { $sum: 1 },
    ...Object.fromEntries(STATUSES.map(status => [status, { $sum: { $cond: [{ $eq: ["$_cohortStatus", status] }, 1, 0] } }])),
    ...Object.fromEntries(TYPES.map(type => [`type_${type}`, { $sum: { $cond: [{ $eq: ["$_cohortType", type] }, 1, 0] } }])),
    firstRecordedAt: { $min: "$_cohortRecordedAt" }, lastRecordedAt: { $max: "$_cohortRecordedAt" },
  } };
}
function groupProjection() {
  return { $project: { _id: 0, date: "$_id", total: 1, ...Object.fromEntries(STATUSES.map(status => [status, 1])),
    byType: Object.fromEntries(TYPES.map(type => [type, `$type_${type}`])), firstRecordedAt: 1, lastRecordedAt: 1 } };
}
function diseaseExpression() {
  const reported = { $filter: { input: { $map: {
    input: { $cond: [{ $isArray: "$chronicDiseases" }, "$chronicDiseases", []] }, as: "disease",
    in: { $cond: [{ $eq: [{ $type: "$$disease" }, "string"] }, { $toLower: { $trim: { input: "$$disease" } } }, ""] },
  } }, as: "disease", cond: { $ne: ["$$disease", ""] } } };
  const classify = { $switch: { branches: DISEASES.slice(0, 6).map(disease => ({
    case: disease.id === "cancer" ? { $or: [{ $in: ["$$disease", disease.aliases] },
      { $regexMatch: { input: "$$disease", regex: "^(?:โรค)?มะเร็ง|^cancer(?:$|[ :\\-])" } }] } : { $in: ["$$disease", disease.aliases] }, then: disease.id,
  })), default: "other" } };
  return { $let: { vars: { reported }, in: { $cond: [{ $gt: [{ $size: "$$reported" }, 0] },
    { $setUnion: [{ $map: { input: "$$reported", as: "disease", in: classify } }, []] },
    { $cond: [{ $and: [
      { $isArray: "$chronicDiseases" }, { $eq: ["$chronicDiseasesConfirmed", true] },
      { $allElementsTrue: [{ $map: { input: { $cond: [{ $isArray: "$chronicDiseases" }, "$chronicDiseases", []] }, as: "entry", in: { $eq: [{ $type: "$$entry" }, "string"] } } }] },
    ] }, ["none"], ["unknown"]] },
  ] } } };
}
function activityMatch(query) {
  return query.activity === "all" ? [] : [{ $match: { "counts.total": query.activity === "recorded" ? { $gt: 0 } : 0 } }];
}
function sumPeople() {
  return { $group: { _id: null, people: { $sum: 1 }, total: { $sum: "$counts.total" },
    ...Object.fromEntries(STATUSES.map(status => [status, { $sum: `$counts.${status}` }])),
    ...Object.fromEntries(TYPES.map(type => [`type_${type}`, { $sum: `$counts.byType.${type}` }])),
  } };
}
function cohortPipeline(query) {
  const text = key => ({ $cond: [{ $eq: [{ $type: `$${key}` }, "string"] }, `$${key}`, ""] });
  const search = query.search ? { $or: [
    ...["citizenId", "firstName", "lastName", "province"].map(key => ({ [key]: { $regex: query.searchRegex, $options: "i" } })),
    { $expr: { $regexMatch: { input: { $concat: [text("firstName"), " ", text("lastName")] }, regex: query.searchRegex, options: "i" } } },
  ] } : {};
  const selected = query.disease === "all" ? [] : [{ $match: { diseaseGroups: query.disease } }];
  const active = activityMatch(query);
  const cutoff = new Date(Math.min(query.end.getTime() - 1, query.asOf.getTime()));
  return [
    { $match: { createdAt: { $type: "date", $lte: cutoff }, ...search } },
    { $set: { diseaseGroups: diseaseExpression() } },
    { $lookup: { from: Health.collection.name,
      let: { key: "$internalId", oid: "$_id", citizen: "$citizenId" }, pipeline: [
        { $match: { $expr: { $or: [
          { $and: [{ $eq: [{ $type: "$$key" }, "long"] }, { $eq: [{ $type: "$userKey" }, "long"] }, { $eq: ["$userKey", "$$key"] }] },
          { $and: [{ $eq: [{ $type: "$userKey" }, "missing"] }, { $or: [
            { $eq: ["$userId", "$$oid"] },
            { $and: [{ $ne: [{ $type: "$userId" }, "objectId"] }, { $eq: ["$citizenId", "$$citizen"] }] },
          ] }] },
        ] } } },
        { $set: { _cohortRecordedAt: { $ifNull: ["$submittedAt", "$createdAt"] }, _cohortStatus: statusExpression,
          _cohortType: { $cond: [{ $in: ["$type", TYPES.slice(0, 4)] }, "$type", "unknown"] } } },
        { $match: { _cohortRecordedAt: { $type: "date", $gte: query.start, $lt: query.end, $lte: query.asOf } } },
        { $facet: { stats: [recordGroup(null), groupProjection()], timeline: [
          recordGroup({ $dateToString: { date: "$_cohortRecordedAt", format: query.range.bucket === "day" ? "%Y-%m-%d" : "%Y-%m", timezone: "Asia/Bangkok" } }), groupProjection(),
        ], latestApprovedRecords: [
          { $match: { _cohortStatus: "approved", type: { $in: TYPES.slice(0, 4) } } },
          { $sort: { _cohortRecordedAt: -1, _id: -1 } },
          { $group: { _id: "$type", record: { $first: "$$ROOT" } } }, { $replaceRoot: { newRoot: "$record" } },
          { $project: latestProjection }, { $sort: { type: 1 } },
        ] } },
      ], as: "_health" } },
    { $set: { _health: { $arrayElemAt: ["$_health", 0] } } },
    { $set: { _stats: { $arrayElemAt: ["$_health.stats", 0] }, _timeline: "$_health.timeline" } },
    { $set: { counts: { $mergeObjects: [emptyCounts(), { $ifNull: ["$_stats", {}] }] } } },
    { $facet: {
      cohort: [...selected, { $group: { _id: null, cohortPeople: { $sum: 1 },
        withRecords: { $sum: { $cond: [{ $gt: ["$counts.total", 0] }, 1, 0] } }, withoutRecords: { $sum: { $cond: [{ $eq: ["$counts.total", 0] }, 1, 0] } } } }],
      summary: [...selected, ...active, sumPeople()],
      diseases: [...active, { $unwind: "$diseaseGroups" }, { $group: { _id: "$diseaseGroups", people: { $sum: 1 } } }],
      timeline: [...selected, ...active, { $unwind: "$_timeline" }, { $group: { _id: "$_timeline.date", people: { $sum: 1 },
        total: { $sum: "$_timeline.total" }, ...Object.fromEntries(STATUSES.map(status => [status, { $sum: `$_timeline.${status}` }])),
        ...Object.fromEntries(TYPES.map(type => [`type_${type}`, { $sum: `$_timeline.byType.${type}` }])) } },
        { $project: { _id: 0, date: "$_id", people: 1, total: 1, ...Object.fromEntries(STATUSES.map(status => [status, 1])), byType: Object.fromEntries(TYPES.map(type => [type, `$type_${type}`])) } }],
      people: [...selected, ...active, { $sort: { "_stats.lastRecordedAt": -1, firstName: 1, lastName: 1, _id: 1 } }, { $skip: query.skip }, { $limit: query.limit },
        { $project: { _id: 0, internalId: 1, citizenId: 1, firstName: 1, lastName: 1, province: 1,
          chronicDiseases: 1, chronicDiseasesConfirmed: 1, diseaseGroups: 1, createdAt: 1,
          counts: { total: "$counts.total", ...Object.fromEntries(STATUSES.map(status => [status, `$counts.${status}`])), byType: "$counts.byType" },
          latestApprovedRecords: { $ifNull: ["$_health.latestApprovedRecords", []] },
          firstRecordedAt: { $ifNull: ["$_stats.firstRecordedAt", null] }, lastRecordedAt: { $ifNull: ["$_stats.lastRecordedAt", null] } } }],
    } },
  ];
}
exports.getCohorts = async (req, res) => {
  try {
    const query = adminCohortQuery(req.query);
    const [result = {}] = await User.aggregate(cohortPipeline(query)).option({ useBigInt64: true }).allowDiskUse(true);
    const grouped = result.summary?.[0] || {}, cohort = result.cohort?.[0] || {};
    const summary = { cohortPeople: cohort.cohortPeople || 0, withRecords: cohort.withRecords || 0, withoutRecords: cohort.withoutRecords || 0,
      people: grouped.people || 0, ...emptyCounts() };
    for (const field of ["total", ...STATUSES]) summary[field] = grouped[field] || 0;
    for (const type of TYPES) summary.byType[type] = grouped[`type_${type}`] || 0;
    const distribution = new Map((result.diseases || []).map(item => [item._id, item.people]));
    const points = new Map((result.timeline || []).map(item => [item.date, item]));
    const data = { schemaVersion: 1, range: query.range, filters: { disease: query.disease, search: query.search, activity: query.activity }, summary,
      diseases: DISEASES.map(({ id, label }) => ({ id, label, people: distribution.get(id) || 0 })),
      timeline: buckets(query.range).map(date => points.get(date) || { date, people: 0, ...emptyCounts() }),
      people: (result.people || []).map(person => ({ ...person, internalId: typeof person.internalId === "bigint" ? String(person.internalId) : null,
        firstName: typeof person.firstName === "string" ? person.firstName : "", lastName: typeof person.lastName === "string" ? person.lastName : "",
        province: typeof person.province === "string" ? person.province : "", chronicDiseases: Array.isArray(person.chronicDiseases) ? person.chronicDiseases.filter(value => typeof value === "string" && value.trim()) : [],
        chronicDiseasesConfirmed: person.chronicDiseasesConfirmed === true })),
      pagination: { page: query.page, limit: query.limit, total: summary.people, hasMore: query.page * query.limit < summary.people },
      diseaseScope: "current-profile-reported", distributionScope: "search-and-activity-current-profile", recordedAtScope: "submittedAt-or-createdAt",
    };
    return response.success({ res, message: "โหลดรายงานสุขภาพสำเร็จ", data, total: summary.people, page: query.page, limit: query.limit });
  } catch (error) {
    return response.error({ res, statusCode: error.code === "INVALID_COHORT_QUERY" ? 400 : 500,
      message: error.code === "INVALID_COHORT_QUERY" ? error.message : "โหลดรายงานสุขภาพไม่สำเร็จ กรุณาลองอีกครั้ง" });
  }
};
