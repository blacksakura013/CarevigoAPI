const test = require("node:test");
const assert = require("node:assert/strict");
const Admin = require("../src/models/Admin");
const email = require("../src/services/email.service");
const reset = require("../src/controllers/passwordReset.controller");
const tokens = require("../src/services/token.service");
const { credentialVersion, versionFilter } = require("../src/utils/adminCredentials");
const result = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });

function environment(t, mode = "development") {
  const names = ["NODE_ENV", "CORS_ALLOWED_ORIGINS", "FRONTEND_URL", "JWT_SECRET", "JWT_REFRESH_SECRET"];
  const previous = Object.fromEntries(names.map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.NODE_ENV = mode;
  delete process.env.CORS_ALLOWED_ORIGINS;
  process.env.FRONTEND_URL = "https://carevigo-frontend.onrender.com";
  process.env.JWT_SECRET = "reset-unit-test-secret";
  process.env.JWT_REFRESH_SECRET = "reset-unit-test-refresh";
}

test("reset links use the trusted local requesting origin in development and configured allowlisted HTTPS origin in production", t => {
  environment(t);
  assert.equal(reset.frontendOrigin({ headers: { origin: "http://localhost:3001", host: "evil.example" } }), "http://localhost:3001");
  assert.equal(reset.frontendOrigin({ headers: { origin: "http://127.0.0.1:3001" } }), "http://127.0.0.1:3001");
  process.env.NODE_ENV = "production";
  assert.equal(reset.frontendOrigin({ headers: { origin: "http://localhost:3000", host: "evil.example" } }), "https://carevigo-frontend.onrender.com");
  for (const value of ["https://evil.example", "https://user:password@carevigo-frontend.onrender.com", "http://carevigo-frontend.onrender.com", "invalid"]) {
    process.env.FRONTEND_URL = value;
    assert.equal(reset.frontendOrigin({ headers: { origin: "http://localhost:3000" } }), null);
  }
});

test("forgot-password responds generically before slow email delivery and never stores the raw capability", async t => {
  environment(t);
  let delivered, finish;
  t.mock.method(Admin, "findOneAndUpdate", async (filter, update) => {
    assert.equal(filter.email, "staff@example.test"); assert.equal(filter.isActive, true);
    assert.match(update.$set.passwordResetTokenHash, /^[a-f0-9]{64}$/);
    assert.equal(update.$set.passwordResetExpiresAt - update.$set.passwordResetRequestedAt, 30 * 60000);
    return { _id: "507f1f77bcf86cd799439011", internalId: 9007199254740993n, email: filter.email };
  });
  t.mock.method(email, "sendAdminPasswordReset", message => {
    delivered = message; return new Promise(resolve => { finish = resolve; });
  });
  const res = result();
  await reset.forgot({ headers: { origin: "http://localhost:3001" }, body: { email: " Staff@example.test " } }, res);
  assert.equal(res.code, 202); assert.equal(res.body.data, null);
  assert.ok(delivered); assert.equal(delivered.recipient, "staff@example.test");
  const link = new URL(delivered.resetUrl);
  assert.equal(link.search, ""); assert.equal(link.pathname, "/admin/reset-password");
  assert.match(new URLSearchParams(link.hash.slice(1)).get("token"), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(res.body).includes("staff@example.test"), false);
  finish(); await reset.flushDeliveries();
});

test("unknown, malformed, and unavailable forgot requests share the same public response without echoing input", async t => {
  environment(t);
  const find = t.mock.method(Admin, "findOneAndUpdate", async () => null);
  const send = t.mock.method(email, "sendAdminPasswordReset", async () => { throw new Error("Unexpected mail"); });
  const responses = [];
  for (const value of ["unknown@example.test", "not-an-email", { $ne: null }, null]) {
    const res = result(); await reset.forgot({ headers: { origin: "http://localhost:3001" }, body: { email: value } }, res);
    responses.push(res.body); assert.equal(res.code, 202);
  }
  find.mock.mockImplementation(async () => { throw new Error("Private connection details"); });
  const unavailable = result(); await reset.forgot({ headers: { origin: "http://localhost:3001" }, body: { email: "unavailable@example.test" } }, unavailable);
  responses.push(unavailable.body);
  responses.forEach(body => assert.deepEqual(body, responses[0]));
  assert.equal(send.mock.callCount(), 0);
});

test("failed recovery delivery records only safe SMTP diagnostics while keeping the generic response and clearing its capability", async t => {
  environment(t);
  const privateEmail = "private-staff@example.test";
  const privateUrl = "https://trusted.example/admin/reset-password#token=private-capability";
  t.mock.method(Admin, "findOneAndUpdate", async () => ({ _id: "507f1f77bcf86cd799439011", email: privateEmail }));
  const cleanup = t.mock.method(Admin, "updateOne", async () => ({}));
  const warn = t.mock.method(console, "warn", () => {});
  t.mock.method(email, "sendAdminPasswordReset", async () => {
    throw Object.assign(new Error(`${privateEmail} ${privateUrl} private-password`), {
      code: "EAUTH", command: "AUTH PLAIN", responseCode: 535,
      response: `535 5.7.8 ${privateEmail} ${privateUrl} private-password`,
    });
  });
  const res = result();
  await reset.forgot({ headers: { origin: "http://localhost:3001" }, body: { email: privateEmail } }, res);
  await reset.flushDeliveries();
  assert.equal(res.code, 202);
  assert.equal(cleanup.mock.callCount(), 1);
  assert.match(cleanup.mock.calls[0].arguments[0].passwordResetTokenHash, /^[a-f0-9]{64}$/);
  const diagnostic = warn.mock.calls[0].arguments[1];
  assert.equal(diagnostic.outcome, "failed");
  assert.equal(diagnostic.category, "authentication");
  assert.equal(diagnostic.responseCode, 535);
  assert.doesNotMatch(JSON.stringify(warn.mock.calls), /private-staff|private-capability|private-password|trusted\.example/);
  assert.equal(res.body.data, null);
});

test("invalid recovery values never reach storage or hashing and password confirmation is exact", async t => {
  const find = t.mock.method(Admin, "findOne", async () => { throw new Error("Unexpected lookup"); });
  for (const token of [null, [], { $ne: null }, "short", "!".repeat(43)]) {
    const res = result(); await reset.validate({ body: { token } }, res);
    assert.equal(res.code, 400); assert.equal(res.body.code, "RESET_LINK_INVALID");
  }
  for (const [password, confirmPassword] of [["short", "short"], ["long-password", "long-password "], ["ก".repeat(25), "ก".repeat(25)], [[], []]]) {
    const res = result(); await reset.reset({ body: { token: "a".repeat(43), password, confirmPassword } }, res);
    assert.equal(res.code, 400); assert.equal(res.body.code, "PASSWORD_INVALID");
  }
  assert.equal(find.mock.callCount(), 0);
  assert.equal(reset.validPassword("ก".repeat(24)), true); assert.equal(reset.validPassword("a".repeat(72)), true);
});

test("staff token pairs and refresh preserve the credential version while versionless compatibility represents zero only", t => {
  environment(t);
  const pair = tokens.generateTokenPair({ id: "507f1f77bcf86cd799439011", type: "admin", role: "admin", tokenVersion: 4 });
  assert.equal(tokens.verifyAccessToken(pair.accessToken).tokenVersion, 4);
  assert.equal(tokens.verifyRefreshToken(pair.refreshToken).tokenVersion, 4);
  assert.equal(tokens.verifyAccessToken(tokens.refreshToken(pair.refreshToken).accessToken).tokenVersion, 4);
  assert.equal(credentialVersion({}), 0);
  assert.deepEqual(versionFilter(0), { $or: [{ tokenVersion: 0 }, { tokenVersion: { $exists: false } }] });
  for (const tokenVersion of [-1, null, "1", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    if (tokenVersion === null) continue;
    assert.throws(() => credentialVersion({ tokenVersion }));
  }
});
