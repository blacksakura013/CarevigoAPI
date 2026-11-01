const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const agreements = require("./fixtures/legal-agreements.json");
const User = require("../src/models/User");
const Admin = require("../src/models/Admin");
const Health = require("../src/models/Health");
const { pickProfile, safePatient } = require("../src/utils/patientProfile");
const { validPassword } = require("../src/controllers/patient.auth.controller");
process.env.JWT_SECRET = "carevigo-isolated-test-secret";
const citizenId = "1234567890123";
const patientId = "507f1f77bcf86cd799439011";
const account = { _id: patientId, citizenId, firstName: "Test", accountEnabled: true, requiresPasswordChange: false, tokenVersion: 3 };
const documentQuery = value => ({ select: async () => value, then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) });
const patientToken = overrides => jwt.sign({ id: patientId, role: "user", type: "patient", tokenVersion: 3, ...overrides }, process.env.JWT_SECRET, { expiresIn: "1h" });
const adminToken = () => jwt.sign({ id: "507f1f77bcf86cd799439099", role: "admin", type: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

async function serverFor(t) {
  t.mock.method(Admin, "findById", async id => id === "507f1f77bcf86cd799439099"
    ? { _id: id, role: "admin", isActive: true } : null);
  t.mock.method(require("../src/services/review.service"), "approveOverdue", async () => 0);
  const app = express(); app.use(express.json());
  app.use("/api/auth", require("../src/routes/auth.routes"));
  app.use("/api/users", require("../src/routes/user.routes"));
  app.use("/api/public", require("../src/routes/public.routes"));
  app.use("/api/dashboard", require("../src/routes/dashboard.routes"));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async (path, { token, body, method = "GET" } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
}

test("previous public record and member lookup routes now reject anonymous requests", async (t) => {
  const request = await serverFor(t);
  for (const path of [`/users/search?citizenId=${citizenId}`, `/public/health?citizenId=${citizenId}`, "/users/admin", "/dashboard/summary"]) {
    assert.equal((await request(path)).status, 401);
  }
  assert.equal((await request("/public/health", { method: "POST", body: { citizenId, type: "sugar", value: { fbs: 100 } } })).status, 401);
});

test("patient cannot query or write another patient or access staff management", async (t) => {
  t.mock.method(User, "findById", () => documentQuery(account));
  const request = await serverFor(t), token = patientToken();
  assert.equal((await request("/public/health?citizenId=9999999999999", { token })).status, 403);
  assert.equal((await request("/users/search?citizenId=9999999999999", { token })).status, 403);
  assert.equal((await request("/public/health", { token, method: "POST", body: { citizenId: "9999999999999", type: "sugar", value: { fbs: 100 } } })).status, 403);
  for (const path of ["/users/admin", "/dashboard/summary", "/users/507f1f77bcf86cd799439088/full"]) assert.equal((await request(path, { token })).status, 403);
  assert.equal((await request("/users/admin/507f1f77bcf86cd799439088/account", { token, method: "POST", body: {} })).status, 403);
});

test("disabled accounts and revoked token versions cannot read health data", async (t) => {
  const request = await serverFor(t);
  t.mock.method(User, "findById", () => documentQuery(account));
  assert.equal((await request(`/public/health?citizenId=${citizenId}`, { token: patientToken({ tokenVersion: 2 }) })).status, 401);
  User.findById.mock.mockImplementation(() => documentQuery({ ...account, accountEnabled: false }));
  assert.equal((await request(`/public/health?citizenId=${citizenId}`, { token: patientToken() })).status, 401);
});

test("temporary credentials require a change before profile edits or record access", async (t) => {
  t.mock.method(User, "findById", () => documentQuery({ ...account, requiresPasswordChange: true }));
  const request = await serverFor(t), token = patientToken();
  const blocked = await request(`/public/health?citizenId=${citizenId}`, { token });
  assert.equal(blocked.status, 403); assert.equal(blocked.body.code, "PASSWORD_CHANGE_REQUIRED");
  assert.equal((await request("/auth/patient/me", { token, method: "PATCH", body: { firstName: "Changed" } })).status, 403);
});

test("safe profile allowlist cannot alter ownership, roles, verification, or password data", () => {
  const picked = pickProfile({ firstName: "Patient", smokingStatus: "", smokingQuitMonths: null,
    chronicDiseases: ["ไขมันในเลือดสูง"], chronicDiseasesConfirmed: true,
    citizenId: "9999999999999", _id: "other", role: "admin", status: "active", isVerified: true,
    accountEnabled: true, passwordHash: "attack", tokenVersion: 99, thaiCvRisk: { score: 0 } });
  assert.deepEqual(Object.keys(picked).sort(), ["firstName", "smokingStatus", "smokingQuitMonths", "chronicDiseases", "chronicDiseasesConfirmed"].sort());
  const safe = safePatient({ ...account, passwordHash: "private" });
  assert.equal(safe.passwordHash, undefined); assert.equal(safe.tokenVersion, undefined);
});

test("staff provisioning hashes a six-digit code, invalidates sessions and reveals code once", async (t) => {
  let update;
  t.mock.method(User, "findByIdAndUpdate", async (id, changes) => {
    assert.equal(id, patientId); update = changes;
    return { ...account, ...changes.$set, tokenVersion: 4 };
  });
  const request = await serverFor(t);
  const res = await request(`/users/admin/${patientId}/account`, { token: adminToken(), method: "POST", body: { password: "001234" } });
  assert.equal(res.status, 200); assert.equal(res.body.data.temporaryPassword, "001234");
  assert.equal(update.$inc.tokenVersion, 1); assert.equal(update.$set.requiresPasswordChange, true);
  assert.ok(await bcrypt.compare("001234", update.$set.passwordHash));
  assert.equal(res.body.data.patient.passwordHash, undefined); assert.equal(res.body.data.patient.tokenVersion, undefined);
  assert.equal(res.body.data.patient.accountEnabled, true);
});

test("patient can replace temporary PIN and receives a token with the new version", async (t) => {
  const temp = { ...account, requiresPasswordChange: true, passwordHash: await bcrypt.hash("001234", 4) };
  t.mock.method(User, "findById", () => documentQuery(temp));
  t.mock.method(User, "findOneAndUpdate", (filter, changes) => {
    assert.equal(filter.tokenVersion, 3); assert.equal(changes.$inc.tokenVersion, 1);
    return documentQuery({ ...temp, ...changes.$set, tokenVersion: 4 });
  });
  const request = await serverFor(t);
  const res = await request("/auth/patient/change-password", { token: patientToken(), method: "POST", body: { currentPassword: "001234", password: "654321" } });
  assert.equal(res.status, 200); assert.equal(res.body.data.requiresPasswordChange, false);
  assert.equal(jwt.verify(res.body.data.accessToken, process.env.JWT_SECRET).tokenVersion, 4);
  assert.equal(res.body.data.patient.passwordHash, undefined);
});

test("patient password rules accept six-digit PINs or eight characters within bcrypt's byte limit", () => {
  assert.equal(validPassword("001234"), true); assert.equal(validPassword("long-password"), true);
  assert.equal(validPassword("12345"), false); assert.equal(validPassword("abcdef"), false);
  assert.equal(validPassword("ก".repeat(25)), false); assert.equal(validPassword("a".repeat(73)), false);
});

test("successful patient login returns a signed scoped token and safe account flags", async (t) => {
  const patient = { ...account, passwordHash: await bcrypt.hash("001234", 4), requiresPasswordChange: true };
  t.mock.method(User, "findOne", () => documentQuery(patient));
  const request = await serverFor(t);
  const res = await request("/auth/patient/login", { method: "POST", body: { citizenId, password: "001234" } });
  assert.equal(res.status, 200);
  const payload = jwt.verify(res.body.data.accessToken, process.env.JWT_SECRET);
  assert.equal(payload.type, "patient"); assert.equal(payload.role, "user"); assert.equal(payload.id, patientId);
  assert.equal(res.body.data.requiresPasswordChange, true);
  assert.equal(res.body.data.patient.passwordHash, undefined); assert.equal(res.body.data.patient.tokenVersion, undefined);
});

test("me is available before forced password change without returning credential fields", async (t) => {
  t.mock.method(User, "findById", () => documentQuery({ ...account, requiresPasswordChange: true }));
  t.mock.method(Health, "findOne", () => ({ sort: async () => null }));
  t.mock.method(User, "findByIdAndUpdate", async () => account);
  const request = await serverFor(t);
  const res = await request("/auth/patient/me", { token: patientToken() });
  assert.equal(res.status, 200); assert.equal(res.body.data.requiresPasswordChange, true);
  assert.equal(res.body.data.patient.tokenVersion, undefined);
  assert.equal(res.body.data.thaiCvRisk.status, "incomplete");
});

test("own profile PATCH ignores forged account fields and recalculates risk from stored measurements", async (t) => {
  let current = { ...account }, profileChanges;
  t.mock.method(User, "findById", () => documentQuery(current));
  t.mock.method(User, "findByIdAndUpdate", async (id, update) => {
    assert.equal(String(id), patientId);
    if (update.$set.firstName) profileChanges = update.$set;
    current = { ...current, ...update.$set };
    return current;
  });
  t.mock.method(Health, "findOne", () => ({ sort: async () => null }));
  const request = await serverFor(t);
  const res = await request("/auth/patient/me", { token: patientToken(), method: "PATCH", body: {
    agreements: agreements.patient,
    firstName: "Updated", citizenId: "9999999999999", passwordHash: "forged", role: "admin", status: "active", tokenVersion: 77,
    smokingStatus: "former", chronicDiseases: ["diabetes"], chronicDiseasesConfirmed: true
  } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.patient.citizenId, citizenId);
  assert.deepEqual(profileChanges.chronicDiseases, ["เบาหวาน"]);
  for (const key of ["citizenId", "passwordHash", "role", "status", "tokenVersion"]) assert.equal(profileChanges[key], undefined);
  assert.equal(res.body.data.thaiCvRisk.inputs.diabetes, true);
});

test("staff registration cannot mass assign patient credential fields", async (t) => {
  let created;
  t.mock.method(User, "findOne", async () => null);
  t.mock.method(User, "create", async data => { created = { ...data, _id: patientId }; return created; });
  const request = await serverFor(t);
  const res = await request("/users/admin", { token: adminToken(), method: "POST", body: {
    agreements: agreements.staff,
    citizenId, firstName: "New", passwordHash: "forged", accountEnabled: true, tokenVersion: 20, requiresPasswordChange: false,
    thaiCvRisk: { status: "calculated", score: 0 }
  } });
  assert.equal(res.status, 200);
  for (const key of ["passwordHash", "accountEnabled", "tokenVersion", "requiresPasswordChange"]) assert.equal(created[key], undefined);
  assert.equal(created.thaiCvRisk.status, "incomplete");
});

test("grouped health saves snapshot real risk and me refreshes from the latest persisted measurements", async (t) => {
  t.mock.method(require("../src/services/internalIds.service"), "ensureInternalId", async () => 42n);
  const patient = { ...account, birthDate: "19761101", gender: "male", smokingStatus: "current",
    chronicDiseases: ["เบาหวาน"], chronicDiseasesConfirmed: true };
  const rows = [];
  let latestRisk;
  t.mock.method(User, "findById", () => documentQuery(patient));
  t.mock.method(User, "findOne", async () => patient);
  t.mock.method(User, "findByIdAndUpdate", async (id, update) => { latestRisk = update.$set.thaiCvRisk; return patient; });
  t.mock.method(Health, "create", async data => { const row = { ...data, _id: String(rows.length + 1) }; rows.push(row); return row; });
  t.mock.method(Health, "findOne", filter => ({ sort: async () => rows.filter(row => row.type === filter.type).at(-1) || null }));
  t.mock.method(Health, "findByIdAndUpdate", async (id, update) => Object.assign(rows.find(row => row._id === id), update.$set));
  const request = await serverFor(t), token = patientToken();
  const outcomes = await Promise.all([
    request("/public/health", { token, method: "POST", body: { citizenId, agreements: agreements.patient, type: "blood_pressure", value: { systolic: 150, diastolic: 90 } } }),
    request("/public/health", { token, method: "POST", body: { citizenId, agreements: agreements.patient, type: "cholesterol", value: { total: 240 } } })
  ]);
  assert.deepEqual(outcomes.map(result => result.status), [200, 200]);
  const me = await request("/auth/patient/me", { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.data.thaiCvRisk.status, "calculated");
  assert.equal(me.body.data.thaiCvRisk.inputs.systolic, 150);
  assert.equal(me.body.data.thaiCvRisk.inputs.totalCholesterol, 240);
  assert.equal(latestRisk.score, me.body.data.thaiCvRisk.score);
  assert.ok(rows.every(row => row.thaiCvRisk));
});

test("staff can generate a temporary six-digit code without supplying one", async (t) => {
  let storedHash;
  t.mock.method(User, "findByIdAndUpdate", async (id, update) => { storedHash = update.$set.passwordHash; return { ...account, ...update.$set }; });
  const request = await serverFor(t);
  const res = await request(`/users/admin/${patientId}/account`, { token: adminToken(), method: "POST", body: {} });
  assert.equal(res.status, 200);
  assert.match(res.body.data.temporaryPassword, /^\d{6}$/);
  assert.ok(await bcrypt.compare(res.body.data.temporaryPassword, storedHash));
});

test("repeated wrong credentials lock account attempts briefly without enumerating existence", async (t) => {
  t.mock.method(User, "findOne", () => documentQuery(null));
  const request = await serverFor(t);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await request("/auth/patient/login", { method: "POST", body: { citizenId: "1111111111111", password: "123456" } });
    assert.equal(res.status, 401);
  }
  const locked = await request("/auth/patient/login", { method: "POST", body: { citizenId: "1111111111111", password: "123456" } });
  assert.equal(locked.status, 429);
});
