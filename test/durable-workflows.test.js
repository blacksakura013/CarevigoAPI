const { test } = require("node:test");
const assert = require("node:assert/strict");
const User = require("../src/models/User");
const Admin = require("../src/models/Admin");
const Health = require("../src/models/Health");
const Submission = require("../src/models/Submission");
const Outbox = require("../src/models/ReviewOutbox");
const email = require("../src/services/email.service");
const review = require("../src/services/review.service");
const profileController = require("../src/controllers/patient.auth.controller");
const agreements = require("./fixtures/legal-agreements.json").patient;
process.env.JWT_SECRET = "isolated-durable-workflow-secret";

function matches(row, filter) {
  return Object.entries(filter).every(([field, value]) => {
    if (field === "$and") return value.every(item => matches(row, item));
    if (field === "$or") return value.some(item => matches(row, item));
    const actual = row[field];
    if (value && typeof value === "object" && !(value instanceof Date)) {
      return Object.entries(value).every(([operator, expected]) => {
        if (operator === "$exists") return (actual !== undefined) === expected;
        if (operator === "$in") return expected.includes(actual);
        if (operator === "$lte") return actual <= expected;
        throw new Error(`Unsupported fixture operator ${operator}`);
      });
    }
    return actual === value;
  });
}
function apply(row, update) {
  Object.assign(row, update.$set);
  for (const [field, value] of Object.entries(update.$inc || {})) row[field] = (row[field] || 0) + value;
  for (const field of Object.keys(update.$unset || {})) delete row[field];
}

for (const newerSucceeds of [true, false]) test(`an expired mail worker cannot overwrite a newer worker's ${newerSucceeds ? "successful" : "failed"} result`, async t => {
  const now = new Date();
  const row = { _id: "507f1f77bcf86cd799439011", internalId: 9007199254740993n, status: "pending", attempts: 0,
    nextAttemptAt: new Date(0), expiresAt: new Date(now.getTime() + 86400000),
    submissionId: "507f1f77bcf86cd799439012", submissionKey: 9007199254740994n,
    adminId: "507f1f77bcf86cd799439013", adminKey: 9007199254740995n, recipient: "staff@example.test" };
  const source = { _id: row.submissionId, profile: { firstName: "Example" }, records: [{}], reviewDueAt: new Date(now.getTime() + 3600000) };
  t.mock.method(Outbox, "findOneAndUpdate", async (filter, update) => {
    if (!matches(row, filter)) return null;
    apply(row, update); return { ...row };
  });
  t.mock.method(Outbox, "updateOne", async (filter, update) => {
    if (!matches(row, filter)) return { matchedCount: 0, modifiedCount: 0 };
    apply(row, update); return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(Admin, "findOne", async () => ({ _id: row.adminId, internalId: row.adminKey, isActive: true }));
  t.mock.method(Submission, "findOne", async () => source);
  let started, finishOlder, calls = 0;
  const olderStarted = new Promise(resolve => { started = resolve; });
  t.mock.method(email, "sendReviewNotification", async () => {
    calls++;
    if (calls === 1) return new Promise((resolve, reject) => { finishOlder = newerSucceeds ? () => reject(new Error("Old SMTP timeout")) : resolve; started(); });
    if (!newerSucceeds) throw new Error("New SMTP timeout");
  });
  const older = review.sendOutbox(new Date(now.getTime() - 6 * 60000));
  await olderStarted;
  const oldLease = row.leaseId;
  assert.equal(typeof oldLease, "string");
  await review.sendOutbox(now);
  assert.equal(row.status, newerSucceeds ? "sent" : "failed");
  const durableResult = { ...row };
  finishOlder(); await older;
  assert.deepEqual(row, durableResult, "A stale completion must leave the current result untouched");
  assert.equal(row.attempts, 2); assert.equal(calls, 2);
  assert.equal(row.leaseUntil, undefined); assert.equal(row.leaseId, undefined);
});

test("a saved profile remains successful if the later CV refresh fails and a future me request can recover it", async t => {
  const account = { _id: "507f1f77bcf86cd799439011", internalId: 9007199254740993n, citizenId: "1234567890123", firstName: "Before",
    thaiCvRisk: { status: "incomplete", missing: ["birthDate"] }, legalAgreementHistory: [] };
  let changes = 0, online = false;
  t.mock.method(User, "findOneAndUpdate", async (filter, update) => {
    if (update.$push) { changes++; account.legalAgreementHistory.push(update.$push.legalAgreementHistory); }
    Object.assign(account, update.$set); return account;
  });
  t.mock.method(User, "findOne", async () => { if (!online) throw new Error("Temporary assessment read failure"); return account; });
  t.mock.method(Health, "findOne", () => ({ sort: async () => null }));
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const saved = response();
  await profileController.updateMe({ patient: account, user: { id: account._id, internalId: account.internalId }, body: { firstName: "After", agreements } }, saved);
  assert.equal(saved.statusCode, 200); assert.equal(saved.body.data.patient.firstName, "After");
  assert.equal(saved.body.data.assessmentRefreshPending, true);
  assert.equal(saved.body.data.thaiCvRisk, account.thaiCvRisk);
  assert.equal(changes, 1); assert.equal(account.legalAgreementHistory.length, 1);
  online = true;
  const restored = response(); await profileController.me({ patient: account }, restored);
  assert.equal(restored.statusCode, 200); assert.equal(restored.body.data.patient.firstName, "After");
  assert.equal(restored.body.data.thaiCvRisk.status, "incomplete");
  assert.equal(changes, 1); assert.equal(account.legalAgreementHistory.length, 1);
});
