// Public prefill and existing private routes on isolated real HTTP/MongoDB.
const assert = require("node:assert/strict");
const { describe, test, before, after } = require("node:test");
const bcrypt = require("bcrypt");
const { startWorkflowHarness, assertStatus, profile } = require("./helpers/workflowHarness");
const { installedMongod } = require("./helpers/isolatedMongo");
const ENABLED = process.env.CAREVIGO_WORKFLOW_INTEGRATION === "1";
const binary = ENABLED ? installedMongod() : null;
const fields = ["birthDate", "firstName", "gender", "lastName", "phone"];

describe("anonymous personal prefill exposes only approved official personal fields", {
  skip: !ENABLED ? "Set CAREVIGO_WORKFLOW_INTEGRATION=1 for isolated real MongoDB tests" : !binary ? "No installed mongod" : false,
  concurrency: false, timeout: 180000,
}, () => {
  let h, nextCitizen = 8600000000000;
  const citizenId = () => String(++nextCitizen);
  before(async () => { h = await startWorkflowHarness(); assert.ok(h); });
  after(async () => {
    if (!h) return;
    const cleanup = await h.stop(); assert.equal(cleanup.exited, true); assert.equal(cleanup.removed, true);
    console.log(`Public profile cleanup verified: private MongoDB PID ${cleanup.pid} exited and directory removed`);
  });
  const lookup = (id, client = h.newClient()) => client.request(`/public/patient-profile?citizenId=${id}`, { anonymous: true });
  const createOfficial = (overrides = {}) => h.models.User.create({ citizenId: citizenId(), ...profile(),
    phone: "0800000030", status: "active", isVerified: true, accountEnabled: false, ...overrides });

  test("an anonymous lookup returns exactly five projected personal fields without IDs, account data, clinical history or submitted snapshots", async () => {
    const official = await createOfficial({ firstName: "Official fixture", gender: "หญิง", birthDate: "19750315", email: "private-profile@example.test",
      lineId: "private-line", address: "private-address", smokingStatus: "current", chronicDiseases: ["เบาหวาน"], cancerDetails: "private-cancer",
      thaiCvRisk: { status: "calculated", score: 35, level: "high" }, passwordHash: "synthetic-non-login-hash", tokenVersion: 4 });
    await h.models.Health.create({ userId: official._id, userKey: official.internalId, citizenId: official.citizenId,
      type: "sugar", value: { fbs: 999 }, reviewStatus: "approved" });
    const pending = await h.newClient().request("/public/submissions", { anonymous: true, method: "POST", body: h.guestPayload(official.citizenId,
      { records: [], profile: profile({ firstName: "Unreviewed snapshot", phone: "0800000099" }) }) });
    assertStatus(pending, 202);
    const result = await lookup(official.citizenId);
    assertStatus(result, 200); assert.equal(result.headers.get("cache-control"), "no-store");
    assert.deepEqual(Object.keys(result.body.data).sort(), fields);
    assert.deepEqual(result.body.data, { firstName: "Official fixture", lastName: official.lastName, gender: "หญิง", birthDate: "19750315", phone: "0800000030" });
    const serialized = JSON.stringify(result.body);
    for (const secret of [official.citizenId, String(official._id), String(official.internalId), "private-profile@example.test", "private-line", "private-address", "private-cancer", "Unreviewed snapshot", "0800000099"])
      assert.equal(serialized.includes(secret), false);
    for (const name of ["citizenId", "internalId", "_id", "email", "passwordHash", "tokenVersion", "smokingStatus", "chronicDiseases", "thaiCvRisk", "legalAgreement", "records", "accountEnabled"])
      assert.equal(result.body.data[name], undefined);
    assert.equal((await h.models.User.findById(official._id)).accountEnabled, false);
  });

  test("unknown, pending, rejected and unverified profiles are indistinguishable null results and lookups never create a patient", async () => {
    const beforeCount = await h.models.User.countDocuments(), missingId = citizenId();
    const unknown = await lookup(missingId);
    assertStatus(unknown, 200); assert.equal(unknown.body.data, null); assert.equal(unknown.headers.get("cache-control"), "no-store");
    assert.equal(await h.models.User.countDocuments(), beforeCount);
    for (const state of [{ status: "pending", isVerified: false }, { status: "pending", isVerified: true }, { status: "rejected", isVerified: true }, { status: "active", isVerified: false }]) {
      const person = await createOfficial(state), result = await lookup(person.citizenId);
      assertStatus(result, 200); assert.deepEqual(result.body, unknown.body); assert.equal(result.headers.get("cache-control"), "no-store");
    }
  });

  test("invalid IDs, duplicate/array/operator queries and extra filters are rejected before any database query without reflecting the supplied ID", async t => {
    const find = t.mock.method(h.models.User, "findOne", () => { throw new Error("Invalid lookup must not reach a model"); });
    const valid = citizenId();
    for (const query of ["", "citizenId=123456789012", "citizenId=12345678901234", "citizenId=not-a-number",
      `citizenId=${valid}&citizenId=${valid}`, `citizenId[]=${valid}`, "citizenId[$ne]=", `citizenId=${valid}&where=anything`, `citizenId=${valid}&filter[status]=active`]) {
      const result = await h.newClient().request(`/public/patient-profile${query ? `?${query}` : ""}`, { anonymous: true });
      assertStatus(result, 400); assert.equal(result.body.data, null); assert.equal(result.headers.get("cache-control"), "no-store");
      assert.equal(JSON.stringify(result.body).includes(valid), false);
    }
    assert.equal(find.mock.callCount(), 0);
  });

  test("public lookup has a separate ten-per-minute IP limit with JSON429, Retry-After and no-store", async () => {
    const official = await createOfficial(), client = h.newClient();
    for (let i = 0; i < 10; i++) assertStatus(await lookup(official.citizenId, client), 200);
    const limited = await lookup(official.citizenId, client);
    assertStatus(limited, 429); assert.equal(limited.body.data, null); assert.equal(limited.headers.get("cache-control"), "no-store");
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal(JSON.stringify(limited.body).includes(official.citizenId), false);
    const submitted = await client.request("/public/submissions", { anonymous: true, method: "POST", body: h.guestPayload(citizenId(), { records: [] }) });
    assertStatus(submitted, 202);
  });

  test("the new public five-field route does not weaken authenticated full-profile search or health-history ownership", async () => {
    const official = await createOfficial({ accountEnabled: true, passwordHash: await bcrypt.hash("123456", 4), requiresPasswordChange: false });
    const other = await createOfficial(), anonymous = h.newClient();
    assertStatus(await anonymous.request(`/users/search?citizenId=${official.citizenId}`, { anonymous: true }), 401);
    assertStatus(await anonymous.request(`/public/health?citizenId=${official.citizenId}`, { anonymous: true }), 401);
    const patient = h.newClient();
    assertStatus(await patient.request("/auth/patient/login", { method: "POST", scope: "patient", body: { citizenId: official.citizenId, password: "123456" } }), 200);
    assertStatus(await patient.request(`/users/search?citizenId=${official.citizenId}`), 200);
    assertStatus(await patient.request(`/users/search?citizenId=${other.citizenId}`), 403);
    assertStatus(await patient.request(`/public/health?citizenId=${other.citizenId}`), 403);
    const staff = h.newClient("admin"); await staff.loginStaff();
    assertStatus(await staff.request(`/users/search?citizenId=${other.citizenId}`), 200);
  });

  test("a database failure returns a generic noncached error without logging or reflecting raw patient data", async t => {
    const id = citizenId(), raw = `Synthetic private database detail ${id}`;
    const logged = ["log", "warn", "error"].map(method => t.mock.method(console, method, () => {}));
    t.mock.method(h.models.User, "findOne", () => { throw new Error(raw); });
    const result = await lookup(id);
    assertStatus(result, 500); assert.equal(result.body.data, null); assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(JSON.stringify(result.body).includes(id), false); assert.equal(JSON.stringify(result.body).includes(raw), false);
    for (const logger of logged) assert.equal(JSON.stringify(logger.mock.calls.map(call => call.arguments)).includes(id), false);
  });
});
