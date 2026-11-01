// Opt-in real routes/models/indices on a fresh local database. Never reads .env.
const assert = require("node:assert/strict");
const { describe, test, before, after } = require("node:test");
const { randomUUID, createHash } = require("node:crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { startWorkflowHarness, assertStatus, profile } = require("./helpers/workflowHarness");
const { installedMongod } = require("./helpers/isolatedMongo");
const ENABLED = process.env.CAREVIGO_WORKFLOW_INTEGRATION === "1";
const executable = ENABLED ? installedMongod() : null;
const hash = token => createHash("sha256").update(token).digest("hex");
const tokenFor = message => new URLSearchParams(new URL(message.resetUrl).hash.slice(1)).get("token");
const OLD_PASSWORD = "original-reset-password";

describe("admin password recovery over real HTTP and isolated MongoDB", {
  skip: !ENABLED ? "Set CAREVIGO_WORKFLOW_INTEGRATION=1 for a fresh local MongoDB run" : !executable ? "No installed mongod" : false,
  concurrency: false, timeout: 180000,
}, () => {
  let h;
  before(async () => { h = await startWorkflowHarness(); assert.ok(h); });
  after(async () => {
    if (!h) return;
    const cleanup = await h.stop();
    assert.equal(cleanup.exited, true); assert.equal(cleanup.removed, true);
    console.log(`Reset cleanup verified: private MongoDB PID ${cleanup.pid} exited and directory removed`);
  });
  async function admin(overrides = {}) {
    return h.models.Admin.create({ email: `reset-${randomUUID()}@example.test`, password: await bcrypt.hash(OLD_PASSWORD, 4),
      isActive: true, role: "admin", ...overrides });
  }
  async function forgot(account, client = h.newClient("admin"), headers = {}) {
    const result = await client.request("/auth/forgot-password", { method: "POST", body: { email: account.email }, headers });
    assertStatus(result, 202); await h.flushResetEmails();
    return { result, message: h.sentResetEmails.findLast(item => item.recipient === account.email) };
  }
  async function validate(token, client = h.newClient("admin")) {
    return client.request("/auth/reset-password/validate", { method: "POST", body: { token } });
  }
  async function complete(token, password = "new-reset-password", client = h.newClient("admin"), extra = {}) {
    return client.request("/auth/reset-password", { method: "POST", body: { token, password, confirmPassword: password, ...extra } });
  }
  async function login(account, client = h.newClient("admin"), password = OLD_PASSWORD) {
    assertStatus(await client.request("/auth/login", { method: "POST", body: { email: account.email, password } }), 200);
    return client;
  }

  test("forgot is generic, hash-only, rate limited per account, and sends only a trusted fragment link without changing credentials", async () => {
    const active = await admin(), inactive = await admin({ isActive: false }), missing = { email: `missing-${randomUUID()}@example.test` };
    const before = await h.models.Admin.findById(active._id).lean();
    const replies = [];
    for (const account of [active, inactive, missing]) replies.push((await forgot(account)).result);
    replies.forEach(reply => {
      assert.deepEqual(reply.body, replies[0].body); assert.equal(reply.headers.get("set-cookie"), null);
    });
    const messages = h.sentResetEmails.filter(item => item.recipient === active.email);
    assert.equal(messages.length, 1); assert.equal(h.sentResetEmails.some(item => item.recipient === inactive.email), false);
    const message = messages[0], token = tokenFor(message), link = new URL(message.resetUrl);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert.equal(link.origin, "http://localhost:3000");
    assert.equal(link.pathname, "/admin/reset-password"); assert.equal(link.search, "");
    const stored = await h.models.Admin.findById(active._id).select("+passwordResetTokenHash +passwordResetExpiresAt +passwordResetRequestedAt").lean();
    assert.equal(stored.passwordResetTokenHash, hash(token)); assert.notEqual(stored.passwordResetTokenHash, token);
    assert.equal(stored.passwordResetExpiresAt - stored.passwordResetRequestedAt, 30 * 60000);
    assert.equal(stored.password, before.password); assert.equal(stored.tokenVersion, before.tokenVersion);
    const hidden = await h.models.Admin.findById(active._id).lean();
    assert.equal(hidden.passwordResetTokenHash, undefined); assert.equal(hidden.passwordResetExpiresAt, undefined);
    await forgot(active); assert.equal(h.sentResetEmails.filter(item => item.recipient === active.email).length, 1);
    const validated = await validate(token); assertStatus(validated, 200); assert.equal(validated.body.data.valid, true);
    const after = await h.models.Admin.findById(active._id).select("+passwordResetTokenHash +passwordResetExpiresAt +passwordResetRequestedAt").lean();
    assert.deepEqual(after, stored, "Validation must not consume or retimestamp a link");
  });

  test("latest link supersedes the previous one, inactive and expired links are rejected, and GET cannot consume recovery capabilities", async () => {
    const account = await admin();
    const first = tokenFor((await forgot(account)).message);
    await h.models.Admin.updateOne({ internalId: account.internalId }, { $set: { passwordResetRequestedAt: new Date(Date.now() - 61000) } });
    const second = tokenFor((await forgot(account)).message);
    assert.notEqual(first, second);
    assertStatus(await validate(first), 400); assertStatus(await validate(second), 200);
    const client = h.newClient("admin");
    const state = await h.models.Admin.findById(account._id).select("+passwordResetTokenHash +passwordResetExpiresAt").lean();
    for (const path of ["/auth/forgot-password", "/auth/reset-password", "/auth/reset-password/validate"]) {
      assertStatus(await client.request(path), 404);
    }
    assert.deepEqual(await h.models.Admin.findById(account._id).select("+passwordResetTokenHash +passwordResetExpiresAt").lean(), state);
    await h.models.Admin.updateOne({ internalId: account.internalId }, { $set: { isActive: false } });
    assertStatus(await validate(second), 400); assertStatus(await complete(second), 400);
    await h.models.Admin.updateOne({ internalId: account.internalId }, { $set: { isActive: true, passwordResetExpiresAt: new Date(Date.now() - 1000) } });
    const expired = await complete(second); assertStatus(expired, 400); assert.equal(expired.body.code, "RESET_LINK_INVALID");
    assertStatus(await validate(second), 400);
  });

  test("password rules and confirmation are server enforced without consuming the valid link", async () => {
    const account = await admin(), token = tokenFor((await forgot(account)).message);
    for (const [password, confirmPassword] of [["short", "short"], ["long-enough-password", "long-enough-password "], ["ก".repeat(25), "ก".repeat(25)], [12345678, 12345678]]) {
      const result = await complete(token, password, h.newClient("admin"), { confirmPassword });
      assertStatus(result, 400); assert.equal(result.body.code, "PASSWORD_INVALID");
      assertStatus(await validate(token), 200);
    }
    const before = await h.models.Admin.findById(account._id).lean();
    assert.equal(await bcrypt.compare(OLD_PASSWORD, before.password), true); assert.equal(before.tokenVersion, 0);
  });

  test("a successful reset consumes once, revokes every admin cookie and legacy Bearer, leaves other accounts and patient sessions intact, and never auto-logs in", async () => {
    const account = await admin(), unrelated = await admin();
    const first = await login(account), second = await login(account), other = await login(unrelated);
    const person = await h.models.User.create({ citizenId: "8700000000001", ...profile(), accountEnabled: true,
      tokenVersion: 3, passwordHash: await bcrypt.hash("patient-keeps-password", 4) });
    const patient = h.newClient("patient");
    assertStatus(await patient.request("/auth/patient/login", { method: "POST", body: { citizenId: person.citizenId, password: "patient-keeps-password" } }), 200);
    const patientSession = patient.sessions.get("patient").sessionId;
    const legacy = jwt.sign({ id: String(account._id), internalId: String(account.internalId), type: "admin", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    assertStatus(await first.request("/users/admin", { anonymous: true, headers: { Authorization: `Bearer ${legacy}` } }), 200);
    const token = tokenFor((await forgot(account)).message);
    const result = await complete(token);
    assertStatus(result, 200); assert.equal(result.body.data, null); assert.equal(result.headers.get("set-cookie"), null);
    assert.equal(result.body.session, undefined); assertStatus(await validate(token), 400);
    const again = await complete(token); assertStatus(again, 400); assert.equal(again.body.code, "RESET_LINK_INVALID");
    for (const client of [first, second]) assertStatus(await client.request("/auth/session?scope=admin"), 401);
    assertStatus(await first.request("/users/admin", { anonymous: true, headers: { Authorization: `Bearer ${legacy}` } }), 401);
    assert.equal(await h.models.AuthSession.countDocuments({ scope: "admin", accountId: account._id }), 0);
    assertStatus(await other.request("/auth/session?scope=admin"), 200);
    const unchangedPatient = await patient.request("/auth/session?scope=patient");
    assertStatus(unchangedPatient, 200); assert.equal(unchangedPatient.body.data.session.sessionId, patientSession);
    const old = await h.newClient("admin").request("/auth/login", { method: "POST", body: { email: account.email, password: OLD_PASSWORD } });
    assertStatus(old, 401);
    const fresh = await login(account, h.newClient("admin"), "new-reset-password");
    const cookieToken = fresh.cookies.get("carevigo_admin_session");
    assert.equal(jwt.verify(cookieToken, process.env.JWT_SECRET).tokenVersion, 1);
    const saved = await h.models.Admin.findById(account._id).select("+passwordResetTokenHash +passwordResetExpiresAt").lean();
    assert.equal(saved.tokenVersion, 1); assert.match(saved.password, /^\$2/);
    assert.equal(saved.passwordResetTokenHash, undefined); assert.equal(saved.passwordResetExpiresAt, undefined);
  });

  test("two simultaneous reset submissions have one winning password update and one version increment", async () => {
    const account = await admin(), token = tokenFor((await forgot(account)).message);
    const passwords = ["reset-concurrency-A", "reset-concurrency-B"];
    const results = await Promise.all(passwords.map(password => complete(token, password)));
    assert.deepEqual(results.map(item => item.status).sort(), [200, 400]);
    const winner = results.findIndex(item => item.status === 200), stored = await h.models.Admin.findById(account._id).lean();
    assert.equal(stored.tokenVersion, 1);
    assert.equal(await bcrypt.compare(passwords[winner], stored.password), true);
    assert.equal(await bcrypt.compare(passwords[1 - winner], stored.password), false);
    assertStatus(await validate(token), 400);
  });

  test("a newer requested link wins over an older reset that was hashing its password", async t => {
    const account = await admin(), oldToken = tokenFor((await forgot(account)).message);
    const originalHash = bcrypt.hash;
    let started, release;
    const began = new Promise(resolve => { started = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    t.mock.method(bcrypt, "hash", async (value, rounds) => {
      if (value === "older-held-reset-password") { started(); await released; }
      return originalHash(value, rounds);
    });
    const inFlight = complete(oldToken, "older-held-reset-password");
    await began;
    await h.models.Admin.updateOne({ internalId: account.internalId }, { $set: { passwordResetRequestedAt: new Date(Date.now() - 61000) } });
    let fresh;
    try { fresh = tokenFor((await forgot(account)).message); } finally { release(); }
    assertStatus(await inFlight, 400); assertStatus(await validate(fresh), 200);
    const stored = await h.models.Admin.findById(account._id).lean();
    assert.equal(stored.tokenVersion, 0); assert.equal(await bcrypt.compare(OLD_PASSWORD, stored.password), true);
  });

  test("authenticated password change invalidates outstanding reset links and versionless legacy tokens", async () => {
    const account = await admin(), logged = await login(account), copied = logged.clone();
    const token = tokenFor((await forgot(account)).message);
    const legacy = jwt.sign({ id: String(account._id), type: "admin", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const changed = await logged.request("/auth/change-password", { method: "POST", body: { password: "changed-from-settings" } });
    assertStatus(changed, 200); assertStatus(await validate(token), 400); assertStatus(await complete(token), 400);
    assertStatus(await copied.request("/auth/session?scope=admin"), 401);
    assertStatus(await logged.request("/auth/session?scope=admin"), 200);
    assertStatus(await logged.request("/users/admin", { anonymous: true, headers: { Authorization: `Bearer ${legacy}` } }), 401);
    assert.equal((await h.models.Admin.findById(account._id)).tokenVersion, 1);
  });

  test("recovery rejects cross-origin, missing scope and patient scope requests without changing the account, and enforces per-IP request limits", async () => {
    const account = await admin(), token = tokenFor((await forgot(account)).message);
    const before = await h.models.Admin.findById(account._id).select("+passwordResetTokenHash +passwordResetExpiresAt +passwordResetRequestedAt").lean();
    for (const headers of [{ Origin: "https://evil.example" }, { "X-Carevigo-Scope": "patient" }, { "X-Carevigo-Scope": "" }, { Origin: "null" }]) {
      const client = h.newClient("admin");
      assertStatus(await client.request("/auth/forgot-password", { method: "POST", body: { email: account.email }, headers }), 403);
      assertStatus(await client.request("/auth/reset-password", { method: "POST", body: { token, password: "forged-reset-password", confirmPassword: "forged-reset-password" }, headers }), 403);
    }
    assert.deepEqual(await h.models.Admin.findById(account._id).select("+passwordResetTokenHash +passwordResetExpiresAt +passwordResetRequestedAt").lean(), before);
    const limited = h.newClient("admin");
    for (let index = 0; index < 5; index++) assertStatus(await limited.request("/auth/forgot-password", { method: "POST", body: { email: "unknown-limit@example.test" } }), 202);
    const blocked = await limited.request("/auth/forgot-password", { method: "POST", body: { email: "unknown-limit@example.test" } });
    assertStatus(blocked, 429); assert.equal(blocked.body.code, "RESET_RATE_LIMIT");
  });

  test("a failed older email delivery cannot clear a newer link and the request never waits for SMTP", async () => {
    const account = await admin(), service = require("../src/services/email.service"), normal = service.sendAdminPasswordReset;
    let began, rejectFirst;
    const started = new Promise(resolve => { began = resolve; });
    let count = 0;
    service.sendAdminPasswordReset = message => {
      if (++count === 1) { began(); return new Promise((resolve, reject) => { rejectFirst = reject; }); }
      return normal(message);
    };
    try {
      const first = await h.newClient("admin").request("/auth/forgot-password", { method: "POST", body: { email: account.email } });
      assertStatus(first, 202); await started;
      await h.models.Admin.updateOne({ internalId: account.internalId }, { $set: { passwordResetRequestedAt: new Date(Date.now() - 61000) } });
      const second = await h.newClient("admin").request("/auth/forgot-password", { method: "POST", body: { email: account.email } });
      assertStatus(second, 202);
      rejectFirst(new Error("Private SMTP content is not logged"));
      await h.flushResetEmails();
      const message = h.sentResetEmails.findLast(item => item.recipient === account.email), token = tokenFor(message);
      assertStatus(await validate(token), 200);
      const saved = await h.models.Admin.findById(account._id).select("+passwordResetTokenHash");
      assert.equal(saved.passwordResetTokenHash, hash(token));
    } finally { if (rejectFirst) rejectFirst(new Error("Fixture cleanup")); service.sendAdminPasswordReset = normal; await h.flushResetEmails(); }
  });

  test("version-bounded cleanup removes legacy and older sessions while preserving current or later generations; unbounded cleanup still revokes all", async () => {
    const account = await admin(), expiresAt = new Date(Date.now() + 3600000);
    const rows = await h.models.AuthSession.create([undefined, 0, 1, 2].map(tokenVersion => ({
      _id: hash(randomUUID()), scope: "admin", accountId: account._id, accountKey: account.internalId,
      expiresAt, ...(tokenVersion === undefined ? {} : { tokenVersion }),
    })));
    const sessions = require("../src/services/cookieSession.service");
    await sessions.revokeAccount("admin", account._id, 1);
    assert.deepEqual((await h.models.AuthSession.find({ accountId: account._id }).lean()).map(row => row.tokenVersion).sort(), [1, 2]);
    assert.equal(await h.models.AuthSession.countDocuments({ _id: { $in: rows.slice(0, 2).map(row => row._id) } }), 0);
    await sessions.revokeAccount("admin", account._id, 2);
    assert.deepEqual((await h.models.AuthSession.find({ accountId: account._id }).lean()).map(row => row.tokenVersion), [2]);
    await sessions.revokeAccount("admin", account._id);
    assert.equal(await h.models.AuthSession.countDocuments({ accountId: account._id }), 0);
  });

  for (const flow of ["email reset", "staff password change", "patient password change"]) {
    test(`delayed old-session cleanup after ${flow} preserves a fresh login with the new password`, async t => {
      const scope = flow === "patient password change" ? "patient" : "admin";
      const account = scope === "admin" ? await admin() : await h.models.User.create({
        citizenId: "8700000000002", ...profile(), accountEnabled: true,
        passwordHash: await bcrypt.hash(OLD_PASSWORD, 4), tokenVersion: 2,
      });
      const old = h.newClient(scope), nextPassword = `fresh-login-survives-${scope}`;
      const credentials = password => scope === "admin" ? { email: account.email, password } : { citizenId: account.citizenId, password };
      const loginPath = scope === "admin" ? "/auth/login" : "/auth/patient/login";
      assertStatus(await old.request(loginPath, { method: "POST", body: credentials(OLD_PASSWORD) }), 200);
      const oldCopy = old.clone();
      const token = flow === "email reset" ? tokenFor((await forgot(account)).message) : null;
      const originalDelete = h.models.AuthSession.deleteMany;
      let started, release, timer;
      const began = new Promise((resolve, reject) => {
        started = resolve; timer = setTimeout(() => reject(new Error("Expected session cleanup to begin")), 5000);
      });
      const gate = new Promise(resolve => { release = resolve; });
      let held = false, rotating;
      t.mock.method(h.models.AuthSession, "deleteMany", async function (filter) {
        if (!held && filter.scope === scope && String(filter.accountId) === String(account._id)) {
          held = true; started(); await gate;
        }
        return originalDelete.call(this, filter);
      });
      try {
        rotating = flow === "email reset" ? complete(token, nextPassword) : old.request(scope === "admin" ? "/auth/change-password" : "/auth/patient/change-password", {
          method: "POST", body: { password: nextPassword, ...(scope === "patient" ? { currentPassword: OLD_PASSWORD } : {}) },
        });
        await began; clearTimeout(timer);
        const fresh = h.newClient(scope);
        assertStatus(await fresh.request(loginPath, { method: "POST", body: credentials(nextPassword) }), 200);
        assertStatus(await fresh.request(`/auth/session?scope=${scope}`), 200);
        release(); assertStatus(await rotating, 200);
        assertStatus(await fresh.request(`/auth/session?scope=${scope}`), 200);
        assertStatus(await oldCopy.request(`/auth/session?scope=${scope}`), 401);
        const session = await h.models.AuthSession.findOne({ scope, accountId: account._id }).lean();
        assert.equal(session.tokenVersion, scope === "patient" ? 3 : 1);
      } finally {
        clearTimeout(timer); release(); if (rotating) await rotating;
      }
    });
  }
});
