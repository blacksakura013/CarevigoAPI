const assert = require("node:assert/strict");
const { before, after, describe, test } = require("node:test");
const bcrypt = require("bcrypt");
const { Long, Decimal128, Int32 } = require("mongodb");
const { startWorkflowHarness, assertStatus, profile } = require("./helpers/workflowHarness");
const { installedMongod } = require("./helpers/isolatedMongo");
const dashboard = require("../src/controllers/dashboard.controller");
const ENABLED = process.env.CAREVIGO_WORKFLOW_INTEGRATION === "1";
const binary = ENABLED ? installedMongod() : null;

describe("staff dashboard summary distinguishes review work, valid Thai-day activity and stored CV scores", {
  skip: !ENABLED ? "Set CAREVIGO_WORKFLOW_INTEGRATION=1 for isolated real MongoDB tests" : !binary ? "No installed mongod" : false,
  concurrency: false, timeout: 180000,
}, () => {
  let h, staff, owner, other, overdue;
  let citizen = 8600000000000;
  const asOf = new Date("2026-11-02T03:00:00.000Z");
  const today = new Date("2026-11-01T17:00:00.000Z");
  const recordedAt = new Date("2026-11-02T01:00:00.000Z");
  const historical = new Date("2026-01-01T00:00:00.000Z");
  let userTotal = 0;
  const createUser = async overrides => {
    userTotal++;
    return h.models.User.create({ citizenId: String(++citizen), ...profile(), createdAt: historical, ...overrides });
  };
  const row = (user = owner, overrides = {}) => h.models.Health.create({
    userId: user._id, citizenId: user.citizenId, type: "sugar", value: { fbs: 95 },
    reviewStatus: "approved", createdAt: recordedAt, ...overrides,
  });
  const recorder = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  async function summary() {
    const res = recorder(); await dashboard.summary({}, res); assert.equal(res.statusCode, 200); return res.body.data;
  }
  before(async () => {
    h = await startWorkflowHarness(); assert.ok(h); staff = h.newClient("admin"); await staff.loginStaff();
    owner = await createUser({ internalId: 10n, isVerified: true, status: "active", accountEnabled: true,
      passwordHash: await bcrypt.hash("123456", 4), requiresPasswordChange: false });
    other = await createUser();
    for (const status of ["approved", "pending", "rejected", undefined, null, "", "unrecognized", ["approved"]]) {
      const record = await row();
      if (status === undefined) await h.models.Health.collection.updateOne({ _id: record._id }, { $unset: { reviewStatus: 1 } });
      else await h.models.Health.collection.updateOne({ _id: record._id }, { $set: { reviewStatus: status } });
      if (status === "pending") {
        overdue = record;
        await h.models.Health.collection.updateOne({ _id: record._id }, { $set: { reviewDueAt: historical } });
      }
    }
    await row(owner, { submittedAt: today, createdAt: new Date("2026-12-01T00:00:00Z") });
    await row(owner, { submittedAt: historical });
    await row(owner, { submittedAt: new Date(asOf.getTime() + 1) });
    const invalidSubmitted = await row();
    await h.models.Health.collection.updateOne({ _id: invalidSubmitted._id }, { $set: { submittedAt: "2026-11-02T01:00:00Z" } });
    await row(owner, { createdAt: new Date(today.getTime() - 1) });
    await row(owner, { createdAt: new Date(asOf.getTime() + 1) });
    for (const createdAt of ["2026-11-02T01:00:00Z", [recordedAt]]) {
      const invalid = await row();
      await h.models.Health.collection.updateOne({ _id: invalid._id }, { $set: { createdAt } });
    }
    await row(owner, { submittedAt: null });
    await row(owner, { submittedAt: asOf });
    // Legacy high-BMI counters retain their historical meaning and numeric
    // ownership takes precedence over a conflicting ObjectId/citizen link.
    const mismatched = await row(owner, { cvdRisk: { level: "risk_high" } });
    await h.models.Health.collection.updateOne({ _id: mismatched._id }, { $set: { userKey: other.internalId } });
    await row(other, { cvdRisk: { level: "risk_high" } });
    const legacy = await row(owner, { cvdRisk: { level: "risk_high" } });
    await h.models.Health.collection.updateOne({ _id: legacy._id }, { $unset: { userKey: 1 } });
    await row(owner, { cvdRisk: { level: "risk_high" } });
    for (const score of [0, 9.9999, 10, 20, 20.0001, 100, new Int32(20)]) {
      const user = await createUser({ thaiCvRisk: { status: "calculated", score: 12, level: "low" } });
      await h.models.User.collection.updateOne({ _id: user._id }, { $set: { "thaiCvRisk.score": score,
        "thaiCvRisk.level": typeof score === "number" && score < 10 ? "high" : "low" } });
    }
    for (const score of [null, -1, 101, NaN, Infinity, -Infinity, "12", true,
      Long.fromNumber(0), Long.fromNumber(10), Long.fromNumber(100),
      Decimal128.fromString("0"), Decimal128.fromString("20.00000000000000000001"), [12]]) {
      const user = await createUser({ thaiCvRisk: { status: "calculated", score: 12, level: "high" } });
      await h.models.User.collection.updateOne({ _id: user._id }, { $set: { "thaiCvRisk.score": score } });
    }
    await createUser({ thaiCvRisk: { status: "ineligible", score: 99, level: "high" } });
    await createUser({ thaiCvRisk: { status: "incomplete", score: 99, level: "high" } });
    for (const createdAt of [today, asOf, new Date(today.getTime() - 1), new Date(asOf.getTime() + 1), "2026-11-02T01:00:00Z", [recordedAt], null]) {
      const user = await createUser();
      await h.models.User.collection.updateOne({ _id: user._id }, { $set: { createdAt } });
    }
  });
  after(async () => {
    if (!h) return;
    const cleanup = await h.stop(); assert.equal(cleanup.exited, true); assert.equal(cleanup.removed, true);
    console.log(`Dashboard summary cleanup verified: private MongoDB PID ${cleanup.pid} exited and directory removed`);
  });

  test("all review buckets partition actual health records, including legacy approved and corrupt unknown states", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: asOf.getTime() });
    const data = await summary();
    assert.equal(data.schemaVersion, 2); assert.equal(data.timeZone, "Asia/Bangkok"); assert.equal(data.asOf, asOf.toISOString());
    assert.equal(data.totalHealthRecords, 22); assert.equal(data.approvedHealthRecords, 16);
    assert.equal(data.pendingHealthRecords, 1); assert.equal(data.rejectedHealthRecords, 1); assert.equal(data.unknownHealthRecords, 4);
    assert.equal(data.approvedHealthRecords + data.pendingHealthRecords + data.rejectedHealthRecords + data.unknownHealthRecords, data.totalHealthRecords);
    assert.equal(data.totalUsers, userTotal); assert.equal(data.verifiedUsers, 1); assert.equal(data.pendingUsers, userTotal - 1);
  });

  test("today honors valid submitted dates, Thai-midnight inclusion, the captured upper bound and strict BSON date types", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: asOf.getTime() });
    const data = await summary();
    assert.equal(data.todayHealthRecords, 15); assert.equal(data.todayNewUsers, 2);
  });

  test("Thai CV counts use finite BSON int/double scores with inclusive10/20 thresholds rather than stale labels or coerced types", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: asOf.getTime() });
    const data = await summary();
    assert.deepEqual(data.thaiCvRisk, { low: 2, moderate: 3, high: 2,
      incomplete: userTotal - 8, ineligible: 1, totalCalculated: 7 });
    assert.equal(data.highRiskRecords, 4); assert.equal(data.highRiskUsers, 2);
    assert.ok(other.internalId > 9007199254740993n); assert.equal(owner.internalId, 10n);
  });

  test("summary reads do not approve overdue records, refresh risk, alter clinical data or send messages", async t => {
    const beforeUsers = await h.models.User.collection.find({}).sort({ _id: 1 }).toArray();
    const beforeHealth = await h.models.Health.collection.find({}).sort({ _id: 1 }).toArray();
    const approve = t.mock.method(h.review, "approveOverdue", () => { throw new Error("Summary is read-only"); });
    const refresh = t.mock.method(require("../src/services/thaiCvRisk.service"), "refreshUserThaiCvRisk", () => { throw new Error("Summary is read-only"); });
    const result = await staff.request("/dashboard/summary"); assertStatus(result, 200);
    assert.equal(result.headers.get("cache-control"), "no-store"); assert.equal(result.body.data.schemaVersion, 2);
    assert.equal(approve.mock.callCount(), 0); assert.equal(refresh.mock.callCount(), 0);
    assert.deepEqual(await h.models.User.collection.find({}).sort({ _id: 1 }).toArray(), beforeUsers);
    assert.deepEqual(await h.models.Health.collection.find({}).sort({ _id: 1 }).toArray(), beforeHealth);
    assert.equal((await h.models.Health.findById(overdue._id)).reviewStatus, "pending");
    assert.equal(h.sentEmails.length, 0); assert.equal(h.sentResetEmails.length, 0);
  });

  test("staff summary rejects anonymous and member callers and keeps both staff roles available", async () => {
    assertStatus(await h.newClient().request("/dashboard/summary", { anonymous: true }), 401);
    const member = h.newClient();
    assertStatus(await member.request("/auth/patient/login", { method: "POST", body: { citizenId: owner.citizenId, password: "123456" } }), 200);
    assertStatus(await member.request("/dashboard/summary"), 403);
    const reviewer = h.newClient("admin");
    assertStatus(await reviewer.request("/auth/login", { method: "POST", body: { email: h.admins[1].email, password: "workflow-staff-password" } }), 200);
    assertStatus(await reviewer.request("/dashboard/summary"), 200);
  });

  test("database failures produce a safe summary error with no connection or query details", async t => {
    t.mock.method(h.models.User, "countDocuments", async () => { throw new Error("PRIVATE-DATABASE-CONNECTION-DETAILS"); });
    const result = await staff.request("/dashboard/summary"); assertStatus(result, 500);
    assert.equal(JSON.stringify(result.body).includes("PRIVATE-DATABASE"), false);
    assert.equal(result.body.data, null);
  });
});
