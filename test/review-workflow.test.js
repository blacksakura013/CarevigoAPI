const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const User = require("../src/models/User");
const Health = require("../src/models/Health");
const Admin = require("../src/models/Admin");
const Submission = require("../src/models/Submission");
const Outbox = require("../src/models/ReviewOutbox");
const email = require("../src/services/email.service");
const review = require("../src/services/review.service");
const { refreshUserThaiCvRisk } = require("../src/services/thaiCvRisk.service");
const { reviewDeadline, tokenFor, hashToken } = require("../src/utils/review");
const internalIds = require("../src/services/internalIds.service");
const { jsonReplacer } = require("../src/utils/json");
process.env.JWT_SECRET = "isolated-review-workflow-test-secret";
const id = () => new mongoose.Types.ObjectId();
const citizenId = "1234567890123";
let serverCount = 0;
const read = (row, path) => path.split(".").reduce((value, key) => value?.[key], row);
const scalar = value => value instanceof Date ? value.getTime() : value?.toHexString ? value.toHexString() : value?._bsontype === "Long" ? value.toBigInt() : value;
function matches(row, filter) {
  return Object.entries(filter || {}).every(([key, expected]) => {
    if (key === "$and") return expected.every(item => matches(row, item));
    if (key === "$or") return expected.some(item => matches(row, item));
    const actual = read(row, key);
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !expected.toHexString) {
      return Object.entries(expected).every(([operator, value]) => {
        if (operator === "$exists") return (actual !== undefined) === value;
        if (operator === "$elemMatch") return Array.isArray(actual) && actual.some(item => matches(item, value));
        if (operator === "$in") return value.some(item => scalar(item) === scalar(actual));
        if (operator === "$nin") return !value.some(item => scalar(item) === scalar(actual));
        if (operator === "$ne") return scalar(actual) !== scalar(value);
        if (operator === "$lte") return scalar(actual) <= scalar(value);
        if (operator === "$gt") return scalar(actual) > scalar(value);
        if (operator === "$regex") return new RegExp(value, expected.$options).test(actual || "");
        if (operator === "$options") return true;
        throw new Error(`Unsupported test operator ${operator}`);
      });
    }
    return scalar(actual) === scalar(expected);
  });
}
function query(rows, single = false) {
  let offset = 0, maximum = Infinity;
  const result = { select() { return this; }, populate() { return this; }, setOptions() { return this; },
    sort(fields) { rows = [...rows].sort((a, b) => { for (const [key, direction] of Object.entries(fields)) { const av = scalar(read(a, key)), bv = scalar(read(b, key)); if (av < bv) return -direction; if (av > bv) return direction; } return 0; }); return this; },
    skip(value) { offset = value; return this; }, limit(value) { maximum = value; return this; },
    then(resolve, reject) { const selected = rows.slice(offset, offset + maximum); return Promise.resolve(single ? selected[0] || null : selected).then(resolve, reject); } };
  return result;
}
const doc = value => ({ select() { return this; }, sort() { return this; }, setOptions() { return this; }, then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) });
function elementFilter(filter, field) {
  if (filter[field]?.$elemMatch) return filter[field].$elemMatch;
  for (const key of ["$and", "$or"]) for (const nested of filter[key] || []) { const found = elementFilter(nested, field); if (found) return found; }
}
function apply(row, update, filter = {}) {
  for (const [key, value] of Object.entries(update.$set || {})) {
    const parts = key.split("."); let target = row;
    for (let index = 0; index < parts.length - 1; index++) {
      if (parts[index + 1] === "$") { target = target[parts[index]].find(item => matches(item, elementFilter(filter, parts[index]))); index++; }
      else target = target[parts[index]] ||= {};
    }
    target[parts.at(-1)] = value;
  }
  for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value;
  for (const [key, value] of Object.entries(update.$push || {})) (row[key] ||= []).push(value);
  for (const key of Object.keys(update.$unset || {})) delete row[key];
  return row;
}

function storeFor(t) {
  const state = { users: [], records: [], submissions: [], jobs: [], admins: [{ _id: new mongoose.Types.ObjectId("507f1f77bcf86cd799439099"), role: "admin", email: "active@example.test", isActive: true }], healthFailure: false, mailFailure: false };
  const counters = new Map();
  const allocate = (namespace, count = 1) => { const start = counters.get(namespace) || 9007199254740993n; counters.set(namespace, start + BigInt(count)); return Array.from({ length: count }, (_, index) => start + BigInt(index)); };
  t.mock.method(internalIds, "allocateInternalId", async namespace => allocate(namespace)[0]);
  t.mock.method(internalIds, "allocateInternalIds", async (namespace, count) => allocate(namespace, count));
  t.mock.method(internalIds, "ensureInternalId", async (Model, documentOrId) => {
    const tables = { User: state.users, Health: state.records, Admin: state.admins, Submission: state.submissions, ReviewOutbox: state.jobs };
    const supplied = documentOrId?._id !== undefined ? documentOrId : null;
    const row = supplied || tables[Model.modelName].find(item => scalar(item._id) === scalar(documentOrId));
    if (!row) throw new Error(`${Model.modelName} identity does not exist`);
    if (row.internalId === undefined) row.internalId = allocate(Model.modelName)[0];
    return internalIds.toInternalId(row.internalId);
  });
  t.mock.method(Health.collection, "updateOne", async (filter, update) => {
    const row = state.records.find(item => matches(item, filter)); if (row) apply(row, update, filter);
    return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
  });
  t.mock.method(Submission.collection, "updateOne", async (filter, update) => {
    const row = state.submissions.find(item => matches(item, filter)); if (row) apply(row, update, filter);
    return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
  });
  t.mock.method(User, "findOneAndUpdate", (filter, update) => {
    let user = state.users.find(row => matches(row, filter));
    if (!user) { user = { _id: id(), ...update.$setOnInsert }; state.users.push(user); }
    return doc(apply(user, update));
  });
  t.mock.method(User, "findOne", filter => doc(state.users.find(row => matches(row, filter)) || null));
  t.mock.method(User, "findById", userId => doc(state.users.find(row => scalar(row._id) === String(userId)) || null));
  t.mock.method(User, "findByIdAndUpdate", async (userId, update) => {
    const user = state.users.find(row => scalar(row._id) === String(userId));
    return user ? apply(user, update) : null;
  });
  t.mock.method(Health, "updateOne", async (filter, update, options = {}) => {
    if (state.healthFailure) { state.healthFailure = false; throw new Error("Simulated interrupted record write"); }
    let row = state.records.find(item => matches(item, filter));
    if (!row && options.upsert) { row = { ...update.$setOnInsert }; state.records.push(row); }
    if (!row) return { matchedCount: 0, modifiedCount: 0 };
    return apply(row, update, filter);
  });
  t.mock.method(Health, "find", filter => query(state.records.filter(row => matches(row, filter))));
  t.mock.method(Health, "findOne", filter => query(state.records.filter(row => matches(row, filter)), true));
  t.mock.method(Health, "countDocuments", async filter => state.records.filter(row => matches(row, filter)).length);
  t.mock.method(Health, "findOneAndUpdate", async (filter, update) => {
    const row = state.records.find(item => matches(item, filter)); return row ? apply(row, update) : null;
  });
  t.mock.method(Health, "updateMany", async (filter, update) => { state.records.filter(row => matches(row, filter)).forEach(row => apply(row, update)); });
  t.mock.method(Submission, "create", async data => { state.submissions.push(data); return data; });
  t.mock.method(Submission, "findOne", filter => doc(state.submissions.find(row => matches(row, filter)) || null));
  t.mock.method(Submission, "findById", async submissionId => state.submissions.find(row => scalar(row._id) === String(submissionId)) || null);
  t.mock.method(Submission, "find", filter => query(state.submissions.filter(row => matches(row, filter))));
  t.mock.method(Submission, "countDocuments", async filter => state.submissions.filter(row => matches(row, filter)).length);
  t.mock.method(Submission, "findOneAndUpdate", async (filter, update) => {
    const row = state.submissions.find(item => matches(item, filter)); return row ? apply(row, update) : null;
  });
  t.mock.method(Submission, "updateOne", async (filter, update) => { const row = state.submissions.find(item => matches(item, filter)); if (row) apply(row, update, filter); return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 }; });
  t.mock.method(Admin, "find", async filter => state.admins.filter(row => matches(row, filter)));
  t.mock.method(Admin, "findOne", async filter => state.admins.find(row => matches(row, filter)) || null);
  t.mock.method(Admin, "findById", async value => state.admins.find(row => scalar(row._id) === String(value)) || null);
  t.mock.method(Admin, "countDocuments", async filter => state.admins.filter(row => matches(row, filter)).length);
  t.mock.method(Outbox, "updateOne", async (filter, update) => {
    let row = state.jobs.find(item => matches(item, filter));
    if (!row && update.$setOnInsert) { row = { attempts: 0, createdAt: new Date(), ...update.$setOnInsert }; state.jobs.push(row); }
    return row ? apply(row, update) : null;
  });
  t.mock.method(Outbox, "findOne", filter => doc(state.jobs.find(row => matches(row, filter)) || null));
  t.mock.method(Outbox, "findOneAndUpdate", async (filter, update) => { const row = state.jobs.find(item => matches(item, filter)); return row ? apply(row, update) : null; });
  t.mock.method(Outbox, "aggregate", async () => Object.entries(state.jobs.reduce((counts, row) => ({ ...counts, [row.status]: (counts[row.status] || 0) + 1 }), {})).map(([_id, total]) => ({ _id, total })));
  t.mock.method(email, "sendReviewNotification", async () => { if (state.mailFailure) throw new Error("Simulated SMTP failure"); });
  return state;
}

async function serverFor(t) {
  const app = express(); app.set("trust proxy", 1); app.set("json replacer", jsonReplacer); app.use(express.json());
  app.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.use("/api/public", require("../src/routes/public.routes"));
  app.use("/api/reviews", require("../src/routes/review.routes"));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const ip = `203.0.113.${++serverCount}`;
  return async (path, { body, token, method = "GET" } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method,
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
}
const batch = extra => ({ citizenId, clientRequestId: crypto.randomUUID(), agreements: require("./fixtures/legal-agreements.json").patient,
  profile: { firstName: "Submitted", lastName: "Name", gender: "male", birthDate: "19761101", smokingStatus: "never", chronicDiseasesConfirmed: true, chronicDiseases: [] },
  records: [{ type: "blood_pressure", value: { systolic: 120, diastolic: 80 } }, { type: "cholesterol", value: { total: 200 } }], ...extra });
const staffToken = () => jwt.sign({ id: "507f1f77bcf86cd799439099", type: "admin", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

test("review deadline is exactly the submission day's 23:59 in Bangkok, including after the deadline", () => {
  assert.equal(reviewDeadline(new Date("2026-11-01T01:00:00Z")).toISOString(), "2026-11-01T16:59:00.000Z");
  assert.equal(reviewDeadline(new Date("2026-11-01T16:59:30Z")).toISOString(), "2026-11-01T16:59:00.000Z");
  assert.equal(reviewDeadline(new Date("2026-11-01T17:00:00Z")).toISOString(), "2026-11-02T16:59:00.000Z");
});

test("guest batch persists pending records and outbox jobs without exposing or overwriting an existing profile", async (t) => {
  const state = storeFor(t), request = await serverFor(t);
  state.users.push({ _id: id(), citizenId, firstName: "PRIVATE EXISTING", accountEnabled: true });
  state.admins.push({ _id: id(), email: "second@example.test", isActive: true }, { _id: id(), email: "disabled@example.test", isActive: false });
  const input = batch(); input.profile.accountEnabled = false; input.profile.passwordHash = "forged";
  const res = await request("/public/submissions", { method: "POST", body: input });
  assert.equal(res.status, 202); assert.equal(state.records.length, 2); assert.equal(state.jobs.length, 2);
  assert.equal(state.users[0].firstName, "PRIVATE EXISTING"); assert.equal(state.users[0].accountEnabled, true);
  assert.ok(!JSON.stringify(res.body).includes("PRIVATE EXISTING"));
  assert.ok(state.records.every(row => row.reviewStatus === "pending" && row.submittedProfile.firstName === "Submitted" && row.reviewHistory[0].status === "pending"));
  assert.ok(state.jobs.every(job => job.tokenHash && !job.token));
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("identical retry recovers an interrupted durable submission without duplicate rows or notification jobs", async (t) => {
  const state = storeFor(t), request = await serverFor(t), input = batch();
  state.healthFailure = true;
  const first = await request("/public/submissions", { method: "POST", body: input });
  assert.equal(first.status, 202); assert.equal(state.submissions.length, 1); assert.equal(state.records.length, 0);
  const retry = await request("/public/submissions", { method: "POST", body: input });
  assert.equal(retry.status, 202); assert.equal(state.records.length, 2); assert.equal(state.jobs.length, 1);
  assert.equal(retry.body.data.submissionId, first.body.data.submissionId); assert.equal(retry.body.data.receiptToken, first.body.data.receiptToken);
  assert.equal(state.submissions[0].materialized, true);
  const different = batch({ ...input, records: [{ type: "sugar", value: { fbs: 100 } }] });
  assert.equal((await request("/public/submissions", { method: "POST", body: different })).status, 409);
});

test("receipt token only reveals its own submission and anonymous citizen history remains protected", async (t) => {
  const state = storeFor(t), request = await serverFor(t);
  const saved = await request("/public/submissions", { method: "POST", body: batch() });
  const { submissionId, receiptToken } = saved.body.data;
  // Avoid clock-dependent catch-up here; future deadline is confined to this fixture.
  state.records.forEach(row => { row.reviewDueAt = new Date(Date.now() + 600000); });
  state.records.push({ _id: id(), submissionId: id(), citizenId, type: "sugar", value: { fbs: 777 }, reviewStatus: "approved" });
  const receipt = await request(`/public/submissions/${submissionId}?token=${receiptToken}`);
  assert.equal(receipt.status, 200); assert.equal(receipt.body.data.records.length, 2);
  assert.ok(receipt.body.data.records.every(row => row.type !== "sugar" && row.citizenId === undefined));
  assert.equal((await request(`/public/submissions/${submissionId}?token=${"x".repeat(43)}`)).status, 404);
  assert.equal((await request(`/public/health?citizenId=${citizenId}`)).status, 401);
});

test("all decision uses its explicit filter and cutoff and rejected records retain history", async (t) => {
  const state = storeFor(t), request = await serverFor(t), now = Date.now();
  const record = (createdAt, firstName) => ({ _id: id(), userId: id(), citizenId, type: "sugar", value: { fbs: 100 }, createdAt,
    reviewStatus: "pending", submittedProfile: { firstName }, reviewHistory: [{ status: "pending" }] });
  state.records.push(record(new Date(now - 3000), "Chosen"), record(new Date(now - 2000), "Chosen"), record(new Date(now), "Chosen"), record(new Date(now - 3000), "Other"));
  const res = await request("/reviews/decision", { token: staffToken(), method: "POST", body: { all: true, filters: { status: "pending", search: "Chosen" }, cutoff: new Date(now - 1000).toISOString(), action: "reject", reason: "Duplicate" } });
  assert.equal(res.status, 200); assert.equal(res.body.data.changed, 2);
  assert.deepEqual(state.records.map(row => row.reviewStatus), ["rejected", "rejected", "pending", "pending"]);
  assert.equal(state.records.length, 4); assert.equal(state.records[0].reviewHistory.length, 2);
  assert.equal(state.records[0].reviewHistory[1].status, "rejected");
  const again = await request("/reviews/decision", { token: staffToken(), method: "POST", body: { ids: [String(state.records[0]._id)], action: "approve" } });
  assert.equal(again.body.data.changed, 0); assert.equal(again.body.data.skipped, 1); assert.equal(state.records[0].reviewHistory.length, 2);
});

test("racing admin, email and automatic decisions create only one state transition", async (t) => {
  const state = storeFor(t), row = { _id: id(), userId: id(), reviewStatus: "pending", reviewHistory: [] };
  state.records.push(row);
  const changes = await Promise.all(["admin", "email", "automatic"].map(source => review.decidePending({ _id: row._id }, { action: source === "email" ? "reject" : "approve", source })));
  assert.equal(changes.reduce((sum, count) => sum + count, 0), 1);
  assert.equal(row.reviewHistory.length, 1); assert.ok(["approved", "rejected"].includes(row.reviewStatus));
});

test("automatic catch-up only approves overdue pending records", async (t) => {
  const state = storeFor(t), now = new Date("2026-11-01T16:59:01Z");
  state.records.push(
    { _id: id(), userId: id(), reviewStatus: "pending", reviewDueAt: new Date("2026-11-01T16:59:00Z"), reviewHistory: [] },
    { _id: id(), userId: id(), reviewStatus: "pending", reviewDueAt: new Date("2026-11-02T16:59:00Z"), reviewHistory: [] },
    { _id: id(), userId: id(), reviewStatus: "rejected", reviewDueAt: new Date("2026-11-01T16:59:00Z"), reviewHistory: [] });
  assert.equal(await review.approveOverdue(now), 1);
  assert.deepEqual(state.records.map(row => row.reviewStatus), ["approved", "pending", "rejected"]);
  assert.equal(state.records[0].reviewHistory[0].source, "automatic");
});

test("email GET never mutates, confirmation is scoped, and duplicate decisions cannot reverse status", async (t) => {
  const state = storeFor(t), request = await serverFor(t);
  await request("/public/submissions", { method: "POST", body: batch() });
  const job = state.jobs[0], token = tokenFor("email-review", job._id, job.submissionId, job.adminId);
  state.records.forEach(row => { row.reviewDueAt = new Date(Date.now() + 600000); });
  state.records.push({ _id: id(), submissionId: id(), userId: id(), type: "sugar", value: { fbs: 500 }, reviewStatus: "pending", reviewHistory: [] });
  const opened = await request(`/reviews/email?token=${token}&action=approve`);
  assert.equal(opened.status, 200); assert.equal(opened.body.data.canDecide, true); assert.equal(opened.body.data.records.length, 2);
  assert.ok(state.records.every(row => row.reviewStatus === "pending"));
  assert.equal(opened.body.data.maskedCitizenId, "1********0123");
  const confirmed = await request("/reviews/email", { method: "POST", body: { token, action: "reject" } });
  assert.equal(confirmed.body.data.changed, 2); assert.equal(state.records[2].reviewStatus, "pending");
  const duplicate = await request("/reviews/email", { method: "POST", body: { token, action: "approve" } });
  assert.equal(duplicate.body.data.changed, 0); assert.equal(duplicate.body.data.skipped, 2);
  job.expiresAt = new Date(Date.now() - 1);
  assert.equal((await request(`/reviews/email?token=${token}`)).status, 410);
});

test("email delivery failure is durable and retried without undoing the saved submission", async (t) => {
  const state = storeFor(t), request = await serverFor(t);
  const saved = await request("/public/submissions", { method: "POST", body: batch() });
  assert.equal(saved.status, 202);
  state.mailFailure = true;
  await review.sendOutbox(new Date(Date.now() + 1000));
  assert.equal(state.jobs[0].status, "failed"); assert.equal(state.records.length, 2);
  state.mailFailure = false;
  await review.sendOutbox(new Date(state.jobs[0].nextAttemptAt.getTime() + 1));
  assert.equal(state.jobs[0].status, "sent"); assert.equal(state.jobs[0].attempts, 2);
  const sent = email.sendReviewNotification.mock.calls.at(-1).arguments[0];
  const raw = new URL(sent.approveUrl).searchParams.get("token");
  assert.equal(hashToken(raw), state.jobs[0].tokenHash);
  assert.ok(!JSON.stringify(state.jobs[0], jsonReplacer).includes(raw));
});

test("Thai CV uses approved or legacy measurements and excludes newer pending/rejected results", async (t) => {
  const state = storeFor(t), user = { _id: id(), citizenId, birthDate: "19761101", gender: "male", smokingStatus: "never", chronicDiseasesConfirmed: true, chronicDiseases: [] };
  state.users.push(user);
  const row = (type, value, reviewStatus, day) => ({ _id: id(), userId: user._id, citizenId, type, value, reviewStatus, createdAt: new Date(`2026-10-${day}T00:00:00Z`) });
  state.records.push(row("blood_pressure", { systolic: 120 }, "approved", "20"), row("cholesterol", { total: 200 }, undefined, "20"), row("blood_pressure", { systolic: 220 }, "rejected", "31"), row("cholesterol", { total: 280 }, "pending", "31"));
  const risk = await refreshUserThaiCvRisk(user);
  assert.equal(risk.inputs.systolic, 120); assert.equal(risk.inputs.totalCholesterol, 200);
});

test("email POST after the deadline catches up automatic approval before a late rejection", async (t) => {
  const state = storeFor(t), request = await serverFor(t);
  await request("/public/submissions", { method: "POST", body: batch() });
  state.records.forEach(row => { row.reviewDueAt = new Date(Date.now() - 1000); });
  const job = state.jobs[0], token = tokenFor("email-review", job._id, job.submissionId, job.adminId);
  const late = await request("/reviews/email", { method: "POST", body: { token, action: "reject" } });
  assert.equal(late.status, 200); assert.equal(late.body.data.changed, 0);
  assert.ok(state.records.every(row => row.reviewStatus === "approved" && row.reviewSource === "automatic"));
});

test("outbox stops retrying expired review links and never sends a dead link", async (t) => {
  const state = storeFor(t), request = await serverFor(t);
  await request("/public/submissions", { method: "POST", body: batch() });
  state.jobs[0].expiresAt = new Date(Date.now() - 1);
  await review.sendOutbox(new Date(Date.now() + 1000));
  assert.equal(state.jobs[0].status, "expired");
  assert.equal(email.sendReviewNotification.mock.callCount(), 0);
});

test("recovered old clinical records keep their clinical date and remain outside a prior review snapshot", async (t) => {
  const state = storeFor(t), request = await serverFor(t);
  const original = new Date(Date.now() - 600000), cutoff = new Date(Date.now() - 300000);
  const submission = { _id: id(), userId: id(), citizenId, profile: { firstName: "Recovered" }, submittedAt: original,
    reviewDueAt: new Date(Date.now() + 600000), records: [{ _id: id(), type: "sugar", value: { fbs: 99 } }] };
  state.submissions.push(submission);
  await review.materializeSubmission(submission);
  assert.equal(state.records[0].createdAt.getTime(), original.getTime());
  assert.ok(state.records[0].materializedAt > cutoff);
  const result = await request("/reviews/decision", { token: staffToken(), method: "POST", body: {
    all: true, filters: { status: "pending" }, cutoff: cutoff.toISOString(), action: "approve"
  } });
  assert.equal(result.status, 200); assert.equal(result.body.data.changed, 0);
  assert.equal(state.records[0].reviewStatus, "pending");
});

test("approved guest snapshot can calculate from submitted demographics without overwriting an incomplete existing profile", async (t) => {
  const state = storeFor(t), request = await serverFor(t);
  state.users.push({ _id: id(), citizenId, firstName: "Existing", chronicDiseasesConfirmed: false });
  const saved = await request("/public/submissions", { method: "POST", body: batch() });
  state.records.forEach(row => { row.reviewDueAt = new Date(Date.now() + 600000); });
  const approved = await request("/reviews/decision", { token: staffToken(), method: "POST", body: { ids: saved.body.data.recordIds, action: "approve" } });
  assert.equal(approved.status, 200); assert.equal(approved.body.data.changed, 2);
  assert.equal(state.users[0].firstName, "Existing"); assert.equal(state.users[0].birthDate, undefined);
  assert.equal(state.users[0].thaiCvRisk.status, "incomplete");
  assert.ok(state.records.every(row => row.thaiCvRisk.status === "calculated" && row.thaiCvRisk.inputs.profileSource === "submitted-profile"));
});

test("staff queue/settings are protected and own authenticated history includes all review states", async (t) => {
  const state = storeFor(t), request = await serverFor(t);
  const user = { _id: id(), citizenId, accountEnabled: true, tokenVersion: 3, requiresPasswordChange: false };
  state.users.push(user);
  for (const reviewStatus of ["pending", "approved", "rejected"]) state.records.push({ _id: id(), userId: user._id, citizenId,
    type: "sugar", value: { fbs: 100 }, reviewStatus, createdAt: new Date(Date.now() - 1000), reviewDueAt: new Date(Date.now() + 600000),
    reviewHistory: [{ status: reviewStatus, source: "admin", at: new Date() }] });
  const token = jwt.sign({ id: String(user._id), type: "patient", role: "user", tokenVersion: 3 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  assert.equal((await request("/reviews")).status, 401);
  assert.equal((await request("/reviews", { token })).status, 403);
  const history = await request(`/public/health?citizenId=${citizenId}`, { token });
  assert.equal(history.status, 200); assert.equal(history.body.total, 3);
  assert.deepEqual(new Set(history.body.data.map(row => row.reviewStatus)), new Set(["pending", "approved", "rejected"]));
  const queue = await request("/reviews?status=pending", { token: staffToken() });
  assert.equal(queue.status, 200); assert.equal(queue.body.total, 1); assert.ok(queue.body.snapshotAt);
  const settings = await request("/reviews/settings", { token: staffToken() });
  assert.equal(settings.status, 200); assert.equal(settings.body.data.autoApprovalTime, "23:59");
  assert.deepEqual(settings.body.data.counts, { pending: 1, approved: 1, rejected: 1 });
  assert.equal(settings.body.data.activeAdminRecipients, 1);
});

test("persisted submission, audit, and terminal outbox shapes validate against the real Mongoose schemas", () => {
  const submittedAt = new Date(), submissionId = id(), userId = id(), recordId = id();
  const submission = new Submission({ _id: submissionId, userId, citizenId, profile: { firstName: "Example" },
    records: [{ _id: recordId, type: "sugar", value: { fbs: 90 } }], clientRequestId: crypto.randomUUID(),
    requestKeyHash: "request-hash", payloadHash: "payload-hash", receiptHash: "receipt-hash", submittedAt,
    reviewDueAt: reviewDeadline(submittedAt), receiptExpiresAt: new Date(Date.now() + 86400000) });
  assert.equal(submission.validateSync(), undefined);
  assert.equal(submission.records[0].type, "sugar");
  const health = new Health({ _id: recordId, userId, citizenId, type: "sugar", value: { fbs: 90 }, reviewStatus: "pending",
    submittedAt, materializedAt: new Date(), reviewHistory: [{ status: "pending", from: null, to: "pending", source: "guest", at: submittedAt }] });
  assert.equal(health.validateSync(), undefined); assert.equal(health.reviewHistory[0].status, "pending");
  const outbox = new Outbox({ submissionId, adminId: id(), recipient: "example@example.test", tokenHash: "token-hash", expiresAt: new Date(), status: "expired" });
  assert.equal(outbox.validateSync(), undefined);
});
