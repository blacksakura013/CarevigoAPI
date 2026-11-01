const assert = require("node:assert/strict");
const { before, after, describe, test } = require("node:test");
const bcrypt = require("bcrypt");
const { Long, Decimal128, Int32 } = require("mongodb");
const { startWorkflowHarness, assertStatus, profile } = require("./helpers/workflowHarness");
const { installedMongod } = require("./helpers/isolatedMongo");
const ENABLED = process.env.CAREVIGO_WORKFLOW_INTEGRATION === "1";
const binary = ENABLED ? installedMongod() : null;

describe("private longitudinal health progress uses complete approved history without clinical writes", {
  skip: !ENABLED ? "Set CAREVIGO_WORKFLOW_INTEGRATION=1 for isolated real MongoDB tests" : !binary ? "No installed mongod" : false,
  concurrency: false, timeout: 180000,
}, () => {
  let h, staff, patient, owner, foreign, seriesOwner, precisionOwner, small, pending, legacy, numericForeign, dangling;
  const period = { from: "2026-10-02", to: "2026-10-02" };
  const inPeriod = [], firstDay = new Date("2026-01-01T03:00:00.000Z");
  let nextCitizen = 8300000000000;
  const createUser = overrides => h.models.User.create({ citizenId: String(++nextCitizen), ...profile(), status: "active", isVerified: true, ...overrides });
  const row = (user, overrides = {}) => h.models.Health.create({ userId: user._id, citizenId: user.citizenId,
    type: "sugar", value: { fbs: 95 }, source: "admin", reviewStatus: "approved", createdAt: new Date("2026-10-02T10:00:00.000Z"), ...overrides });
  async function get(user = owner, query = {}, client = staff) {
    const result = await client.request(`/public/health/progress?${new URLSearchParams({ citizenId: user.citizenId, ...query })}`);
    assertStatus(result, 200); return result.body;
  }
  before(async () => {
    h = await startWorkflowHarness(); assert.ok(h); staff = h.newClient("admin"); await staff.loginStaff();
    owner = await createUser({ internalId: 10n, accountEnabled: true, requiresPasswordChange: false,
      passwordHash: await bcrypt.hash("123456", 4), email: "PRIVATE-OWNER-EMAIL", lineId: "PRIVATE-LINE",
      thaiCvRisk: { status: "calculated", score: 12.5, level: "moderate", calculatedAt: new Date("2026-01-01T00:00:00Z") } });
    foreign = await createUser(); seriesOwner = await createUser(); precisionOwner = await createUser();
    patient = h.newClient();
    assertStatus(await patient.request("/auth/patient/login", { method: "POST", body: { citizenId: owner.citizenId, password: "123456" } }), 200);
    small = await row(owner, { internalId: 12n, type: "blood_pressure", value: { systolic: 120, diastolic: 80, pulse: 72 },
      submittedAt: new Date("2026-10-01T17:00:00.000Z"), createdAt: new Date("2026-10-20T05:00:00.000Z"),
      submittedProfile: { birthDate: "19800101", gender: "female", firstName: "PRIVATE-SUBMITTED-NAME", phone: "PRIVATE-PHONE", cancerDetails: "PRIVATE-CANCER" },
      legalAgreement: { termsVersion: "PRIVATE-LEGAL", privacyVersion: "2026-11-01", termsAccepted: true, acceptedAt: new Date("2026-10-02T00:00:00Z"), source: "staff-attestation" },
      reviewHistory: [{ at: new Date("2026-10-02T00:00:00Z"), status: "approved", source: "admin", actor: "PRIVATE-ACTOR", actorId: "PRIVATE-ACTOR-ID", adminKey: 500n, reason: "ตรวจสอบแล้ว" }],
    }); inPeriod.push(small);
    pending = await row(owner, { value: { fbs: 343 }, source: "guest", reviewStatus: "pending", reviewDueAt: new Date("2026-10-02T16:59:00Z"), reviewReason: "รอตรวจสอบ" }); inPeriod.push(pending);
    inPeriod.push(await row(owner, { type: "cholesterol", value: { total: 240 }, reviewStatus: "rejected", createdAt: new Date("2026-10-02T11:00:00Z") }));
    inPeriod.push(await row(owner, { type: "bmi", value: { weight: 60, height: 165 }, weight: 60, height: 165, bmi: 22.04, createdAt: new Date("2026-10-02T12:00:00Z") }));
    const unknown = await row(owner, { value: { fbs: 777 }, createdAt: new Date("2026-10-02T13:00:00Z") });
    await h.models.Health.collection.updateOne({ _id: unknown._id }, { $set: { reviewStatus: null } }); inPeriod.push(unknown);
    legacy = await row(owner, { createdAt: new Date("2026-10-02T14:00:00Z") });
    await h.models.Health.collection.updateOne({ _id: legacy._id }, { $unset: { userKey: 1, reviewStatus: 1 } }); inPeriod.push(legacy);
    for (const systolic of [130, 140]) inPeriod.push(await row(owner, { type: "blood_pressure", value: { systolic, diastolic: 85 }, createdAt: new Date("2026-10-02T15:00:00Z") }));
    await row(owner, { createdAt: new Date("2026-10-01T16:59:59.999Z") });
    await row(owner, { createdAt: new Date("2026-10-02T17:00:00.000Z") });
    numericForeign = await row(owner, { value: { fbs: 999 } });
    await h.models.Health.collection.updateOne({ _id: numericForeign._id }, { $set: { userKey: foreign.internalId } });
    dangling = await row(owner, { value: { fbs: 888 } });
    await h.models.Health.collection.updateOne({ _id: dangling._id }, { $set: { userKey: foreign.internalId + 999999n } });
    const series = Array.from({ length: 130 }, (_, index) => ({ userId: seriesOwner._id, citizenId: seriesOwner.citizenId,
      type: "sugar", value: { fbs: 90 + index }, reviewStatus: "approved", source: "patient", createdAt: new Date(firstDay.getTime() + index * 86400000) }));
    await h.models.Health.insertMany(series);
    await row(seriesOwner, { value: { hba1c: 6.2 }, createdAt: new Date("2026-05-20T03:00:00Z") });
    for (const value of [Long.fromNumber(6), Decimal128.fromString("6.20000000000000000000000001"), "6.2", true, null, NaN, Infinity, -Infinity, 0, -1, 6.2, new Int32(6)]) {
      const record = await row(precisionOwner, { value: { hba1c: 6.2 } });
      await h.models.Health.collection.updateOne({ _id: record._id }, { $set: { "value.hba1c": value } });
    }
    await row(precisionOwner, { type: "bmi", value: { weight: 61, height: 166 }, bmi: 22.14 });
    const unknownType = await row(precisionOwner);
    await h.models.Health.collection.updateOne({ _id: unknownType._id }, { $set: { type: "unknown_legacy_type" } });
  });
  after(async () => {
    if (!h) return;
    const cleanup = await h.stop(); assert.equal(cleanup.exited, true); assert.equal(cleanup.removed, true);
    console.log(`Health progress cleanup verified: private MongoDB PID ${cleanup.pid} exited and directory removed`);
  });

  test("owner and staff see the same full period with canonical Thai-day timestamps, safe projections and exact small numeric IDs", async () => {
    const staffResult = await get(owner, { ...period, limit: "50" });
    const mine = await get(owner, { ...period, limit: "50" }, patient);
    assert.deepEqual(mine.data.summary, staffResult.data.summary); assert.deepEqual(mine.data.metrics, staffResult.data.metrics);
    const data = mine.data;
    assert.equal(data.schemaVersion, 1); assert.equal(data.range.timeZone, "Asia/Bangkok"); assert.equal(data.range.from, period.from); assert.equal(data.range.to, period.to);
    assert.deepEqual(data.summary, { total: 8, approved: 5, pending: 1, rejected: 1, unknown: 1,
      firstRecordedAt: "2026-10-01T17:00:00.000Z", lastRecordedAt: "2026-10-02T15:00:00.000Z",
      byType: { blood_pressure: 3, sugar: 3, cholesterol: 1, bmi: 1, unknown: 0 } });
    const record = data.records.find(item => item._id === String(small._id));
    assert.equal(record.internalId, "12"); assert.equal(record.userKey, "10"); assert.equal(record.recordedAt, "2026-10-01T17:00:00.000Z");
    assert.deepEqual(record.submittedProfile, { birthDate: "19800101", gender: "female" });
    assert.deepEqual(Object.keys(data.patient).sort(), ["citizenId", "firstName", "lastName", "birthDate", "gender"].sort());
    assert.equal(JSON.stringify(data).includes("PRIVATE-"), false); assert.equal(record.legalAgreement, undefined); assert.equal(record.reviewHistory[0].actorId, undefined);
    assert.equal(data.currentRisk.score, 12.5); assert.equal(data.currentRisk.calculatedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(data.summaryScope, "all-statuses-in-range"); assert.equal(data.metricsScope, "approved-in-range");
  });

  test("detail review filters never shrink all-status summary or contaminate approved clinical metrics", async () => {
    const baseline = await get(owner, period);
    for (const [reviewStatus, count] of [["approved", 5], ["pending", 1], ["rejected", 1]]) {
      const result = await get(owner, { ...period, reviewStatus });
      assert.equal(result.total, count); assert.equal(result.data.pagination.total, count); assert.equal(result.data.pagination.reviewStatus, reviewStatus);
      assert.deepEqual(result.data.summary, baseline.data.summary); assert.deepEqual(result.data.metrics, baseline.data.metrics);
      assert.equal(result.data.records.every(record => record.reviewStatus === reviewStatus), true);
    }
    assert.equal(baseline.data.metrics.fbs.total, 1); assert.equal(baseline.data.metrics.fbs.latest.value, 95);
    assert.equal(baseline.data.metrics.total.total, 0); assert.equal(baseline.data.metrics.systolic.total, 3);
    assert.equal(baseline.data.records.find(record => record._id === String(legacy._id)).reviewStatus, "approved");
    assert.equal(baseline.data.records.some(record => record.reviewStatus === "unknown"), true);
    assert.deepEqual(baseline.data.latestApprovedRecords.map(record => record.type).sort(), ["blood_pressure", "bmi", "sugar"]);
    assert.equal(baseline.data.latestApprovedRecords.find(record => record.type === "blood_pressure").value.systolic, 140);
  });

  test("metric counts, first and latest pairs use the complete range beyond both pagination and the100point series limit", async () => {
    const result = await get(seriesOwner, { days: "all", limit: "1" });
    assert.equal(result.total, 131); assert.equal(result.data.records.length, 1); assert.equal(result.hasMore, true);
    assert.deepEqual(result.data.records[0].value, { hba1c: 6.2 });
    const metric = result.data.metrics.fbs;
    assert.equal(metric.total, 130); assert.equal(metric.first.value, 90); assert.equal(metric.previous.value, 218); assert.equal(metric.latest.value, 219);
    assert.equal(metric.seriesLimit, 100); assert.equal(metric.hasEarlier, true); assert.equal(metric.series.length, 100);
    assert.equal(metric.series[0].value, 120); assert.equal(metric.series[99].value, 219);
    assert.equal(metric.series.every((sample, index) => index === 0 || Date.parse(sample.recordedAt) > Date.parse(metric.series[index - 1].recordedAt)), true);
    assert.equal(typeof metric.latest.recordId, "string"); assert.equal(result.data.metrics.hba1c.total, 1); assert.equal(result.data.metrics.hba1c.previous, null);
    assert.equal(result.data.range.from, null); assert.equal(Object.keys(result.data.metrics).length, 12);
    assert.deepEqual(result.data.metrics.pulse, { total: 0, first: null, previous: null, latest: null, series: [], seriesLimit: 100, hasEarlier: false });
  });

  test("pagination follows recorded time and deterministic ObjectId ties while range and full metrics stay unchanged", async () => {
    const expected = await get(owner, { ...period, limit: "50" });
    const seen = [];
    for (let page = 1; page <= 4; page++) {
      const result = await get(owner, { ...period, page: String(page), limit: "2" });
      assert.equal(result.data.pagination.hasMore, page < 4); assert.equal(result.data.pagination.total, 8);
      assert.deepEqual(result.data.summary, expected.data.summary); assert.deepEqual(result.data.metrics, expected.data.metrics);
      seen.push(...result.data.records.map(record => record._id));
    }
    assert.deepEqual(seen, expected.data.records.map(record => record._id)); assert.equal(new Set(seen).size, 8);
    assert.equal(expected.data.records[0].value.systolic, 140); assert.equal(expected.data.records[1].value.systolic, 130);
    assert.equal(expected.data.records.at(-1)._id, String(small._id));
    const beyond = await get(owner, { ...period, page: "5", limit: "2" }); assert.deepEqual(beyond.data.records, []); assert.equal(beyond.hasMore, false);
  });

  test("numeric ownership takes precedence over conflicting citizen and ObjectId links while legacy links remain readable", async () => {
    const mine = await get(owner, { days: "all", limit: "50" }, patient);
    assert.equal(mine.data.records.some(record => record._id === String(numericForeign._id) || record._id === String(dangling._id)), false);
    assert.equal(mine.data.records.some(record => record._id === String(legacy._id)), true);
    const theirs = await get(foreign, { days: "all" });
    assert.equal(theirs.total, 1); assert.equal(theirs.data.records[0]._id, String(numericForeign._id));
    assert.equal(theirs.data.records[0].userKey, foreign.internalId.toString()); assert.ok(BigInt(theirs.data.records[0].userKey) > 9007199254740993n);
    assertStatus(await patient.request(`/public/health/progress?citizenId=${foreign.citizenId}&days=all`), 403);
    assertStatus(await h.newClient().request(`/public/health/progress?citizenId=${owner.citizenId}`, { anonymous: true }), 401);
  });

  test("clinical BSON Long, Decimal128, strings, booleans and nonfinite values remain unavailable instead of changing numeric interpretation", async () => {
    const result = await get(precisionOwner, { days: "all", limit: "50" });
    assert.equal(result.data.metrics.hba1c.total, 2);
    assert.deepEqual(result.data.metrics.hba1c.series.map(sample => sample.value).sort(), [6, 6.2]);
    assert.equal(result.data.records.filter(record => record.type === "sugar" && record.value.hba1c !== undefined).length, 2);
    assert.equal(result.data.metrics.weight.latest.value, 61); assert.equal(result.data.metrics.height.latest.value, 166); assert.equal(result.data.metrics.bmi.latest.value, 22.14);
    assert.equal(result.data.summary.byType.unknown, 1);
    assert.equal(Object.values(result.data.summary.byType).reduce((sum, count) => sum + count, 0), result.data.summary.total);
  });

  test("strict query validation runs before any health aggregation and unknown staff target is a sanitized404", async t => {
    const aggregate = t.mock.method(h.models.Health, "aggregate", () => { throw new Error("Invalid queries must never reach clinical history"); });
    const base = `citizenId=${owner.citizenId}`;
    for (const query of ["days=31", "days[]=30", "from=2026-02-29&to=2026-03-01", "from=2026-01-01", "to=2026-01-01",
      "from=2026-01-02&to=2026-01-01", "from=2026-01-01&to=2026-01-01&days=all", "page=0", "page=1.5", "page=9007199254740991&limit=50",
      "limit=51", "limit[$gt]=0", "reviewStatus=unknown", "type=sugar", "where=anything", "sort=oldest", "citizenId[$ne]=x"]) {
      const result = await staff.request(`/public/health/progress?${base}&${query}`); assertStatus(result, 400); assert.equal(result.headers.get("cache-control"), "no-store");
    }
    assertStatus(await staff.request("/public/health/progress?citizenId=123"), 400);
    const missing = await staff.request("/public/health/progress?citizenId=8999999999999&days=all"); assertStatus(missing, 404);
    assert.equal(aggregate.mock.callCount(), 0); assert.equal(JSON.stringify(missing.body).includes("8999999999999"), false);
  });

  test("progress reads never approve overdue data, refresh stored risk or send notification mail", async t => {
    const overdue = t.mock.method(h.review, "approveOverdue", () => { throw new Error("A progress read must not process reviews"); });
    const service = require("../src/services/thaiCvRisk.service");
    const refresh = t.mock.method(service, "refreshUserThaiCvRisk", () => { throw new Error("A progress read must not write a clinical assessment"); });
    const before = await h.models.User.findById(owner._id).lean();
    const count = await h.models.Health.countDocuments({});
    const result = await get(owner, { ...period, reviewStatus: "pending" });
    assert.equal(result.data.records[0].reviewStatus, "pending"); assert.equal(overdue.mock.callCount(), 0); assert.equal(refresh.mock.callCount(), 0);
    assert.equal((await h.models.Health.findById(pending._id)).reviewStatus, "pending");
    assert.deepEqual((await h.models.User.findById(owner._id).lean()).thaiCvRisk, before.thaiCvRisk);
    assert.equal(await h.models.Health.countDocuments({}), count); assert.equal(h.sentEmails.length, 0); assert.equal(h.sentResetEmails.length, 0);
  });

  test("empty approved ranges still expose all metric placeholders and cookie origin, session and initial-password guards remain enforced", async () => {
    const empty = await get(owner, { from: "2025-01-01", to: "2025-01-01" });
    assert.equal(empty.data.summary.total, 0); assert.equal(empty.data.summary.firstRecordedAt, null); assert.deepEqual(empty.data.records, []);
    assert.equal(Object.keys(empty.data.metrics).length, 12); assert.equal(Object.values(empty.data.metrics).every(metric => metric.total === 0 && metric.latest === null && metric.series.length === 0), true);
    assertStatus(await patient.request(`/public/health/progress?citizenId=${owner.citizenId}`, { headers: { Origin: "https://evil.example.test" } }), 403);
    assertStatus(await patient.request(`/public/health/progress?citizenId=${owner.citizenId}`, { headers: { "X-Carevigo-Session-Id": "wrong-session" } }), 409);
    const initial = await createUser({ accountEnabled: true, requiresPasswordChange: true, passwordHash: await bcrypt.hash("123456", 4) });
    const client = h.newClient();
    assertStatus(await client.request("/auth/patient/login", { method: "POST", body: { citizenId: initial.citizenId, password: "123456" } }), 200);
    const blocked = await client.request(`/public/health/progress?citizenId=${initial.citizenId}`); assertStatus(blocked, 403); assert.equal(blocked.body.code, "PASSWORD_CHANGE_REQUIRED");
  });
});
