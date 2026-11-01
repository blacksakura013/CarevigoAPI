// Reusable real-model/real-route fixture. Only email delivery is replaced.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const { Long } = require("mongodb");
const { isolatedMongo } = require("./isolatedMongo");

const ORIGIN = "http://localhost:3000";
const BASE = 9007199254740993n;
const subjectAgreements = () => ({ termsVersion: "2026-11-01", privacyVersion: "2026-11-01", termsAccepted: true, healthDataConsent: true });
const staffAgreements = () => ({ termsVersion: "2026-11-01", privacyVersion: "2026-11-01", termsAccepted: true,
  privacyNoticeAcknowledged: true, lawfulAuthorityConfirmed: true });
const profile = overrides => ({ firstName: "ทดสอบ", lastName: "เวิร์กโฟลว์", gender: "female", birthDate: "19750315",
  smokingStatus: "never", chronicDiseases: [], chronicDiseasesConfirmed: true, province: "เชียงใหม่", ...overrides });
const measurements = () => [
  { type: "blood_pressure", value: { systolic: 130, diastolic: 80, pulse: 72 } },
  { type: "sugar", value: { fbs: 95, hba1c: 5.4 } },
  { type: "cholesterol", value: { total: 210, ldl: 120, hdl: 55, triglyceride: 110 } },
  { type: "bmi", value: { weight: 60.5, height: 165 }, weight: 60.5, height: 165 },
];

async function startWorkflowHarness() {
  const environment = { NODE_ENV: "test", JWT_SECRET: "carevigo-isolated-workflow-secret", JWT_REFRESH_SECRET: "carevigo-isolated-workflow-refresh",
    CORS_ALLOWED_ORIGINS: ORIGIN, TRUST_PROXY_HOPS: "1", FRONTEND_URL: ORIGIN, COOKIE_SAME_SITE: "lax" };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  let mongo, server, email, sendReviewNotification, sendAdminPasswordReset;
  const sentEmails = [], sentResetEmails = [];
  try {
    mongo = await isolatedMongo({ mongoose });
    if (!mongo) {
      for (const key of Object.keys(environment)) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      return null;
    }
    const models = Object.fromEntries(["Counter", "User", "Admin", "Health", "Submission", "ReviewOutbox", "AuthSession"]
      .map(name => [name, require(`../../src/models/${name}`)]));
    await Promise.all(Object.values(models).map(Model => Model.init()));
    for (const [index, name] of ["User", "Admin", "Health", "Submission", "ReviewOutbox"].entries()) {
      await models.Counter.collection.insertOne({ _id: name, value: Long.fromBigInt(BASE + BigInt(index) * 10000n) });
    }
    const password = await bcrypt.hash("workflow-staff-password", 4);
    const admins = await models.Admin.create([
      { email: "workflow-staff@example.test", password, role: "superadmin", isActive: true },
      { email: "workflow-reviewer@example.test", password, role: "admin", isActive: true },
      { email: "workflow-disabled@example.test", password, role: "admin", isActive: false },
    ]);
    email = require("../../src/services/email.service");
    sendReviewNotification = email.sendReviewNotification;
    email.sendReviewNotification = async message => { sentEmails.push(message); return { accepted: [message.recipient] }; };
    sendAdminPasswordReset = email.sendAdminPasswordReset;
    email.sendAdminPasswordReset = async message => { sentResetEmails.push(message); return { accepted: [message.recipient] }; };
    const createApp = require("../../src/createApp");
    const app = (createApp.createApp || createApp)({ logRequests: false, enableLine: false });
    // Explicitly trust only our direct local test proxy header, so each independent
    // client exercises the real limiter without sharing a single test-runner IP.
    app.set("trust proxy", 1);
    server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    let clients = 0;
    function newClient(defaultScope = "patient") {
      const cookies = new Map(), sessions = new Map();
      const ip = `127.0.2.${++clients}`;
      const client = {
        cookies, sessions,
        async request(pathname, { method = "GET", body, scope = defaultScope, anonymous = false, headers = {}, session, cookieOverride } = {}) {
          const current = session || sessions.get(scope);
          const bootstrap = pathname.startsWith("/auth/session");
          const login = ["/auth/login", "/auth/patient/login"].includes(pathname);
          const response = await fetch(`${baseURL}/api${pathname}`, { method,
            headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": ip,
              ...(!anonymous ? { "X-Carevigo-Session": "cookie", "X-Carevigo-Scope": scope } : {}),
              ...(cookies.size ? { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") } : {}),
              ...(cookieOverride === undefined ? {} : { Cookie: cookieOverride }),
              ...(!anonymous && !bootstrap && !login && current ? { "X-Carevigo-Session-Id": current.sessionId,
                ...(!["GET", "HEAD", "OPTIONS"].includes(method) ? { "X-CSRF-Token": current.csrfToken } : {}) } : {}), ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
          const json = await response.json();
          for (const value of response.headers.getSetCookie()) {
            const pair = value.slice(0, value.indexOf(";"));
            const separator = pair.indexOf("=");
            const name = pair.slice(0, separator), content = pair.slice(separator + 1);
            if (!content) cookies.delete(name); else cookies.set(name, content);
          }
          if (response.ok && json.data?.session) sessions.set(scope, json.data.session);
          return { status: response.status, body: json, headers: response.headers };
        },
        async loginStaff() {
          const result = await client.request("/auth/login", { method: "POST", scope: "admin",
            body: { email: admins[0].email, password: "workflow-staff-password" } });
          assertStatus(result, 200); return result;
        },
        clone() {
          const copy = newClient(defaultScope);
          for (const [key, value] of cookies) copy.cookies.set(key, value);
          for (const [key, value] of sessions) copy.sessions.set(key, { ...value });
          return copy;
        },
      };
      return client;
    }
    let stopped = false;
    async function stop() {
      if (stopped) return;
      stopped = true;
      await require("../../src/controllers/passwordReset.controller").flushDeliveries();
      try { if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }
      finally {
        try { if (mongo) return await mongo.stop(); }
        finally {
          if (email && sendReviewNotification) email.sendReviewNotification = sendReviewNotification;
          if (email && sendAdminPasswordReset) email.sendAdminPasswordReset = sendAdminPasswordReset;
          for (const key of Object.keys(environment)) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
        }
      }
    }
    return { app, baseURL, models, admins, mongo, newClient, sentEmails, sentResetEmails, stop,
      flushResetEmails: require("../../src/controllers/passwordReset.controller").flushDeliveries,
      review: require("../../src/services/review.service"),
      guestPayload(citizenId, overrides = {}) { return { citizenId, profile: profile(), records: measurements(),
        agreements: subjectAgreements(), clientRequestId: randomUUID(), ...overrides }; },
    };
  } catch (error) {
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    if (email && sendReviewNotification) email.sendReviewNotification = sendReviewNotification;
    if (email && sendAdminPasswordReset) email.sendAdminPasswordReset = sendAdminPasswordReset;
    if (mongo) await mongo.stop();
    for (const key of Object.keys(environment)) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    throw error;
  }
}

function assertStatus(result, status) {
  assert.equal(result.status, status, `HTTP ${result.status}: ${result.body?.code || result.body?.title || ""} ${result.body?.message || ""}`);
}

module.exports = { startWorkflowHarness, assertStatus, subjectAgreements, staffAgreements, profile, measurements, BASE, ORIGIN };
