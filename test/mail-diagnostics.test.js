const test = require("node:test");
const assert = require("node:assert/strict");
const { smtpFailure } = require("../src/utils/mailDiagnostics");

test("SMTP authentication diagnostics retain only an allowlisted category, code, command and status", () => {
  const result = smtpFailure({ code: "EAUTH", responseCode: 535, command: "AUTH PLAIN",
    response: "535 5.7.8 Username and Password not accepted for private@example.test", message: "password=private-password", stack: "secret stack" });
  assert.deepEqual(result, { category: "authentication", code: "EAUTH", responseCode: 535, command: "AUTH PLAIN", enhancedStatus: "5.7.8" });
});

test("SMTP diagnostic categories distinguish quota, recipient, network, TLS and message rejection", () => {
  for (const [error, category] of [
    [{ code: "EMESSAGE", command: "DATA", responseCode: 550, response: "550 5.4.5 Daily user sending quota exceeded" }, "rate_quota"],
    [{ code: "EAUTH", command: "AUTH LOGIN", responseCode: 454, response: "454 4.7.0 Too many login attempts" }, "rate_quota"],
    [{ code: "EENVELOPE", command: "RCPT TO", responseCode: 550, response: "550 5.1.1 Recipient does not exist" }, "recipient_rejected"],
    [{ code: "ETIMEDOUT", command: "CONN" }, "network_timeout"],
    [{ code: "ENOTFOUND", command: "DNS" }, "network_timeout"],
    [{ code: "CERT_HAS_EXPIRED", command: "CONN" }, "tls"],
    [{ code: "ESOCKET", command: "STARTTLS", message: "TLS certificate failure" }, "tls"],
    [{ code: "EMESSAGE", command: "DATA", responseCode: 550, response: "550 5.7.1 Message policy rejection" }, "message_rejected"],
    [{ code: "EENVELOPE", command: "MAIL FROM", responseCode: 550 }, "message_rejected"],
  ]) assert.equal(smtpFailure(error).category, category);
});

test("untrusted error properties cannot inject recipients, passwords, tokens, URLs or freeform commands into diagnostics", () => {
  const secrets = ["private@example.test", "private-password", "https://secret.example/reset#token=private-token", "private-stack"];
  const result = smtpFailure({ code: secrets[0], responseCode: secrets[2], command: `MAIL FROM:<${secrets[0]}>`,
    enhancedStatus: `5.7.8 ${secrets[2]}`, message: secrets.join(" "), response: secrets.join(" "), stack: secrets[3], token: secrets[2], password: secrets[1] });
  assert.deepEqual(result, { category: "unknown", code: "UNKNOWN", responseCode: null, command: "UNKNOWN" });
  secrets.forEach(secret => assert.equal(JSON.stringify(result).includes(secret), false));
  assert.deepEqual(Object.keys(result).sort(), ["category", "code", "command", "responseCode"]);
});

test("enhanced SMTP status extraction is anchored and returns numeric components only", () => {
  assert.equal(smtpFailure({ response: "550-5.7.26 Message blocked for private@example.test" }).enhancedStatus, "5.7.26");
  for (const response of ["private@example.test 5.7.8", "https://secret.example/5.7.8", "550 5.7.8private@example.test", "550 5.7.1234 text"]) {
    assert.equal(smtpFailure({ response }).enhancedStatus, undefined);
  }
  assert.equal(smtpFailure({ responseCode: "535" }).responseCode, 535);
  for (const responseCode of [-1, 0, 999, NaN, {}, "535 private@example.test"]) assert.equal(smtpFailure({ responseCode }).responseCode, null);
});

test("missing or hostile error objects produce a fixed safe fallback", () => {
  for (const value of [null, undefined, "private@example.test", { get code() { throw new Error("private-password"); } }]) {
    assert.deepEqual(smtpFailure(value), { category: "unknown", code: "UNKNOWN", responseCode: null, command: "UNKNOWN" });
  }
});
