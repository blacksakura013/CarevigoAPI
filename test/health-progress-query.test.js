const assert = require("node:assert/strict");
const { test } = require("node:test");
const { healthProgressQuery } = require("../src/utils/healthProgressQuery");
const citizenId = "8900000000781";
const now = new Date("2026-11-01T17:00:00.000Z");

test("progress rolling windows use inclusive Thai calendar days instead of server UTC midnight", () => {
  const query = healthProgressQuery({ citizenId, days: "30" }, now);
  assert.deepEqual(query.range, { from: "2026-10-04", to: "2026-11-02", asOf: now.toISOString(), timeZone: "Asia/Bangkok" });
  assert.equal(query.start.toISOString(), "2026-10-03T17:00:00.000Z");
  assert.equal(query.end.toISOString(), "2026-11-02T17:00:00.000Z");
  const defaults = healthProgressQuery({ citizenId }, now);
  assert.equal(defaults.range.from, "2026-08-05"); assert.equal(defaults.limit, 20); assert.equal(defaults.reviewStatus, "all");
});

test("progress custom dates include the whole requested Thai day and all-history metadata has no invented start", () => {
  const custom = healthProgressQuery({ citizenId, from: "2024-02-29", to: "2024-02-29" }, now);
  assert.equal(custom.start.toISOString(), "2024-02-28T17:00:00.000Z"); assert.equal(custom.end.toISOString(), "2024-02-29T17:00:00.000Z");
  const all = healthProgressQuery({ citizenId, days: "all", page: "2", limit: "50" }, now);
  assert.equal(all.start, null); assert.equal(all.range.from, null); assert.equal(all.skip, 50);
});

test("progress rejects ambiguous ranges, impossible Gregorian dates and structured or unexpected query inputs", () => {
  for (const invalid of [
    { from: "2026-02-29", to: "2026-03-01" }, { from: "2026-04-31", to: "2026-05-01" },
    { from: "2569-01-01", to: "2026-01-01" }, { from: "2026-01-01" },
    { from: "2026-01-01", to: "2026-01-01", days: "90" }, { from: "2026-01-02", to: "2026-01-01" },
    { from: "0000-01-01", to: "2026-01-01" }, { days: "31" }, { days: ["30"] },
    { reviewStatus: "unknown" }, { citizenId: { $ne: null } }, { where: "anything" },
    { page: "0" }, { page: "1.5" }, { page: "1e2" }, { page: "9007199254740992" },
    { page: "9007199254740991", limit: "50" }, { limit: "51" }, { limit: "0" },
  ]) assert.throws(() => healthProgressQuery({ citizenId, ...invalid }, now), { code: "INVALID_PROGRESS_QUERY" });
});
