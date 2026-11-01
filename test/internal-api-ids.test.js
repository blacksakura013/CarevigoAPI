const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { Long } = require("mongodb");
const User = require("../src/models/User");
const Admin = require("../src/models/Admin");
const Health = require("../src/models/Health");
const ids = require("../src/services/internalIds.service");
const { jsonReplacer, jsonSafe } = require("../src/utils/json");
const { healthForUser } = require("../src/utils/internalQueries");
const auth = require("../src/middleware/auth.middleware");
const patientController = require("../src/controllers/patient.auth.controller");
const publicController = require("../src/controllers/public.controller");

process.env.JWT_SECRET = "isolated-bigint-api-test";
process.env.JWT_REFRESH_SECRET = "isolated-bigint-refresh-test";
const key = 9007199254740993n;
const patient = { _id: "507f1f77bcf86cd799439011", internalId: key, citizenId: "0123456789012",
  tokenVersion: 3, accountEnabled: true, requiresPasswordChange: false };
const query = value => ({ select: async () => value, then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) });
const token = overrides => jwt.sign({ id: patient._id, internalId: String(key), type: "patient", role: "user", tokenVersion: 3,
  ...overrides }, process.env.JWT_SECRET, { expiresIn: "1h" });

test("legacy clinical joins exclude rows already linked to a different numeric account", () => {
  assert.deepEqual(healthForUser({ _id: patient._id, citizenId: patient.citizenId }), {
    $and: [{ userKey: { $exists: false } }, { $or: [{ userId: patient._id }, { citizenId: patient.citizenId }] }]
  });
});

async function serverFor(t, configure) {
  const app = express(); app.set("json replacer", jsonReplacer); app.use(express.json());
  configure(app);
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async (path, { accessToken, body, method = "GET" } = {}) => {
    const result = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: result.status, body: await result.json() };
  };
}

test("HTTP JSON preserves native/BSON 64-bit IDs and ordinary measurements/counts", async t => {
  const value = { internalId: key, nested: [{ userKey: 9223372036854775807n, submissionKey: Long.fromString(String(key)) }],
    total: 12, value: { hba1c: 6.7 }, citizenId: patient.citizenId, createdAt: new Date("2026-01-01Z") };
  const request = await serverFor(t, app => app.get("/", (req, res) => res.json(value)));
  const response = await request("/");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, jsonSafe(value));
  assert.equal(response.body.internalId, "9007199254740993");
  assert.equal(response.body.nested[0].userKey, "9223372036854775807");
  assert.equal(response.body.nested[0].submissionKey, "9007199254740993");
  assert.equal(response.body.total, 12); assert.equal(response.body.value.hba1c, 6.7);
  assert.equal(response.body.citizenId, "0123456789012");
});

test("patient authentication queries exact BigInt and rejects conflicting public identity", async t => {
  let result = patient;
  t.mock.method(User, "findOne", filter => { assert.deepEqual(filter, { internalId: key }); return query(result); });
  const legacy = t.mock.method(User, "findById", () => { throw new Error("Unexpected legacy fallback"); });
  const request = await serverFor(t, app => app.get("/", auth, (req, res) => res.json({ internalId: req.user.internalId })));
  assert.deepEqual(await request("/", { accessToken: token() }), { status: 200, body: { internalId: String(key) } });
  result = { ...patient, _id: "507f1f77bcf86cd799439099" };
  assert.equal((await request("/", { accessToken: token() })).status, 401);
  result = null;
  assert.equal((await request("/", { accessToken: token() })).status, 401);
  assert.equal(legacy.mock.callCount(), 0);
});

test("invalid signed internal claims fail before querying the database", async t => {
  const find = t.mock.method(User, "findOne", () => { throw new Error("Unexpected query"); });
  const legacy = t.mock.method(User, "findById", () => { throw new Error("Unexpected query"); });
  const request = await serverFor(t, app => app.get("/", auth, (req, res) => res.json({ ok: true })));
  for (const internalId of [0, -1, Number(key), "0", "-1", "01", "1e3", "9223372036854775808", {}, null]) {
    assert.equal((await request("/", { accessToken: token({ internalId }) })).status, 401);
  }
  assert.equal(find.mock.callCount(), 0); assert.equal(legacy.mock.callCount(), 0);
});

test("staff keyed tokens check exact account identity and active account", async t => {
  const admin = { _id: patient._id, internalId: key, role: "admin", isActive: true, tokenVersion: 3 };
  let current = admin;
  t.mock.method(Admin, "findOne", async filter => { assert.deepEqual(filter, { internalId: key, isActive: true }); return current; });
  const request = await serverFor(t, app => app.get("/", auth, (req, res) => res.json({ internalId: req.user.internalId })));
  const accessToken = token({ type: "admin", role: "admin" });
  assert.equal((await request("/", { accessToken })).status, 200);
  current = null;
  assert.equal((await request("/", { accessToken })).status, 401);
});

test("legacy staff Bearer tokens retain their format but recheck active status and current role", async t => {
  let account = { _id: patient._id, role: "superadmin", isActive: true };
  t.mock.method(Admin, "findById", async value => { assert.equal(value, patient._id); return account; });
  const request = await serverFor(t, app => app.get("/", auth, (req, res) => res.json({ role: req.user.role })));
  const accessToken = jwt.sign({ id: patient._id, role: "superadmin", type: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  assert.equal((await request("/", { accessToken })).status, 200);
  account = { ...account, isActive: false };
  assert.equal((await request("/", { accessToken })).status, 401);
  account = { ...account, isActive: true, role: "admin" };
  assert.equal((await request("/", { accessToken })).status, 401);
  account = null;
  assert.equal((await request("/", { accessToken })).status, 401);
});

test("patient login and staff refresh tokens preserve internal ID as exact decimal claims", async t => {
  const account = { ...patient, passwordHash: await bcrypt.hash("001234", 4) };
  t.mock.method(User, "findOne", () => query(account));
  const request = await serverFor(t, app => app.post("/", patientController.login));
  const result = await request("/", { method: "POST", body: { citizenId: patient.citizenId, password: "001234" } });
  assert.equal(result.status, 200);
  assert.equal(jwt.verify(result.body.data.accessToken, process.env.JWT_SECRET).internalId, String(key));
  assert.equal(result.body.data.patient.internalId, String(key));
  const service = require("../src/services/token.service");
  const pair = service.generateTokenPair({ id: patient._id, internalId: key, role: "admin" });
  const refreshed = service.refreshToken(pair.refreshToken);
  assert.equal(service.verifyAccessToken(refreshed.accessToken).internalId, String(key));
});

test("keyed password changes retain identity and compare the token version atomically", async t => {
  const account = { ...patient, requiresPasswordChange: true, passwordHash: await bcrypt.hash("001234", 4) };
  t.mock.method(User, "findOne", filter => { assert.deepEqual(filter, { internalId: key }); return query(account); });
  t.mock.method(User, "findById", () => { throw new Error("Unexpected legacy identity query"); });
  let updated;
  t.mock.method(User, "findOneAndUpdate", (filter, changes) => {
    assert.deepEqual(filter, { internalId: key, tokenVersion: 3 });
    assert.equal(changes.$inc.tokenVersion, 1);
    updated = { ...account, ...changes.$set, tokenVersion: 4 };
    return query(updated);
  });
  const request = await serverFor(t, app => app.post("/", auth, patientController.changePassword));
  const result = await request("/", { accessToken: token(), method: "POST", body: { currentPassword: "001234", password: "654321" } });
  assert.equal(result.status, 200); assert.ok(await bcrypt.compare("654321", updated.passwordHash));
  const claims = jwt.verify(result.body.data.accessToken, process.env.JWT_SECRET);
  assert.equal(claims.internalId, String(key)); assert.equal(claims.tokenVersion, 4);
  assert.equal(result.body.data.patient.requiresPasswordChange, false);
  assert.equal(result.body.data.patient.passwordHash, undefined);
});

test("own history and saved records use numeric relations without accepting forged keys", async t => {
  t.mock.method(User, "findOne", filter => { assert.deepEqual(filter, { internalId: key }); return query(patient); });
  t.mock.method(ids, "ensureInternalId", async (Model, document) => { assert.equal(Model, User); assert.equal(document, patient); return key; });
  let saved;
  t.mock.method(Health, "create", async data => { saved = data; return { ...data, _id: "507f1f77bcf86cd799439022", internalId: key + 1n }; });
  t.mock.method(Health, "findOne", filter => {
    assert.deepEqual(filter.$and[0], healthForUser(patient));
    return { sort: async () => null };
  });
  t.mock.method(User, "findOneAndUpdate", async filter => { assert.deepEqual(filter, { internalId: key }); return patient; });
  t.mock.method(Health, "findOneAndUpdate", async filter => { assert.deepEqual(filter, { internalId: key + 1n }); return {}; });
  const expected = healthForUser(patient);
  const rows = [{ internalId: key + 1n, userKey: key, value: { fbs: 106.5 } }];
  t.mock.method(Health, "find", filter => { assert.deepEqual(filter, expected); return { sort() { return this; }, skip() { return this; }, limit: async () => rows }; });
  t.mock.method(Health, "countDocuments", async filter => { assert.deepEqual(filter, expected); return 1; });
  const request = await serverFor(t, app => {
    app.post("/health", auth, publicController.submitHealth);
    app.get("/health", auth, publicController.getHealthByCitizen);
  });
  const result = await request("/health", { accessToken: token(), method: "POST",
    body: { citizenId: patient.citizenId, agreements: require("./fixtures/legal-agreements.json").patient, userKey: "999", internalId: "999", type: "sugar", value: { fbs: 106.5 } } });
  assert.equal(result.status, 200); assert.equal(saved.userKey, key); assert.equal(saved.internalId, undefined);
  const history = await request(`/health?citizenId=${patient.citizenId}`, { accessToken: token() });
  assert.equal(history.status, 200); assert.equal(history.body.data[0].userKey, String(key));
  assert.equal(history.body.total, 1); assert.equal(history.body.data[0].value.fbs, 106.5);
});
