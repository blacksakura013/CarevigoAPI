// Real anonymous routes/models on a private MongoDB. SMTP is stubbed by the harness.
const assert = require("node:assert/strict");
const { describe, test, before, after } = require("node:test");
const { startWorkflowHarness, assertStatus, profile } = require("./helpers/workflowHarness");
const { installedMongod } = require("./helpers/isolatedMongo");
const { calculateThaiCvRisk } = require("../src/utils/thaiCvRisk");
const ENABLED = process.env.CAREVIGO_WORKFLOW_INTEGRATION === "1";
const binary = ENABLED ? installedMongod() : null;
const selected = (systolic = 120, total = 200) => [
  { type: "blood_pressure", value: { systolic, diastolic: 80 } },
  { type: "cholesterol", value: { total } },
];

describe("guest Thai CV assessments use only the accepted submission snapshot", {
  skip: !ENABLED ? "Set CAREVIGO_WORKFLOW_INTEGRATION=1 for isolated real MongoDB tests" : !binary ? "No installed mongod" : false,
  concurrency: false, timeout: 180000,
}, () => {
  let h, nextCitizen = 8700000000000;
  const citizenId = () => String(++nextCitizen);
  before(async () => { h = await startWorkflowHarness(); assert.ok(h); });
  after(async () => {
    if (!h) return;
    const cleanup = await h.stop(); assert.equal(cleanup.exited, true); assert.equal(cleanup.removed, true);
    console.log(`Submission assessment cleanup verified: private MongoDB PID ${cleanup.pid} exited and directory removed`);
  });
  async function submit(overrides = {}) {
    const payload = h.guestPayload(citizenId(), { records: selected(), ...overrides }), client = h.newClient();
    const result = await client.request("/public/submissions", { anonymous: true, method: "POST", body: payload });
    assertStatus(result, 202);
    const receipt = result.body.data, source = await h.models.Submission.findById(receipt.submissionId);
    // Reading the receipt must not trigger the normal 23:59 catch-up during these assertions.
    const future = new Date("2050-01-01T00:00:00Z");
    await h.models.Submission.updateOne({ internalId: source.internalId }, { $set: { reviewDueAt: future, receiptExpiresAt: future } });
    await h.models.Health.updateMany({ submissionKey: source.internalId }, { $set: { reviewDueAt: future } });
    return { payload, client, receipt, source };
  }
  async function readReceipt(fixture) {
    const result = await fixture.client.request(`/public/submissions/${fixture.receipt.submissionId}?token=${fixture.receipt.receiptToken}`, { anonymous: true });
    assertStatus(result, 200); return result.body.data;
  }
  function assertSafeAssessment(risk) {
    assert.deepEqual(Object.keys(risk).sort(), ["calculatedAt", "displayScore", "inputs", "label", "level", "missing", "model", "reason", "score", "source", "sourceVersion", "status"]);
    assert.deepEqual(Object.keys(risk.inputs).sort(), ["bloodPressureRecordedAt", "cholesterolRecordedAt", "profileSource"]);
    assert.equal(risk.inputs.profileSource, "submitted-profile");
  }

  test("complete pending submissions immediately expose low, moderate and high risk on acknowledgement and receipt without persisting a clinical assessment", async () => {
    for (const fixture of [
      { level: "low", patient: { birthDate: "19860315", gender: "female" }, systolic: 110, total: 160 },
      { level: "moderate", patient: { birthDate: "19710315", gender: "male" }, systolic: 140, total: 220 },
      { level: "high", patient: { birthDate: "19610315", gender: "male", smokingStatus: "current", chronicDiseases: ["เบาหวาน"] }, systolic: 160, total: 240 },
    ]) {
      const accepted = await submit({ profile: profile(fixture.patient), records: selected(fixture.systolic, fixture.total) });
      const risk = accepted.receipt.thaiCvRisk;
      assertSafeAssessment(risk); assert.equal(risk.status, "calculated"); assert.equal(risk.level, fixture.level);
      assert.equal(risk.score, calculateThaiCvRisk(accepted.source.profile, { systolic: fixture.systolic, totalCholesterol: fixture.total }, accepted.source.submittedAt).score);
      assert.equal(risk.calculatedAt, accepted.receipt.submittedAt);
      assert.equal(risk.inputs.bloodPressureRecordedAt, accepted.receipt.submittedAt); assert.equal(risk.inputs.cholesterolRecordedAt, accepted.receipt.submittedAt);
      assert.equal(accepted.receipt.reviewStatus, "pending");
      const read = await readReceipt(accepted); assert.deepEqual(read.thaiCvRisk, risk);
      const records = await h.models.Health.find({ submissionKey: accepted.source.internalId });
      assert.equal(records.length, 2); records.forEach(row => { assert.equal(row.reviewStatus, "pending"); assert.equal(row.thaiCvRisk, undefined); });
      assert.equal((await h.models.User.findById(accepted.source.userId)).thaiCvRisk.status, "incomplete");
    }
  });

  test("optional measurements, unanswered history and unsupported measurement ranges remain incomplete with null scores rather than a low-risk result", async () => {
    const complete = profile();
    const unanswered = { ...complete }; delete unanswered.smokingStatus; delete unanswered.chronicDiseasesConfirmed;
    for (const fixture of [
      { records: [], missing: ["systolic", "totalCholesterol"] },
      { records: [selected()[0]], missing: ["totalCholesterol"] },
      { profile: unanswered, missing: ["smokingStatus", "chronicDiseasesConfirmed"] },
      { records: selected(221, 200), missing: ["systolic"] },
      { records: selected(120, 281), missing: ["totalCholesterol"] },
    ]) {
      const { missing, ...overrides } = fixture;
      const accepted = await submit(overrides), risk = accepted.receipt.thaiCvRisk;
      assertSafeAssessment(risk); assert.equal(risk.status, "incomplete"); assert.equal(risk.score, null); assert.equal(risk.level, null);
      missing.forEach(field => assert.ok(risk.missing.includes(field), field));
      assert.deepEqual((await readReceipt(accepted)).thaiCvRisk, risk);
      if (!accepted.payload.records.length) {
        assert.deepEqual(accepted.receipt.recordIds, []); assert.equal(await h.models.Health.countDocuments({ submissionKey: accepted.source.internalId }), 0);
        assert.equal(risk.inputs.bloodPressureRecordedAt, null); assert.equal(risk.inputs.cholesterolRecordedAt, null);
      }
    }
  });

  test("established heart/stroke disease and ages outside the model remain explicitly ineligible", async () => {
    for (const patient of [{ chronicDiseases: ["โรคหัวใจ"] }, { chronicDiseases: ["โรคหลอดเลือดสมอง"] }, { birthDate: "20000315" }, { birthDate: "19400315" }]) {
      const accepted = await submit({ profile: profile(patient) });
      assert.equal(accepted.receipt.thaiCvRisk.status, "ineligible"); assert.equal(accepted.receipt.thaiCvRisk.score, null); assert.equal(accepted.receipt.thaiCvRisk.level, null);
      assert.deepEqual((await readReceipt(accepted)).thaiCvRisk, accepted.receipt.thaiCvRisk);
    }
  });

  test("an existing account's private profile, approved measurements and stored score cannot influence or leak into a new guest assessment", async () => {
    const id = citizenId();
    const official = await h.models.User.create({ citizenId: id, ...profile({ firstName: "Private official name", birthDate: "19600315", chronicDiseases: ["โรคหัวใจ"] }),
      thaiCvRisk: { status: "calculated", score: 99, level: "high" }, isVerified: true, accountEnabled: true });
    const history = await h.models.Health.create([
      { userId: official._id, userKey: official.internalId, citizenId: id, type: "blood_pressure", value: { systolic: 220, diastolic: 100 }, reviewStatus: "approved", thaiCvRisk: { status: "calculated", score: 99, level: "high" } },
      { userId: official._id, userKey: official.internalId, citizenId: id, type: "cholesterol", value: { total: 280 }, reviewStatus: "approved" },
    ]);
    const before = (await h.models.User.findById(official._id)).toObject();
    const historyBefore = await h.models.Health.find({ _id: { $in: history.map(row => row._id) } }).sort({ _id: 1 }).lean();
    const accepted = await submit({ citizenId: id, profile: profile({ birthDate: "19860315", gender: "female" }), records: selected(110, 160), thaiCvRisk: { status: "calculated", score: 0 } });
    assert.equal(accepted.receipt.thaiCvRisk.status, "calculated"); assert.equal(accepted.receipt.thaiCvRisk.level, "low");
    assert.ok(accepted.receipt.thaiCvRisk.score > 0); assert.equal(JSON.stringify(accepted.receipt.thaiCvRisk).includes("Private official name"), false);
    assert.deepEqual((await readReceipt(accepted)).thaiCvRisk, accepted.receipt.thaiCvRisk);
    const missing = await submit({ citizenId: id, records: [] });
    assert.equal(missing.receipt.thaiCvRisk.status, "incomplete"); assert.ok(missing.receipt.thaiCvRisk.missing.includes("systolic")); assert.ok(missing.receipt.thaiCvRisk.missing.includes("totalCholesterol"));
    assert.deepEqual((await h.models.User.findById(official._id)).toObject(), before);
    assert.deepEqual(await h.models.Health.find({ _id: { $in: history.map(row => row._id) } }).sort({ _id: 1 }).lean(), historyBefore);
  });

  test("idempotent retries and receipt reads retain the submitted score and date across a Bangkok birthday", async t => {
    const originalCreate = h.models.Submission.create;
    const mock = t.mock.method(h.models.Submission, "create", function (data, ...args) {
      return originalCreate.call(this, { ...data, submittedAt: new Date("2026-11-01T16:59:00Z") }, ...args);
    });
    const accepted = await submit({ profile: profile({ birthDate: "19761102", gender: "male" }) });
    mock.mock.restore();
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-03T00:00:00Z") });
    const retry = await accepted.client.request("/public/submissions", { anonymous: true, method: "POST", body: accepted.payload });
    assertStatus(retry, 202); assert.deepEqual(retry.body.data.thaiCvRisk, accepted.receipt.thaiCvRisk);
    assert.equal(retry.body.data.submissionId, accepted.receipt.submissionId); assert.equal(retry.body.data.submittedAt, accepted.receipt.submittedAt);
    assert.deepEqual((await readReceipt(accepted)).thaiCvRisk, accepted.receipt.thaiCvRisk);
    assert.notEqual(accepted.receipt.thaiCvRisk.score, calculateThaiCvRisk(accepted.source.profile, { systolic: 120, totalCholesterol: 200 }).score);
    assert.equal(await h.models.Submission.countDocuments({ clientRequestId: accepted.payload.clientRequestId }), 1);
    assert.equal(await h.models.Health.countDocuments({ submissionKey: accepted.source.internalId }), 2);
  });

  test("assessment remains available from the durable snapshot when clinical materialization needs recovery", async t => {
    const mock = t.mock.method(h.models.Health, "updateOne", async () => { throw new Error("Synthetic isolated materialization failure"); });
    const accepted = await submit();
    assert.equal(accepted.receipt.thaiCvRisk.status, "calculated"); assert.equal(accepted.source.materialized, false);
    assert.equal(await h.models.Health.countDocuments({ submissionKey: accepted.source.internalId }), 0);
    assert.deepEqual((await readReceipt(accepted)).thaiCvRisk, accepted.receipt.thaiCvRisk);
    mock.mock.restore();
    const retry = await accepted.client.request("/public/submissions", { anonymous: true, method: "POST", body: accepted.payload });
    assertStatus(retry, 202); assert.deepEqual(retry.body.data.thaiCvRisk, accepted.receipt.thaiCvRisk);
    const rows = await h.models.Health.find({ submissionKey: accepted.source.internalId });
    assert.equal(rows.length, 2); rows.forEach(row => assert.equal(row.thaiCvRisk, undefined));
  });
});
