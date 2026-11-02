const test = require("node:test");
const assert = require("node:assert/strict");
const { reviewNotificationEmail } = require("../src/templates/reviewNotification");

const input = {
  patientName: "ผู้รับบริการตัวอย่าง",
  recordCount: 4,
  deadlineLabel: "2 พ.ย. 2569 23:59",
  approveUrl: "https://example.invalid/review-email?token=synthetic-only&action=approve",
  rejectUrl: "https://example.invalid/review-email?token=synthetic-only&action=reject",
};
const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({
  amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'",
})[entity]);
const links = html => [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
  .map(([, href, label]) => ({ href: decode(href), label: label.trim() }));

test("HTML and text review messages preserve both scoped actions and require a separate confirmation", () => {
  const mail = reviewNotificationEmail(input);
  assert.match(mail.subject, /มีบันทึกสุขภาพใหม่รอตรวจสอบ/);
  const actions = links(mail.html);
  assert.deepEqual(actions, [
    { href: input.approveUrl, label: "ยืนยัน" },
    { href: input.rejectUrl, label: "ยกเลิก" },
  ]);
  assert.equal(new URL(actions[0].href).searchParams.get("token"), new URL(actions[1].href).searchParams.get("token"));
  for (const value of [input.patientName, input.deadlineLabel, "4 รายการ"]) {
    assert.ok(mail.text.includes(value));
    assert.ok(mail.html.includes(value));
  }
  assert.ok(mail.text.includes(input.approveUrl));
  assert.ok(mail.text.includes(input.rejectUrl));
  assert.match(mail.text, /การเปิดลิงก์จะยังไม่เปลี่ยนสถานะ/);
  assert.match(mail.html, /กดยืนยันอีกครั้ง/);
  assert.doesNotMatch(mail.html, /<script\b|<iframe\b|<img\b|<form\b|http-equiv\s*=|\bsrc\s*=/i);
});

test("profile-only notifications do not invent health measurements or a health-record count", () => {
  const mail = reviewNotificationEmail({ ...input, patientName: "", recordCount: 0, profileOnly: true });
  assert.match(mail.subject, /ข้อมูลส่วนตัวใหม่/);
  for (const body of [mail.text, mail.html]) {
    assert.match(body, /ไม่ได้ระบุผลตรวจสุขภาพ/);
    assert.match(body, /ผู้ส่งข้อมูล/);
    assert.doesNotMatch(body, /0 รายการ|มีบันทึกสุขภาพใหม่ 0/);
  }
  assert.deepEqual(links(mail.html).map(a => a.href), [input.approveUrl, input.rejectUrl]);
});

test("untrusted names, deadlines and quoted capability URLs are escaped without changing the links", () => {
  const hostile = {
    ...input,
    patientName: '<img src=x onerror="run()"> & <script>run()</script>',
    deadlineLabel: '<iframe src="https://example.invalid">',
    approveUrl: input.approveUrl + '&label=" onclick="run()<value>',
    rejectUrl: input.rejectUrl + "&label='><img src=x>",
  };
  const mail = reviewNotificationEmail(hostile);
  assert.deepEqual(links(mail.html).map(a => a.href), [hostile.approveUrl, hostile.rejectUrl]);
  assert.doesNotMatch(mail.html, /<img\b|<script\b|<iframe\b|\bonclick="|\bonerror="/i);
  assert.ok(mail.html.includes('&lt;img src=x onerror=&quot;run()&quot;&gt;'));
  assert.ok(mail.text.includes(hostile.patientName));
});

test("review notification transport sends one multipart message with the requested recipient and no logging", async t => {
  const nodemailer = require("nodemailer");
  const sent = [];
  const transport = t.mock.method(nodemailer, "createTransport", () => ({
    sendMail: async options => { sent.push(options); return { accepted: [options.to] }; },
  }));
  const log = t.mock.method(console, "log", () => {});
  const error = t.mock.method(console, "error", () => {});
  const { sendReviewNotification } = require("../src/services/email.service");
  assert.equal(transport.mock.callCount(), 0);
  const result = await sendReviewNotification({ ...input, recipient: "staff@example.invalid" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "staff@example.invalid");
  assert.equal(sent[0].subject, reviewNotificationEmail(input).subject);
  assert.deepEqual(links(sent[0].html).map(a => a.href), [input.approveUrl, input.rejectUrl]);
  assert.ok(sent[0].text.includes(input.approveUrl));
  assert.deepEqual(result.accepted, ["staff@example.invalid"]);
  assert.equal(log.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 0);
});
