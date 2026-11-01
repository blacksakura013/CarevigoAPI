const test = require("node:test");
const assert = require("node:assert/strict");
const nodemailer = require("nodemailer");

test("password recovery email offers a large Thai HTML button plus plaintext without remote assets, raw attribute injection or logging", async t => {
  let sent;
  t.mock.method(nodemailer, "createTransport", () => ({ sendMail: async options => { sent = options; return { accepted: [options.to] }; } }));
  const log = t.mock.method(console, "log", () => {});
  const error = t.mock.method(console, "error", () => {});
  const resetUrl = 'https://trusted.example/admin/reset-password#token=sample" onclick="injected<value>';
  await require("../src/services/email.service").sendAdminPasswordReset({ recipient: "staff@example.test", resetUrl });
  assert.equal(sent.to, "staff@example.test");
  assert.equal(sent.text.includes(resetUrl), true);
  assert.match(sent.html, /ตั้งรหัสผ่านใหม่<\/a>/);
  assert.match(sent.html, /font-size:18px/); assert.match(sent.html, /padding:16px 24px/);
  assert.match(sent.html, /&quot; onclick=&quot;injected&lt;value&gt;/);
  assert.equal(sent.html.includes('onclick="'), false);
  assert.doesNotMatch(sent.html, /<img|<script|<iframe|src=/i);
  assert.equal(log.mock.callCount(), 0); assert.equal(error.mock.callCount(), 0);
});
