const assert = require("node:assert/strict");
const { describe, test, before, after } = require("node:test");
const bcrypt = require("bcrypt");
const { Long, Decimal128 } = require("mongodb");
const { startWorkflowHarness, assertStatus, profile } = require("./helpers/workflowHarness");
const { installedMongod } = require("./helpers/isolatedMongo");
const ENABLED = process.env.CAREVIGO_WORKFLOW_INTEGRATION === "1";
const binary = ENABLED ? installedMongod() : null;

describe("staff dashboard health filtering covers the complete persisted record set", {
  skip: !ENABLED ? "Set CAREVIGO_WORKFLOW_INTEGRATION=1 for isolated real MongoDB tests" : !binary ? "No installed mongod" : false,
  concurrency: false, timeout: 180000,
}, () => {
  let h, staff, ann, riskOwner, alpha, zed, ownerA, ownerB, smallOwner, smallRecord;
  let nextCitizen = 8400000000000;
  const all = [], searched = [], scores = [], bmiRows = [];
  const sameDate = new Date("2026-11-01T01:00:00Z");
  let legacyApproved, keyed, legacyOwner, dangling;
  const createUser = overrides => h.models.User.create({ citizenId: String(++nextCitizen), ...profile(), status: "active", isVerified: true, ...overrides });
  async function row(user, overrides = {}) {
    const record = await h.models.Health.create({ userId: user._id, citizenId: user.citizenId, type: "sugar", value: { fbs: 95 },
      source: "admin", reviewStatus: "approved", createdAt: sameDate, ...overrides });
    all.push(record); return record;
  }
  async function get(query = {}, client = staff) {
    const result = await client.request(`/dashboard/health?${new URLSearchParams(query)}`);
    assertStatus(result, 200); return result.body;
  }
  const ids = records => records.map(record => String(record._id));
  before(async () => {
    h = await startWorkflowHarness(); assert.ok(h); staff = h.newClient("admin"); await staff.loginStaff();
    ann = await createUser({ firstName: "Ann", lastName: "[care]", province: "Literal province [safe]", phone: "0800000001" });
    const other = await createUser({ firstName: "Ann", lastName: "care", province: "Other province" });
    for (let index = 0; index < 25; index++) await row(other, { createdAt: new Date("2026-11-01T02:00:00Z") });
    searched.push(await row(ann, { type: "blood_pressure", value: { systolic: 137, diastolic: 92 }, reviewStatus: "pending",
      source: "guest", submittedProfile: { firstName: "Submitted name", birthDate: "19761101", gender: "male" },
      submittedAt: sameDate, reviewHistory: [{ status: "pending", source: "guest" }] }));
    searched.push(await row(ann, { reviewStatus: "rejected" }));
    legacyApproved = await row(ann);
    await h.models.Health.collection.updateOne({ _id: legacyApproved._id }, { $unset: { reviewStatus: 1 } });
    searched.push(legacyApproved);

    riskOwner = await createUser({ firstName: "Risk", lastName: "[row]" });
    for (const score of [0, 9.9999, 10, 20, 20.0001, 100]) {
      scores.push(await row(riskOwner, { type: "cholesterol", value: { total: 210 },
        thaiCvRisk: { status: "calculated", score, level: score < 10 ? "high" : "low" } }));
    }
    for (const value of [null, -1, 101, NaN, Infinity, "12", true,
      Long.fromNumber(0), Long.fromNumber(10), Long.fromNumber(100),
      Decimal128.fromString("0"), Decimal128.fromString("20.0000000000000000000000000001"), Decimal128.fromString("100")]) {
      const record = await row(riskOwner, { thaiCvRisk: { status: "calculated", score: 12 } });
      await h.models.Health.collection.updateOne({ _id: record._id }, { $set: { "thaiCvRisk.score": value } });
    }
    await row(riskOwner, { thaiCvRisk: { status: "incomplete", score: 12 } });
    await row(riskOwner);
    for (const level of ["underweight", "normal", "risk_low", "risk_medium", "risk_high"]) {
      bmiRows.push(await row(ann, { type: "bmi", value: { weight: 60, height: 165 }, bmi: 22.04, cvdRisk: { level } }));
    }
    alpha = await createUser({ firstName: "Alpha", lastName: "NameSortGroup" });
    zed = await createUser({ firstName: "Zed", lastName: "NameSortGroup" });
    await row(alpha); await row(alpha); await row(zed);
    ownerA = await createUser({ firstName: "Legacy identity", lastName: "Owner A" });
    ownerB = await createUser({ firstName: "Numeric identity", lastName: "Owner B" });
    keyed = await row(ownerA);
    await h.models.Health.collection.updateOne({ _id: keyed._id }, { $set: { userKey: ownerB.internalId } });
    legacyOwner = await row(ownerA);
    await h.models.Health.collection.updateOne({ _id: legacyOwner._id }, { $unset: { userKey: 1 } });
    dangling = await row(ownerA);
    await h.models.Health.collection.updateOne({ _id: dangling._id }, { $set: { userKey: ownerB.internalId + 999999n } });
    smallOwner = await createUser({ internalId: 10n, firstName: "Small exact", lastName: "IDs" });
    smallRecord = await row(smallOwner, { internalId: 11n });
  });
  after(async () => {
    if (!h) return;
    const cleanup = await h.stop(); assert.equal(cleanup.exited, true); assert.equal(cleanup.removed, true);
    console.log(`Dashboard health cleanup verified: private MongoDB PID ${cleanup.pid} exited and directory removed`);
  });

  test("full-name, citizen ID and province search match beyond the first twenty rows and regex characters stay literal", async () => {
    const baseline = await get({ limit: "20" });
    assert.equal(baseline.data.records.some(record => searched.some(source => String(source._id) === record._id)), false);
    for (const search of ["Ann [care]", ann.citizenId, "Literal province [safe]"]) {
      const result = await get({ search, limit: "100" });
      assert.equal(result.total, searched.length + bmiRows.length);
      assert.equal(result.data.records.every(record => record.user._id === String(ann._id)), true);
      assert.equal(result.data.summaryScope, "all"); assert.deepEqual(result.data.summary, baseline.data.summary);
    }
    const literal = await get({ search: ".*", limit: "100" }); assert.equal(literal.total, 0); assert.deepEqual(literal.data.records, []);
    const exact = await get({ search: "[care]", type: "blood_pressure" });
    assert.equal(exact.total, 1); assert.equal(exact.data.records[0]._id, String(searched[0]._id));
    assert.deepEqual(exact.data.records[0].submittedProfile, { firstName: "Submitted name", birthDate: "19761101", gender: "male" });
    assert.equal(exact.data.records[0].user.gender, ann.gender); assert.equal(exact.data.records[0].user.birthDate, ann.birthDate);
    for (const field of ["passwordHash", "tokenVersion", "email", "chronicDiseases", "legalAgreement"]) assert.equal(exact.data.records[0].user[field], undefined);
  });

  test("review and legacy BMI filters combine before pagination and approved includes rows without a stored review status", async () => {
    const approved = await get({ search: ann.citizenId, type: "sugar", reviewStatus: "approved" });
    assert.equal(approved.total, 1); assert.equal(approved.data.records[0]._id, String(legacyApproved._id)); assert.equal(approved.data.records[0].reviewStatus, "approved");
    for (const status of ["pending", "rejected"]) {
      const result = await get({ search: ann.citizenId, reviewStatus: status });
      assert.equal(result.total, 1); assert.equal(result.data.records[0].reviewStatus, status);
    }
    for (const source of bmiRows) {
      const result = await get({ search: ann.citizenId, type: "bmi", reviewStatus: "approved", bmiLevel: source.cvdRisk.level });
      assert.equal(result.total, 1); assert.equal(result.data.records[0]._id, String(source._id));
    }
  });

  test("Thai CV filters use valid stored scores with exact10/20 boundaries instead of stale labels or BMI categories", async () => {
    for (const [riskLevel, expected] of [["low", scores.slice(0, 2)], ["moderate", scores.slice(2, 4)], ["high", scores.slice(4, 6)]]) {
      const result = await get({ search: "Risk [row]", riskLevel, limit: "100" });
      assert.equal(result.total, 2); assert.deepEqual(result.data.records.map(record => record._id).sort(), ids(expected).sort());
    }
    const unavailable = await get({ search: "Risk [row]", riskLevel: "unavailable", limit: "100" });
    assert.equal(unavailable.total, 15); assert.equal(unavailable.data.records.some(record => ids(scores).includes(record._id)), false);
    const combined = await get({ search: "Risk [row]", type: "cholesterol", reviewStatus: "approved", riskLevel: "moderate", bmiLevel: "all", limit: "1" });
    assert.equal(combined.total, 2); assert.equal(combined.data.records.length, 1); assert.equal(combined.hasMore, true);
  });

  test("risk sorting keeps all unavailable scores last in either direction and returns deterministic pages", async () => {
    for (const sort of ["risk_asc", "risk_desc"]) {
      const result = await get({ search: "Risk [row]", sort, limit: "100" });
      const expected = sort === "risk_asc" ? scores : [...scores].reverse();
      assert.deepEqual(result.data.records.slice(0, 6).map(record => record._id), ids(expected));
      assert.equal(result.data.records.length, 21);
      const first = await get({ search: "Risk [row]", sort, limit: "1", page: "1" });
      const second = await get({ search: "Risk [row]", sort, limit: "1", page: "2" });
      assert.equal(first.data.records[0]._id, String(expected[0]._id)); assert.equal(second.data.records[0]._id, String(expected[1]._id));
    }
  });

  test("name and chronological sorts break ties by record ID and page totals remain filtered", async () => {
    const matching = all.filter(record => [String(alpha._id), String(zed._id)].includes(String(record.userId)));
    const alphaRows = matching.filter(record => String(record.userId) === String(alpha._id)).sort((a, b) => String(b._id).localeCompare(String(a._id)));
    const expectedName = [...alphaRows, ...matching.filter(record => String(record.userId) === String(zed._id))];
    const got = [];
    for (let page = 1; page <= 3; page++) {
      const result = await get({ search: "NameSortGroup", sort: "name", page: String(page), limit: "1" });
      assert.equal(result.total, 3); assert.equal(result.hasMore, page < 3); got.push(result.data.records[0]._id);
    }
    assert.deepEqual(got, ids(expectedName));
    for (const sort of ["newest", "oldest"]) {
      const result = await get({ search: "NameSortGroup", sort, limit: "100" });
      const expected = [...matching].sort((a, b) => String(a._id).localeCompare(String(b._id)) * (sort === "oldest" ? 1 : -1));
      assert.deepEqual(result.data.records.map(record => record._id), ids(expected));
    }
    const beyond = await get({ search: "NameSortGroup", page: "4", limit: "1" });
    assert.equal(beyond.total, 3); assert.deepEqual(beyond.data.records, []); assert.equal(beyond.hasMore, false);
  });

  test("numeric ownership outranks conflicting legacy identity, while missing numeric links retain ObjectId owners and exact ID strings", async () => {
    const numeric = await get({ search: ownerB.citizenId });
    assert.equal(numeric.total, 1); const record = numeric.data.records[0];
    assert.equal(record._id, String(keyed._id)); assert.equal(record.user._id, String(ownerB._id));
    assert.equal(record.internalId, keyed.internalId.toString()); assert.equal(record.userKey, ownerB.internalId.toString());
    assert.equal(record.user.internalId, ownerB.internalId.toString()); assert.ok(BigInt(record.userKey) > 9007199254740993n);
    const legacy = await get({ search: ownerA.citizenId });
    assert.equal(legacy.total, 1); assert.equal(legacy.data.records[0]._id, String(legacyOwner._id));
    const baseline = await get({ limit: "100" });
    assert.equal(baseline.data.records.find(row => row._id === String(dangling._id)).user, null);
    assert.equal(baseline.total, all.length);
    const small = await get({ search: smallOwner.citizenId });
    assert.equal(small.total, 1); assert.equal(small.data.records[0]._id, String(smallRecord._id));
    assert.equal(small.data.records[0].internalId, "11"); assert.equal(small.data.records[0].userKey, "10");
    assert.equal(small.data.records[0].user.internalId, "10");
  });

  test("invalid queries cannot forward operators, fractional/overflow pages, invalid enums or unbounded limits into MongoDB", async t => {
    const aggregate = t.mock.method(h.models.Health, "aggregate", () => { throw new Error("Invalid input must not query the database"); });
    for (const query of ["page=0", "page=-1", "page=1.5", "page=2junk", "page=9007199254740992", "page=9007199254740991&limit=100",
      "limit=0", "limit=101", "limit=1e2", "limit[]=20", "type[$ne]=sugar", "type=other", "reviewStatus=no", "riskLevel=urgent", "bmiLevel=high", "sort=random",
      `search=${"x".repeat(101)}`, "search[$regex]=x", "where=anything"]) {
      const result = await staff.request(`/dashboard/health?${query}`); assertStatus(result, 400); assert.equal(result.headers.get("cache-control"), "no-store");
    }
    assert.equal(aggregate.mock.callCount(), 0);
  });

  test("anonymous and patient callers cannot access the enhanced staff table, while either staff role can", async () => {
    assertStatus(await h.newClient().request("/dashboard/health", { anonymous: true }), 401);
    const patient = await createUser({ accountEnabled: true, requiresPasswordChange: false, passwordHash: await bcrypt.hash("123456", 4) });
    const client = h.newClient();
    assertStatus(await client.request("/auth/patient/login", { method: "POST", body: { citizenId: patient.citizenId, password: "123456" } }), 200);
    assertStatus(await client.request("/dashboard/health"), 403);
    const reviewer = h.newClient("admin");
    assertStatus(await reviewer.request("/auth/login", { method: "POST", body: { email: h.admins[1].email, password: "workflow-staff-password" } }), 200);
    assertStatus(await reviewer.request("/dashboard/health?limit=1"), 200);
  });
});
