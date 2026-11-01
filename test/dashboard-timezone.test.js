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
    const dayStarts = [];
    const count = async (filter) => {
      if (filter?.createdAt?.$gte) dayStarts.push(filter.createdAt.$gte.toISOString());
      return 0;
    };
    t.mock.method(User, "countDocuments", count);
    t.mock.method(Health, "countDocuments", count);
    t.mock.method(User, "aggregate", async () => []);
    t.mock.method(Health, "aggregate", async () => []);
    const res = responseRecorder();
    await dashboard.summary({}, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(dayStarts, [scenario.start, scenario.start]);
    assert.equal(res.body.data.todayHealthRecords, 0);
    assert.equal(res.body.data.todayNewUsers, 0);
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
