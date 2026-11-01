const assert = require("node:assert/strict");
const { test } = require("node:test");
const { adminCohortQuery, buckets, emptyCounts } = require("../src/utils/adminCohortQuery");
const now = new Date("2026-11-01T17:00:00.000Z");

test("cohort defaults use current Thai month and an explicit as-of instant", () => {
  const query = adminCohortQuery({}, now);
  assert.deepEqual(query.range, { from: "2026-11-01", to: "2026-11-02", asOf: now.toISOString(), timeZone: "Asia/Bangkok", bucket: "day" });
  assert.equal(query.start.toISOString(), "2026-10-31T17:00:00.000Z");
  assert.equal(query.end.toISOString(), "2026-11-02T17:00:00.000Z");
  assert.equal(query.limit, 20); assert.equal(query.page, 1); assert.equal(query.activity, "all"); assert.equal(query.disease, "all");
});
test("cohort inclusive ranges are bounded to366days and change bucket density after92days", () => {
  const short = adminCohortQuery({ from: "2026-08-03", to: "2026-11-02" }, now);
  assert.equal(short.range.bucket, "day"); assert.equal(buckets(short.range).length, 92);
  const long = adminCohortQuery({ from: "2026-08-02", to: "2026-11-02" }, now);
  assert.equal(long.range.bucket, "month"); assert.deepEqual(buckets(long.range), ["2026-08", "2026-09", "2026-10", "2026-11"]);
  assert.equal(adminCohortQuery({ from: "2025-11-02", to: "2026-11-02" }, now).range.bucket, "month");
  assert.equal(adminCohortQuery({ from: "2024-02-29", to: "2024-02-29" }, now).start.toISOString(), "2024-02-28T17:00:00.000Z");
});
test("cohort search is a bounded literal string and pagination uses safe integers", () => {
  const query = adminCohortQuery({ search: "  A.*[1]  ", page: "2", limit: "50", disease: "cancer", activity: "recorded" }, now);
  assert.equal(query.search, "A.*[1]"); assert.equal(query.searchRegex, "A\\.\\*\\[1\\]"); assert.equal(query.skip, 50);
  assert.deepEqual(emptyCounts(), { total: 0, approved: 0, pending: 0, rejected: 0, unknown: 0, byType: { blood_pressure: 0, sugar: 0, cholesterol: 0, bmi: 0, unknown: 0 } });
});
test("cohort rejects structured operators, ambiguous or future dates, unbounded input and invalid selectors", () => {
  for (const invalid of [null, [], { from: "2026-11-01" }, { to: "2026-11-01" },
    { from: "2026-02-29", to: "2026-03-01" }, { from: "0000-01-01", to: "0000-01-01" },
    { from: "2026-11-03", to: "2026-11-02" }, { from: "2026-11-02", to: "2026-11-03" },
    { from: "2025-11-01", to: "2026-11-02" }, { from: "2569-11-01", to: "2569-11-02" },
    { search: { $ne: "" } }, { search: ["x"] }, { search: "x".repeat(101) }, { search: "x\ny" }, { disease: "anything" },
    { activity: "pending" }, { bucket: "day" }, { days: "90" }, { page: "0" }, { page: "1.5" }, { page: "9007199254740992" },
    { page: "9007199254740991", limit: "50" }, { limit: "51" }, { limit: "0" }, { limit: 10 }])
    assert.throws(() => adminCohortQuery(invalid, now), { code: "INVALID_COHORT_QUERY" });
});
