const { test } = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const Health = require("../src/models/Health");
const dashboard = require("../src/controllers/dashboard.controller");

function responseRecorder() {
  return {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

for (const scenario of [
  { name: "Thai early morning", now: "2026-11-01T01:00:00Z", start: "2026-10-31T17:00:00.000Z" },
  { name: "Thai afternoon", now: "2026-11-01T10:00:00Z", start: "2026-10-31T17:00:00.000Z" },
  { name: "Thai midnight rollover", now: "2026-11-01T17:00:00Z", start: "2026-11-01T17:00:00.000Z" }
]) {
  test(`dashboard today counts use Bangkok day boundaries: ${scenario.name}`, async (t) => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = "UTC";
    t.after(() => {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    });
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(scenario.now) });
    const registrationFilters = [], healthPipelines = [];
    const count = async (filter) => {
      if (filter?.createdAt?.$gte) registrationFilters.push(filter);
      return 0;
    };
    t.mock.method(User, "countDocuments", count);
    t.mock.method(Health, "countDocuments", count);
    t.mock.method(User, "aggregate", async () => []);
    t.mock.method(Health, "aggregate", value => {
      healthPipelines.push(value);
      const result = Promise.resolve([]);
      result.option = () => result;
      return result;
    });
    const res = responseRecorder();
    await dashboard.summary({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(registrationFilters.length, 1);
    assert.equal(registrationFilters[0].createdAt.$gte.toISOString(), scenario.start);
    assert.equal(registrationFilters[0].createdAt.$lte.toISOString(), new Date(scenario.now).toISOString());
    assert.deepEqual(registrationFilters[0].$expr, { $eq: [{ $type: "$createdAt" }, "date"] });
    const health = healthPipelines.find(pipeline => pipeline[0].$set?._summaryRecordedAt);
    assert.deepEqual(health[0].$set._summaryRecordedAt, { $ifNull: ["$submittedAt", "$createdAt"] });
    const conditions = health[1].$group.today.$sum.$cond[0].$and;
    assert.deepEqual(conditions[0], { $eq: [{ $type: "$_summaryRecordedAt" }, "date"] });
    assert.equal(conditions[1].$gte[1].toISOString(), scenario.start);
    assert.equal(conditions[2].$lte[1].toISOString(), new Date(scenario.now).toISOString());
    assert.equal(res.body.data.todayHealthRecords, 0);
    assert.equal(res.body.data.todayNewUsers, 0);
    assert.equal(res.body.data.asOf, new Date(scenario.now).toISOString());
    assert.equal(res.body.data.timeZone, "Asia/Bangkok");
    assert.equal(res.body.data.schemaVersion, 2);
    assert.equal(res.body.data.pendingHealthRecords, 0);
    assert.equal(res.body.data.approvedHealthRecords, 0);
    assert.equal(res.body.data.rejectedHealthRecords, 0);
    assert.equal(res.body.data.unknownHealthRecords, 0);
  });
}

test("user analytics groups registration dates in Bangkok time", async (t) => {
  let pipeline;
  t.mock.method(User, "aggregate", async (value) => {
    pipeline = value;
    return [{ _id: "2026-11-02", users: 1 }];
  });
  const res = responseRecorder();
  await dashboard.usersAnalytics({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(pipeline[0].$group._id.$dateToString.timezone, "Asia/Bangkok");
  assert.deepEqual(res.body.data, [{ _id: "2026-11-02", users: 1 }]);
});
