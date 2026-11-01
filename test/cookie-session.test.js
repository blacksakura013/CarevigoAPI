const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("../src/models/User");
const Admin = require("../src/models/Admin");
const AuthSession = require("../src/models/AuthSession");
const sessions = require("../src/services/cookieSession.service");
const auth = require("../src/middleware/auth.middleware");
const { allowedOrigins } = require("../src/config/origins");
const ORIGIN = "http://localhost:3000";
const query = value => ({ select: async () => value, then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) });

async function setup(t) {
  process.env.JWT_SECRET = "carevigo-cookie-isolated-tests";
  process.env.JWT_REFRESH_SECRET = "carevigo-cookie-isolated-refresh-tests";
  const patient = { _id: "507f1f77bcf86cd799439011", internalId: 9007199254740993n, citizenId: "1234567890123", firstName: "Patient",
    accountEnabled: true, requiresPasswordChange: false, tokenVersion: 3, passwordHash: await bcrypt.hash("001234", 4) };
  const admin = { _id: "507f1f77bcf86cd799439012", internalId: 9007199254740995n, email: "staff@example.test", role: "admin", isActive: true,
    password: await bcrypt.hash("staff-password", 4), tokenVersion: 0 };
  const stored = new Map();
  const lookups = [];
  t.mock.method(User, "findOne", filter => {
    lookups.push(filter);
    return query(filter.citizenId === patient.citizenId || filter.internalId === patient.internalId ? patient : null);
  });
  t.mock.method(User, "findById", id => query(id === patient._id ? patient : null));
  t.mock.method(User, "findOneAndUpdate", (filter, update) => {
    if (filter.tokenVersion !== patient.tokenVersion || filter.internalId !== patient.internalId) return query(null);
    Object.assign(patient, update.$set);
    patient.tokenVersion += update.$inc?.tokenVersion || 0;
    return query(patient);
  });
  t.mock.method(Admin, "findOne", async filter => filter.email === admin.email || filter.internalId === admin.internalId ? admin : null);
  t.mock.method(Admin, "findById", async id => id === admin._id ? admin : null);
  t.mock.method(Admin, "findOneAndUpdate", async (filter, update) => {
    const parts = filter.$and || [filter];
    if (parts.some(part => part.password !== undefined && part.password !== admin.password ||
      part.tokenVersion !== undefined && part.tokenVersion !== admin.tokenVersion)) return null;
    Object.assign(admin, update.$set);
    admin.tokenVersion += update.$inc?.tokenVersion || 0;
    for (const field of Object.keys(update.$unset || {})) delete admin[field];
    return admin;
  });
  t.mock.method(AuthSession, "create", async row => { stored.set(row._id, { ...row }); return row; });
  t.mock.method(AuthSession, "findOne", async filter => {
    const row = stored.get(filter._id);
    return row && row.scope === filter.scope && row.accountId === filter.accountId && row.expiresAt > filter.expiresAt.$gt ? row : null;
  });
  t.mock.method(AuthSession, "deleteOne", async filter => ({ deletedCount: stored.get(filter._id)?.scope === filter.scope && stored.delete(filter._id) ? 1 : 0 }));
  t.mock.method(AuthSession, "deleteMany", async filter => {
    let deletedCount = 0;
    for (const [key, row] of stored) if (row.scope === filter.scope && row.accountId === filter.accountId) { stored.delete(key); deletedCount++; }
    return { deletedCount };
  });
  const app = express();
  app.set("json replacer", require("../src/utils/json").jsonReplacer);
  app.use(cors({ origin: allowedOrigins(), credentials: true, exposedHeaders: ["X-Carevigo-Session-Id"] }));
  app.use(express.json());
  app.use("/api/auth", require("../src/routes/auth.routes"));
  app.all("/api/private", auth, (req, res) => res.json({ id: req.user.id, type: req.user.type }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  async function request(path, { scope = "patient", cookie, session, body, method = "GET", headers = {}, mode = true } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method,
      headers: { Origin: ORIGIN, "Content-Type": "application/json", ...(mode ? { "X-Carevigo-Session": "cookie", "X-Carevigo-Scope": scope } : {}),
        ...(session ? { "X-Carevigo-Session-Id": session.sessionId, "X-CSRF-Token": session.csrfToken } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const bodyValue = await response.json();
    const setCookie = response.headers.get("set-cookie");
    return { status: response.status, body: bodyValue, cookie: setCookie?.split(";")[0], setCookie, headers: response.headers };
  }
  async function login(scope = "patient", options = {}) {
    return request(scope === "patient" ? "/auth/patient/login" : "/auth/login", { scope, method: "POST",
      body: scope === "patient" ? { citizenId: patient.citizenId, password: "001234" } : { email: admin.email, password: "staff-password" }, ...options });
  }
  return { request, login, patient, admin, stored, lookups };
}

test("cookie login persists an exact BigInt link and returns metadata without exposing JWTs", async t => {
  const { login, request, stored, patient, lookups } = await setup(t);
  const result = await login();
  assert.equal(result.status, 200);
  assert.equal(result.body.data.accessToken, undefined);
  assert.equal(result.body.data.refreshToken, undefined);
  assert.equal(result.body.data.patient.passwordHash, undefined);
  const session = result.body.data.session;
  assert.equal(session.scope, "patient");
  assert.match(session.sessionId, /^[A-Za-z0-9_-]{32}$/);
  assert.match(session.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Number.isNaN(Date.parse(session.expiresAt)), false);
  assert.match(result.setCookie, /HttpOnly/);
  assert.match(result.setCookie, /Path=\/api/);
  assert.match(result.setCookie, /SameSite=Lax/);
  assert.equal([...stored.values()][0].accountKey, 9007199254740993n);
  const bootstrap = await request("/auth/session?scope=patient", { cookie: result.cookie });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.data.patient.internalId, patient.internalId.toString());
  assert.deepEqual(bootstrap.body.data.session, session);
  assert.equal(lookups.at(-1).internalId, 9007199254740993n);
  assert.equal(bootstrap.headers.get("x-carevigo-session-id"), session.sessionId);
  assert.equal(bootstrap.headers.get("access-control-allow-credentials"), "true");
  assert.match(bootstrap.headers.get("access-control-expose-headers"), /X-Carevigo-Session-Id/i);
});

test("production cookie uses Secure, HttpOnly, SameSite=None and host-only scope", async t => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  t.after(() => { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; });
  const { login } = await setup(t);
  const result = await login("admin");
  assert.equal(result.status, 200);
  assert.match(result.setCookie, /Secure/);
  assert.match(result.setCookie, /HttpOnly/);
  assert.match(result.setCookie, /SameSite=None/);
  assert.doesNotMatch(result.setCookie, /Domain=/i);
  assert.equal(Date.parse(result.body.data.session.expiresAt) - Date.now() > 6 * 86400000, true);
});

test("same-site deployments can select Lax or Strict and None always requires Secure", t => {
  const originalEnvironment = process.env.NODE_ENV, originalSameSite = process.env.COOKIE_SAME_SITE;
  t.after(() => {
    if (originalEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnvironment;
    if (originalSameSite === undefined) delete process.env.COOKIE_SAME_SITE; else process.env.COOKIE_SAME_SITE = originalSameSite;
  });
  process.env.NODE_ENV = "production";
  for (const value of ["lax", "strict"]) {
    process.env.COOKIE_SAME_SITE = value;
    assert.deepEqual(sessions.cookieOptions(), { httpOnly: true, secure: true, sameSite: value, path: "/api" });
  }
  process.env.NODE_ENV = "development"; process.env.COOKIE_SAME_SITE = "NoNe";
  assert.equal(sessions.cookieOptions().secure, true);
  assert.equal(sessions.cookieOptions().sameSite, "none");
  process.env.COOKIE_SAME_SITE = "invalid";
  assert.equal(sessions.cookieOptions().sameSite, "lax");
});

test("untrusted origins, missing scope and scope mismatches cannot establish browser sessions", async t => {
  const { login, stored } = await setup(t);
  for (const headers of [{ Origin: "https://untrusted.example" }, { "X-Carevigo-Scope": "" }, { "X-Carevigo-Scope": "admin" }, { Origin: "" }, { Origin: "null" }]) {
    const result = await login("patient", { headers });
    assert.equal(result.status, 403);
    assert.equal(result.setCookie, null);
  }
  assert.equal(stored.size, 0);
});

test("development cookie login and protected writes work from both exact port 3001 frontend origins", async t => {
  const previous = { NODE_ENV: process.env.NODE_ENV, CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.NODE_ENV = "development"; delete process.env.CORS_ALLOWED_ORIGINS;
  const { login, request } = await setup(t);
  for (const origin of ["http://localhost:3001", "http://127.0.0.1:3001"]) {
    const result = await login("patient", { headers: { Origin: origin } });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("access-control-allow-origin"), origin);
    assert.equal(result.headers.get("access-control-allow-credentials"), "true");
    const saved = await request("/private", { method: "POST", cookie: result.cookie,
      session: result.body.data.session, headers: { Origin: origin } });
    assert.equal(saved.status, 200);
    const denied = await request("/private", { method: "POST", cookie: result.cookie,
      session: result.body.data.session, headers: { Origin: "http://localhost:30010" } });
    assert.equal(denied.status, 403);
  }
});

test("protected cookies require matching browser generation and per-session CSRF for writes", async t => {
  const { login, request, stored } = await setup(t);
  const result = await login();
  const session = result.body.data.session;
  assert.equal((await request("/private", { cookie: result.cookie })).status, 409);
  assert.equal((await request("/private", { cookie: result.cookie, session })).status, 200);
  assert.equal((await request("/private", { method: "POST", cookie: result.cookie, session, headers: { "X-CSRF-Token": "" } })).status, 403);
  assert.equal((await request("/private", { method: "POST", cookie: result.cookie, session, headers: { "X-CSRF-Token": "wrong" } })).status, 403);
  assert.equal((await request("/private", { method: "POST", cookie: result.cookie, session })).status, 200);
  const denied = await request("/auth/logout", { method: "POST", cookie: result.cookie, session, headers: { Origin: "https://untrusted.example" } });
  assert.equal(denied.status, 403); assert.equal(denied.setCookie, null); assert.equal(stored.size, 1);
});

test("patient and staff cookies coexist and scoped logout revokes copied cookies only for that session", async t => {
  const { login, request, stored } = await setup(t);
  const patient = await login(), admin = await login("admin");
  const cookie = `${patient.cookie}; ${admin.cookie}`;
  assert.equal(stored.size, 2);
  const patientMe = await request("/auth/session?scope=patient", { cookie });
  const adminMe = await request("/auth/session?scope=admin", { cookie, scope: "admin" });
  assert.equal(patientMe.body.data.patient.firstName, "Patient");
  assert.equal(adminMe.body.data.admin.email, "staff@example.test");
  const logout = await request("/auth/logout", { method: "POST", cookie, session: patient.body.data.session, body: { scope: "patient" } });
  assert.equal(logout.status, 200);
  assert.match(logout.setCookie, /^carevigo_patient_session=;/);
  assert.doesNotMatch(logout.setCookie, /carevigo_admin_session/);
  assert.equal(stored.size, 1);
  assert.equal((await request("/auth/session?scope=patient", { cookie: patient.cookie })).status, 401);
  assert.equal((await request("/auth/session?scope=admin", { cookie, scope: "admin" })).status, 200);
});

test("a stale tab cannot mutate or log out the new account session and never clears its cookie", async t => {
  const { login, request, stored } = await setup(t);
  const older = await login(), newer = await login("patient", { cookie: older.cookie });
  assert.equal(stored.size, 1);
  assert.notEqual(older.body.data.session.sessionId, newer.body.data.session.sessionId);
  const stale = await request("/auth/logout", { method: "POST", cookie: newer.cookie, session: older.body.data.session, body: { scope: "patient" } });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "SESSION_CHANGED"); assert.equal(stale.setCookie, null);
  assert.equal((await request("/private", { cookie: newer.cookie, session: newer.body.data.session })).status, 200);
  assert.equal((await request("/auth/session?scope=patient", { cookie: older.cookie })).status, 401);
});

test("cookie tokens cannot bypass CSRF and revocation using the Bearer compatibility path", async t => {
  const { login, request } = await setup(t);
  const result = await login();
  const token = result.cookie.slice(result.cookie.indexOf("=") + 1);
  assert.equal((await request("/private", { mode: false, headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await request("/private", { cookie: result.cookie, session: result.body.data.session, headers: { Authorization: `Bearer ${token}` } })).status, 403);
});

test("account disablement, token revocation, expired store rows and role changes invalidate sessions", async t => {
  const { login, request, patient, admin, stored } = await setup(t);
  const member = await login();
  const options = { cookie: member.cookie, session: member.body.data.session };
  patient.accountEnabled = false;
  assert.equal((await request("/private", options)).status, 401);
  patient.accountEnabled = true; patient.tokenVersion++;
  assert.equal((await request("/private", options)).status, 401);
  patient.tokenVersion--;
  stored.values().next().value.expiresAt = new Date(0);
  assert.equal((await request("/private", options)).status, 401);
  const staff = await login("admin");
  const staffOptions = { scope: "admin", cookie: staff.cookie, session: staff.body.data.session };
  admin.isActive = false;
  assert.equal((await request("/private", staffOptions)).status, 401);
  admin.isActive = true; admin.role = "superadmin";
  assert.equal((await request("/private", staffOptions)).status, 401);
});

test("disabled or demoted accounts can revoke their cookie without regaining private access", async t => {
  const { login, request, patient, admin, stored } = await setup(t);
  const member = await login(), staff = await login("admin");
  patient.accountEnabled = false; admin.role = "superadmin";
  const scopes = [{ scope: "patient", login: member }, { scope: "admin", login: staff }];
  for (const { scope, login: original } of scopes) {
    const options = { scope, cookie: original.cookie, session: original.body.data.session };
    assert.equal((await request("/private", options)).status, 401);
    assert.equal((await request("/auth/logout", { ...options, method: "POST", body: { scope } })).status, 200);
  }
  assert.equal(stored.size, 0);
  patient.accountEnabled = true; admin.role = "admin";
  for (const { scope, login: original } of scopes) {
    assert.equal((await request(`/auth/session?scope=${scope}`, { scope, cookie: original.cookie })).status, 401);
  }
});

test("patient password replacement rotates cookie and CSRF and invalidates every previous session", async t => {
  const { login, request, stored } = await setup(t);
  const first = await login(), otherDevice = await login();
  assert.equal(stored.size, 2);
  const changed = await request("/auth/patient/change-password", { method: "POST", cookie: first.cookie, session: first.body.data.session,
    body: { currentPassword: "001234", password: "654321" } });
  assert.equal(changed.status, 200); assert.equal(changed.body.data.accessToken, undefined);
  assert.equal(changed.body.data.requiresPasswordChange, false);
  assert.notEqual(changed.body.data.session.sessionId, first.body.data.session.sessionId);
  assert.notEqual(changed.body.data.session.csrfToken, first.body.data.session.csrfToken);
  assert.equal(stored.size, 1);
  for (const cookie of [first.cookie, otherDevice.cookie]) assert.equal((await request("/auth/session?scope=patient", { cookie })).status, 401);
  assert.equal((await request("/private", { cookie: changed.cookie, session: changed.body.data.session })).status, 200);
});

test("staff password replacement rotates the cookie and invalidates other staff sessions", async t => {
  const { login, request, stored } = await setup(t);
  const first = await login("admin"), otherDevice = await login("admin");
  const changed = await request("/auth/change-password", { scope: "admin", method: "POST", cookie: first.cookie, session: first.body.data.session,
    body: { password: "changed-staff-password" } });
  assert.equal(changed.status, 200); assert.equal(changed.body.data.accessToken, undefined);
  assert.equal(stored.size, 1);
  assert.equal((await request("/auth/session?scope=admin", { scope: "admin", cookie: otherDevice.cookie })).status, 401);
  assert.equal((await request("/private", { scope: "admin", cookie: changed.cookie, session: changed.body.data.session })).status, 200);
});

test("anonymous requests never implicitly authenticate using ambient cookies", async t => {
  const { login, request } = await setup(t);
  const result = await login();
  assert.equal((await request("/private", { mode: false, cookie: result.cookie })).status, 401);
  assert.equal((await request("/auth/session?scope=admin", { scope: "admin", cookie: result.cookie })).status, 401);
  assert.equal((await request("/auth/session?scope=admin", { scope: "patient", cookie: result.cookie })).status, 403);
});

test("legacy Bearer tokens keep their contract and never create server cookie sessions", async t => {
  const { request, stored, patient } = await setup(t);
  const result = await request("/auth/patient/login", { mode: false, method: "POST", body: { citizenId: patient.citizenId, password: "001234" } });
  assert.equal(result.status, 200); assert.equal(result.setCookie, null); assert.equal(stored.size, 0);
  const token = result.body.data.accessToken;
  assert.equal(jwt.verify(token, process.env.JWT_SECRET).internalId, "9007199254740993");
  assert.equal((await request("/private", { mode: false, headers: { Authorization: `Bearer ${token}` } })).status, 200);
});
