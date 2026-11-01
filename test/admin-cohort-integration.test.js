const assert = require("node:assert/strict");
const { before, after, describe, test } = require("node:test");
const bcrypt = require("bcrypt");
const { Long, Decimal128, Int32 } = require("mongodb");
const { startWorkflowHarness, assertStatus, profile } = require("./helpers/workflowHarness");
const { installedMongod } = require("./helpers/isolatedMongo");
const ENABLED = process.env.CAREVIGO_WORKFLOW_INTEGRATION === "1";
const binary = ENABLED ? installedMongod() : null;

describe("staff cohort reporting is bounded, unique, BigInt-safe and read-only", {
  skip: !ENABLED ? "Set CAREVIGO_WORKFLOW_INTEGRATION=1 for isolated real MongoDB tests" : !binary ? "No installed mongod" : false,
  concurrency: false, timeout: 180000,
}, () => {
  let h, staff, patient, alice, bob, carol, david, unknown, pastOnly, createdLater, legacy, overdue;
  let citizen = 8500000000000;
  const range = { from: "2026-10-02", to: "2026-10-02" };
  const createUser = overrides => h.models.User.create({ citizenId: String(++citizen), ...profile(),
    createdAt: new Date("2026-01-01T00:00:00Z"), ...overrides });
  const row = (user, overrides = {}) => h.models.Health.create({ userId: user._id, citizenId: user.citizenId,
    type: "sugar", value: { fbs: 95 }, reviewStatus: "approved", createdAt: new Date("2026-10-02T10:00:00Z"), ...overrides });
  async function get(query = {}, client = staff) {
    const result = await client.request(`/dashboard/cohorts?${new URLSearchParams({ ...range, ...query })}`);
    assertStatus(result, 200); return result.body;
  }
  before(async () => {
    h = await startWorkflowHarness(); assert.ok(h); staff = h.newClient("admin"); await staff.loginStaff();
    alice = await createUser({ internalId: 10n, firstName: "Alice", lastName: "A.*[1]", chronicDiseases: ["เบาหวาน", "DIABETES", "ความดัน", "โรคหัวใจ"],
      chronicDiseasesConfirmed: false, passwordHash: await bcrypt.hash("123456", 4), accountEnabled: true, requiresPasswordChange: false,
      email: "PRIVATE-EMAIL", phone: "PRIVATE-PHONE", cancerDetails: "PRIVATE-CANCER", thaiCvRisk: { score: 12.5, status: "calculated", level: "moderate" } });
    bob = await createUser({ firstName: "Bob", chronicDiseases: ["หลอดเลือดสมอง", "มะเร็งเต้านม", "dyslipidemia", "ไต"], province: "ภูเก็ต" });
    carol = await createUser({ firstName: "Carol", chronicDiseases: [], chronicDiseasesConfirmed: true });
    david = await createUser({ firstName: "David", chronicDiseases: ["cancer: lung"], chronicDiseasesConfirmed: false });
    unknown = await createUser({ firstName: "Unknown", chronicDiseases: [], chronicDiseasesConfirmed: false });
    pastOnly = await createUser({ firstName: "Past", chronicDiseases: ["ความดันโลหิตสูง"] });
    createdLater = await createUser({ firstName: "Later", createdAt: new Date("2026-10-02T17:00:00Z"), chronicDiseases: ["เบาหวาน"] });
    legacy = await createUser({ firstName: "Legacy", chronicDiseases: ["heart disease"] });
    await h.models.User.collection.updateOne({ _id: legacy._id }, { $unset: { internalId: 1 } });
    patient = h.newClient(); assertStatus(await patient.request("/auth/patient/login", { method: "POST", body: { citizenId: alice.citizenId, password: "123456" } }), 200);
    await row(alice, { type: "blood_pressure", submittedAt: new Date("2026-10-01T17:00:00.000Z"), createdAt: new Date("2026-10-20T00:00:00Z") });
    overdue = await row(alice, { reviewStatus: "pending", reviewDueAt: new Date("2026-10-02T16:59:00Z") });
    await row(alice, { reviewStatus: "rejected", type: "cholesterol", createdAt: new Date("2026-10-02T11:00:00Z") });
    const missing = await row(alice, { type: "bmi", createdAt: new Date("2026-10-02T12:00:00Z") });
    await h.models.Health.collection.updateOne({ _id: missing._id }, { $unset: { reviewStatus: 1 } });
    const invalid = await row(alice, { type: "unknown_legacy_type", createdAt: new Date("2026-10-02T13:00:00Z") });
    await h.models.Health.collection.updateOne({ _id: invalid._id }, { $set: { reviewStatus: null } });
    await row(alice, { createdAt: new Date("2026-10-01T16:59:59.999Z") });
    await row(alice, { createdAt: new Date("2026-10-02T17:00:00.000Z") });
    const wrongNumeric = await row(alice); await h.models.Health.collection.updateOne({ _id: wrongNumeric._id }, { $set: { userKey: bob.internalId } });
    const dangling = await row(alice); await h.models.Health.collection.updateOne({ _id: dangling._id }, { $set: { userKey: bob.internalId + 999999n } });
    for (const userKey of [null, 10, "10"]) {
      const malformedKey = await row(alice); await h.models.Health.collection.updateOne({ _id: malformedKey._id }, { $set: { userKey } });
    }
    const legacyConflict = await row(alice); await h.models.Health.collection.updateOne({ _id: legacyConflict._id }, { $unset: { userKey: 1 }, $set: { citizenId: bob.citizenId } });
    const citizenOnly = await row(bob); await h.models.Health.collection.updateOne({ _id: citizenOnly._id }, { $unset: { userKey: 1, userId: 1 } });
    await row(bob, { reviewStatus: "pending" }); await row(bob, { reviewStatus: "rejected" });
    const legacyRow = await row(legacy); await h.models.Health.collection.updateOne({ _id: legacyRow._id }, { $unset: { userKey: 1 } });
    await h.models.User.collection.updateOne({ _id: legacy._id }, { $unset: { internalId: 1 } });
    await row(pastOnly, { createdAt: new Date("2026-10-01T10:00:00Z") });
    await row(createdLater);
    const invalidDate = await row(david); await h.models.Health.collection.updateOne({ _id: invalidDate._id }, { $set: { submittedAt: "bad-date" } });
  });
  after(async () => {
    if (!h) return;
    const cleanup = await h.stop(); assert.equal(cleanup.exited, true); assert.equal(cleanup.removed, true);
    console.log(`Admin cohorts cleanup verified: private MongoDB PID ${cleanup.pid} exited and directory removed`);
  });

  test("summary separates people and records, includes non-submitters, and uses unique ownership with Thai day boundaries", async () => {
    const { data } = await get({ limit: "50" });
    assert.equal(data.schemaVersion, 1); assert.equal(data.range.bucket, "day"); assert.equal(data.range.timeZone, "Asia/Bangkok");
    assert.deepEqual(data.summary, { cohortPeople: 7, withRecords: 3, withoutRecords: 4, people: 7,
      total: 11, approved: 6, pending: 2, rejected: 2, unknown: 1,
      byType: { blood_pressure: 1, sugar: 7, cholesterol: 1, bmi: 1, unknown: 1 } });
    assert.equal(data.timeline.length, 1); assert.deepEqual(data.timeline[0], { date: "2026-10-02", people: 3,
      total: 11, approved: 6, pending: 2, rejected: 2, unknown: 1,
      byType: { blood_pressure: 1, sugar: 7, cholesterol: 1, bmi: 1, unknown: 1 } });
    assert.equal(data.people.find(person => person.citizenId === alice.citizenId).counts.total, 6);
    assert.equal(data.people.find(person => person.citizenId === bob.citizenId).counts.total, 4);
    assert.equal(data.people.some(person => person.citizenId === createdLater.citizenId), false);
    assert.equal(data.people.find(person => person.citizenId === carol.citizenId).counts.total, 0);
    assert.equal(data.people.find(person => person.citizenId === carol.citizenId).lastRecordedAt, null);
  });
  test("current reported disease aliases overlap once per person without inventing diagnoses or no-disease confirmations", async () => {
    const all = (await get({ limit: "50" })).data;
    assert.deepEqual(Object.fromEntries(all.diseases.map(item => [item.id, item.people])), {
      diabetes: 1, hypertension: 2, heart: 2, stroke: 1, cancer: 2, dyslipidemia: 1, other: 1, none: 1, unknown: 1,
    });
    assert.deepEqual(new Set(all.people.find(person => person.citizenId === alice.citizenId).diseaseGroups), new Set(["diabetes", "hypertension", "heart"]));
    assert.equal(all.diseaseScope, "current-profile-reported"); assert.equal(all.distributionScope, "search-and-activity-current-profile");
    assert.equal(all.recordedAtScope, "submittedAt-or-createdAt");
    const diabetes = (await get({ disease: "diabetes" })).data;
    assert.equal(diabetes.summary.people, 1); assert.equal(diabetes.summary.total, 6); assert.deepEqual(diabetes.diseases, all.diseases);
    assert.equal((await get({ disease: "none" })).data.people[0].citizenId, carol.citizenId);
    assert.equal((await get({ disease: "unknown" })).data.people[0].citizenId, unknown.citizenId);
  });
  test("recorded and none filters apply consistently while pre-activity coverage remains visible", async () => {
    const yes = (await get({ activity: "recorded", limit: "50" })).data;
    assert.equal(yes.summary.cohortPeople, 7); assert.equal(yes.summary.withRecords, 3); assert.equal(yes.summary.withoutRecords, 4); assert.equal(yes.summary.people, 3); assert.equal(yes.people.length, 3); assert.equal(yes.summary.total, 11);
    assert.equal(yes.diseases.find(item => item.id === "cancer").people, 1);
    const none = (await get({ activity: "none", limit: "50" })).data;
    assert.equal(none.summary.cohortPeople, 7); assert.equal(none.summary.people, 4); assert.equal(none.summary.total, 0); assert.equal(none.people.length, 4); assert.equal(none.timeline[0].people, 0);
    assert.equal(none.people.every(person => person.firstRecordedAt === null && person.lastRecordedAt === null), true);
  });
  test("paginated people are deterministic without shrinking aggregate counts and numeric IDs remain exact decimal strings", async () => {
    const all = (await get({ limit: "50" })).data, seen = [];
    for (let page = 1; page <= 4; page++) {
      const data = (await get({ page: String(page), limit: "2" })).data;
      assert.deepEqual(data.summary, all.summary); assert.deepEqual(data.timeline, all.timeline); assert.deepEqual(data.diseases, all.diseases);
      assert.equal(data.pagination.total, 7); assert.equal(data.pagination.hasMore, page < 4); seen.push(...data.people.map(person => person.citizenId));
    }
    assert.deepEqual(seen, all.people.map(person => person.citizenId)); assert.equal(new Set(seen).size, 7);
    assert.equal(all.people.find(person => person.citizenId === alice.citizenId).internalId, "10");
    assert.equal(all.people.find(person => person.citizenId === bob.citizenId).internalId, bob.internalId.toString());
    assert.equal(BigInt(all.people.find(person => person.citizenId === bob.citizenId).internalId) > 9007199254740993n, true);
    assert.equal(all.people.find(person => person.citizenId === legacy.citizenId).internalId, null);
    assert.deepEqual((await get({ page: "99", limit: "2" })).data.people, []);
  });
  test("search matches literal names, citizen IDs and provinces, never interpreting user regex operators", async () => {
    assert.equal((await get({ search: "A.*[1]" })).data.summary.people, 1);
    assert.equal((await get({ search: "aLiCe" })).data.people[0].citizenId, alice.citizenId);
    assert.equal((await get({ search: "Alice A.*[1]" })).data.people[0].citizenId, alice.citizenId);
    assert.equal((await get({ search: bob.citizenId })).data.people[0].citizenId, bob.citizenId);
    assert.equal((await get({ search: "ภูเก็ต" })).data.people[0].citizenId, bob.citizenId);
    assert.equal((await get({ search: ".*" })).data.summary.people, 1);
    const empty = (await get({ search: "NO MATCH" })).data;
    assert.equal(empty.summary.people, 0); assert.deepEqual(empty.people, []); assert.equal(empty.timeline[0].total, 0); assert.equal(empty.diseases.every(item => item.people === 0), true);
    assert.equal(JSON.stringify((await get()).data).includes("PRIVATE-"), false);
  });
  test("daily and monthly series zero-fill only counts and preserve unique people across multiple records", async () => {
    const daily = (await get({ from: "2026-10-01", to: "2026-10-03", search: alice.citizenId })).data;
    assert.deepEqual(daily.timeline.map(point => point.date), ["2026-10-01", "2026-10-02", "2026-10-03"]);
    assert.deepEqual(daily.timeline.map(point => point.people), [1, 1, 1]);
    assert.deepEqual(daily.timeline.map(point => point.total), [1, 6, 1]);
    const month = (await get({ from: "2026-06-01", to: "2026-10-02", search: alice.citizenId })).data;
    assert.equal(month.range.bucket, "month"); assert.equal(month.timeline.length, 5); assert.deepEqual(month.timeline.map(point => point.date), ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]); assert.equal(month.timeline[0].total, 0);
    assert.equal(month.timeline.at(-1).people, 1); assert.equal(month.timeline.at(-1).total, 7);
    assert.equal(Object.hasOwn(month.timeline[0], "value"), false);
  });
  test("invalid queries fail before any cohort aggregation and error responses never expose database failures", async t => {
    const aggregate = t.mock.method(h.models.User, "aggregate", () => { throw new Error("PRIVATE-DATABASE-ERROR"); });
    for (const query of ["from=2026-10-02", "from=2026-10-02&to=2026-10-02&limit=51", "search[$ne]=x", "disease[]=diabetes", "from=2026-02-29&to=2026-03-01", "page=0", "days=all", "activity=unknown"]) {
      const result = await staff.request(`/dashboard/cohorts?${query}`); assertStatus(result, 400); assert.equal(result.headers.get("cache-control"), "no-store");
    }
    assert.equal(aggregate.mock.callCount(), 0);
    const failure = await staff.request(`/dashboard/cohorts?${new URLSearchParams(range)}`); assertStatus(failure, 500);
    assert.equal(JSON.stringify(failure.body).includes("PRIVATE-"), false);
  });
  test("cohort reads cannot approve overdue reviews, refresh risk, send email or expose private clinical fields", async t => {
    const overdueWorker = t.mock.method(h.review, "approveOverdue", () => { throw new Error("Must not approve"); });
    const risk = require("../src/services/thaiCvRisk.service"); const refresh = t.mock.method(risk, "refreshUserThaiCvRisk", () => { throw new Error("Must not refresh"); });
    const beforeUser = await h.models.User.findById(alice._id).select("+passwordHash").lean(), beforeHealth = await h.models.Health.find({}).lean();
    const data = (await get()).data;
    assert.equal(overdueWorker.mock.callCount(), 0); assert.equal(refresh.mock.callCount(), 0);
    assert.equal((await h.models.Health.findById(overdue._id)).reviewStatus, "pending");
    assert.deepEqual(await h.models.User.findById(alice._id).select("+passwordHash").lean(), beforeUser);
    assert.deepEqual(await h.models.Health.find({}).lean(), beforeHealth);
    assert.equal(h.sentEmails.length, 0); assert.equal(h.sentResetEmails.length, 0);
    const person = data.people.find(item => item.citizenId === alice.citizenId);
    assert.equal(person.value, undefined); assert.equal(person.thaiCvRisk, undefined); assert.equal(person.passwordHash, undefined);
    assert.equal(person.phone, undefined); assert.equal(person.email, undefined); assert.equal(person.cancerDetails, undefined);
  });
  test("current-day snapshots exclude future records and future profile registrations even before the requested day's end", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const later = new Date(Date.now() + 3600000);
    const future = await createUser({ firstName: "Future", createdAt: later });
    await row(future, { createdAt: new Date() });
    await row(carol, { createdAt: later });
    const current = await row(carol, { createdAt: new Date() });
    try {
      const data = (await get({ from: today, to: today, search: carol.citizenId })).data;
      assert.equal(data.summary.people, 1); assert.equal(data.summary.total, 1);
      assert.equal(data.people[0].firstRecordedAt, current.createdAt.toISOString());
      assert.equal((await get({ from: today, to: today, search: future.citizenId })).data.summary.people, 0);
    } finally {
      await h.models.Health.deleteMany({ userId: { $in: [carol._id, future._id] } }); await h.models.User.deleteOne({ _id: future._id });
    }
  });
  test("missing and malformed reported disease arrays cannot be shown as a confirmed absence of disease", async () => {
    const user = await createUser({ firstName: "Malformed", chronicDiseasesConfirmed: true });
    try {
      for (const diseases of [null, "เบาหวาน", { diabetes: true }]) {
        await h.models.User.collection.updateOne({ _id: user._id }, { $set: { chronicDiseases: diseases } });
        const data = (await get({ search: user.citizenId })).data;
        assert.deepEqual(data.people[0].diseaseGroups, ["unknown"]); assert.equal(data.diseases.find(group => group.id === "none").people, 0);
      }
      await h.models.User.collection.updateOne({ _id: user._id }, { $unset: { chronicDiseases: 1 } });
      assert.deepEqual((await get({ search: user.citizenId })).data.people[0].diseaseGroups, ["unknown"]);
      for (const chronicDiseases of [[null, " "], [null, 42]]) {
        await h.models.User.collection.updateOne({ _id: user._id }, { $set: { chronicDiseases } });
        assert.deepEqual((await get({ search: user.citizenId })).data.people[0].diseaseGroups, ["unknown"]);
      }
      await h.models.User.collection.updateOne({ _id: user._id }, { $set: { chronicDiseases: [null, "เบาหวาน", 42] } });
      assert.deepEqual((await get({ search: user.citizenId })).data.people[0].diseaseGroups, ["diabetes"]);
      await h.models.User.collection.updateOne({ _id: user._id }, { $set: { chronicDiseases: [" ", ""] } });
      assert.deepEqual((await get({ search: user.citizenId })).data.people[0].diseaseGroups, ["none"]);
      for (const internalId of [null, 10, "10"]) {
        await h.models.User.collection.updateOne({ _id: user._id }, { $set: { internalId } });
        assert.equal((await get({ search: user.citizenId })).data.people[0].internalId, null);
      }
    } finally { await h.models.User.deleteOne({ _id: user._id }); }
  });
  test("person latest approved categories are bounded, within range and sanitize clinical BSON values without exposing private profile fields", async () => {
    const user = await createUser({ firstName: "Clinical projection" });
    try {
      const sugar = await row(user, { value: { fbs: 95, hba1c: 5.4 }, submittedProfile: { birthDate: "19800101", gender: "female", phone: "PRIVATE-SUBMITTED-PHONE", firstName: "PRIVATE-SUBMITTED-NAME" } });
      await h.models.Health.collection.updateOne({ _id: sugar._id }, { $set: { "value.fbs": Long.fromNumber(95), "value.hba1c": Decimal128.fromString("5.40000001") } });
      await row(user, { value: { fbs: 343 }, reviewStatus: "pending", createdAt: new Date("2026-10-02T15:00:00Z") });
      await row(user, { value: { fbs: 444 }, reviewStatus: "rejected", createdAt: new Date("2026-10-02T16:00:00Z") });
      await row(user, { type: "blood_pressure", value: { systolic: 137, diastolic: 92, pulse: 72 }, createdAt: new Date("2026-10-02T09:00:00Z") });
      await row(user, { type: "blood_pressure", value: { systolic: 140, diastolic: 94 }, createdAt: new Date("2026-10-02T11:00:00Z") });
      const cholesterol = await row(user, { type: "cholesterol", value: { total: 220, ldl: 110, hdl: 55, triglyceride: 0 } });
      await h.models.Health.collection.updateOne({ _id: cholesterol._id }, { $set: { "value.ldl": Infinity, "value.hdl": new Int32(55) } });
      await row(user, { type: "bmi", value: { weight: 60, height: 165 }, weight: 60, height: 165, bmi: 22.04 });
      await row(user, { type: "unknown_legacy_type" });
      await row(user, { type: "blood_pressure", value: { systolic: 190, diastolic: 120 }, createdAt: new Date("2026-10-02T17:00:00Z") });
      const data = (await get({ search: user.citizenId })).data, latest = data.people[0].latestApprovedRecords;
      assert.deepEqual(latest.map(record => record.type), ["blood_pressure", "bmi", "cholesterol", "sugar"]);
      assert.deepEqual(latest[0].value, { systolic: 140, diastolic: 94 }); assert.equal(latest[0].recordedAt, "2026-10-02T11:00:00.000Z");
      assert.equal(latest[1].bmi, 22.04); assert.equal(latest[1].weight, 60); assert.equal(latest[1].height, 165);
      assert.deepEqual(latest[2].value, { total: 220, hdl: 55 }); assert.deepEqual(latest[3].value, {});
      assert.deepEqual(latest[3].submittedProfile, { birthDate: "19800101", gender: "female" });
      assert.equal(JSON.stringify(latest).includes("PRIVATE-"), false); assert.equal(latest.some(record => record.reviewHistory || record._id || record.userKey), false);
      assert.deepEqual((await get({ search: carol.citizenId })).data.people[0].latestApprovedRecords, []);
    } finally { await h.models.Health.deleteMany({ userId: user._id }); await h.models.User.deleteOne({ _id: user._id }); }
  });
  test("staff guard rejects guest and member scopes, bad session IDs, disabled staff and hostile origins", async () => {
    assertStatus(await h.newClient().request("/dashboard/cohorts", { anonymous: true }), 401);
    assertStatus(await patient.request("/dashboard/cohorts"), 403);
    assertStatus(await staff.request("/dashboard/cohorts", { headers: { "X-Carevigo-Session-Id": "wrong" } }), 409);
    assertStatus(await staff.request("/dashboard/cohorts", { headers: { Origin: "https://evil.example.test" } }), 403);
    const disabled = h.newClient("admin"); await disabled.loginStaff();
    await h.models.Admin.updateOne({ _id: h.admins[0]._id }, { isActive: false });
    try { assertStatus(await disabled.request("/dashboard/cohorts"), 401); }
    finally { await h.models.Admin.updateOne({ _id: h.admins[0]._id }, { isActive: true }); }
  });
});
