const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const User = require("../src/models/User");
const Health = require("../src/models/Health");
const Admin = require("../src/models/Admin");
const Submission = require("../src/models/Submission");
const Outbox = require("../src/models/ReviewOutbox");
const ids = require("../src/services/internalIds.service");
const email = require("../src/services/email.service");
const review = require("../src/services/review.service");
const controller = require("../src/controllers/review.controller");
const submissionController = require("../src/controllers/submission.controller");
const { hashToken, tokenFor, submissionRecordsFilter } = require("../src/utils/review");
const { jsonSafe } = require("../src/utils/json");

process.env.JWT_SECRET = "isolated-numeric-review-test-secret";
const id = () => new mongoose.Types.ObjectId();
const big = 9007199254740993n;
const citizenId = "1234567890123";
const read = (row, path) => path.split(".").reduce((value, key) => value?.[key], row);
const scalar = value => value instanceof Date ? value.getTime() : value?.toHexString ? value.toHexString() : value?._bsontype === "Long" ? value.toBigInt() : value;

function matches(row, filter) {
  return Object.entries(filter || {}).every(([field, expected]) => {
    if (field === "$and") return expected.every(item => matches(row, item));
    if (field === "$or") return expected.some(item => matches(row, item));
    const actual = read(row, field);
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !expected.toHexString && expected._bsontype !== "Long") {
      return Object.entries(expected).every(([operator, value]) => {
        if (operator === "$exists") return (actual !== undefined) === value;
        if (operator === "$elemMatch") return Array.isArray(actual) && actual.some(item => matches(item, value));
        if (operator === "$in") return value.some(item => scalar(actual) === scalar(item));
        if (operator === "$lte") return scalar(actual) <= scalar(value);
        if (operator === "$gt") return scalar(actual) > scalar(value);
        throw new Error(`Unsupported fixture operator ${operator}`);
      });
    }
    return scalar(actual) === scalar(expected);
  });
}
function query(initial, single = false) {
  let rows = [...initial], offset = 0, limit = Infinity;
  return {
    select() { return this; }, populate() { return this; }, setOptions() { return this; },
    sort(fields) {
      rows.sort((a, b) => {
        for (const [field, direction] of Object.entries(fields)) {
          if (scalar(read(a, field)) < scalar(read(b, field))) return -direction;
          if (scalar(read(a, field)) > scalar(read(b, field))) return direction;
        }
        return 0;
      });
      return this;
    },
    skip(value) { offset = value; return this; }, limit(value) { limit = value; return this; },
    then(resolve, reject) { return Promise.resolve(single ? rows[0] || null : rows.slice(offset, offset + limit)).then(resolve, reject); }
  };
}
function embeddedFilter(filter) {
  if (filter.records?.$elemMatch) return filter.records.$elemMatch;
  for (const nested of filter.$and || []) { const found = embeddedFilter(nested); if (found) return found; }
}
function apply(row, update, filter) {
  for (const [field, value] of Object.entries(update.$set || {})) {
    if (field === "records.$.internalId") row.records.find(item => matches(item, embeddedFilter(filter))).internalId = value;
    else row[field] = value;
  }
  for (const [field, value] of Object.entries(update.$inc || {})) row[field] = (row[field] || 0) + value;
  for (const [field, value] of Object.entries(update.$push || {})) (row[field] ||= []).push(value);
  for (const field of Object.keys(update.$unset || {})) delete row[field];
  return row;
}
function storeFor(t) {
  const state = { users: [], records: [], submissions: [], jobs: [], admins: [], next: big + 100n };
  const tables = new Map([[User, state.users], [Health, state.records], [Submission, state.submissions], [Outbox, state.jobs], [Admin, state.admins]]);
  t.mock.method(ids, "allocateInternalId", async () => state.next++);
  t.mock.method(ids, "allocateInternalIds", async (_, count) => Array.from({ length: count }, () => state.next++));
  t.mock.method(ids, "ensureInternalId", async (Model, value) => {
    const row = value?._id !== undefined ? value : tables.get(Model).find(item => scalar(item._id) === scalar(value));
    if (!row) throw new Error("Missing fixture identity");
    row.internalId ??= state.next++;
    return ids.toInternalId(row.internalId);
  });
  for (const [Model, rows] of tables) {
    t.mock.method(Model, "find", filter => query(rows.filter(row => matches(row, filter))));
    t.mock.method(Model, "findOne", filter => query(rows.filter(row => matches(row, filter)), true));
    t.mock.method(Model, "countDocuments", async filter => rows.filter(row => matches(row, filter)).length);
    t.mock.method(Model, "updateOne", async (filter, update, options = {}) => {
      let row = rows.find(item => matches(item, filter));
      if (!row && options.upsert) { row = { ...update.$setOnInsert }; rows.push(row); }
      if (row) apply(row, update, filter);
      return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
    });
    t.mock.method(Model, "findOneAndUpdate", async (filter, update) => {
      const row = rows.find(item => matches(item, filter)); return row ? apply(row, update, filter) : null;
    });
    t.mock.method(Model.collection, "updateOne", async (filter, update) => {
      const row = rows.find(item => matches(item, filter)); if (row) apply(row, update, filter);
      return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
    });
  }
  t.mock.method(Health, "updateMany", async (filter, update) => state.records.filter(row => matches(row, filter)).forEach(row => apply(row, update, filter)));
  t.mock.method(Submission, "create", async data => { state.submissions.push(data); return data; });
  t.mock.method(User, "findOneAndUpdate", async (filter, update) => {
    let row = state.users.find(item => matches(item, filter));
    if (!row) { row = { _id: id(), ...update.$setOnInsert }; state.users.push(row); }
    return apply(row, update, filter);
  });
  t.mock.method(email, "sendReviewNotification", async () => {});
  return state;
}
function reply() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = jsonSafe(body); return this; } };
}
function makeSubmission(extra = {}) {
  const submittedAt = new Date(Date.now() - 1000);
  return { _id: id(), internalId: big, userId: id(), userKey: big + 1n, citizenId,
    profile: { firstName: "Submitted", lastName: "Patient" }, records: [{ _id: id(), internalId: big + 2n, type: "sugar", value: { fbs: 100 } }],
    clientRequestId: crypto.randomUUID(), submittedAt, reviewDueAt: new Date(Date.now() + 600000), ...extra };
}
function makeJob(submission, admin, extra = {}) {
  const job = { _id: id(), internalId: big + 3n, submissionId: submission._id, submissionKey: submission.internalId,
    adminId: admin._id, adminKey: admin.internalId, recipient: "staff@example.test", status: "pending", attempts: 0,
    nextAttemptAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 600000), ...extra };
  const token = tokenFor("email-review", job._id, job.submissionId, job.adminId);
  job.tokenHash = hashToken(token); return { job, token };
}

test("new guest batches preassign exact durable numeric IDs while public IDs and retry identity stay unchanged", async t => {
  const state = storeFor(t), input = { citizenId, clientRequestId: crypto.randomUUID(), profile: { firstName: "Example" },
    agreements: require("./fixtures/legal-agreements.json").patient,
    records: [{ type: "sugar", value: { fbs: 100 } }, { type: "cholesterol", value: { total: 200 } }] };
  const first = reply(); await submissionController.submit({ body: input }, first);
  assert.equal(first.statusCode, 202);
  const source = state.submissions[0], recordKeys = source.records.map(row => row.internalId);
  const originalProof = source.legalAgreement;
  assert.equal(originalProof.source, "guest-consent"); assert.equal(originalProof.healthDataConsent, true);
  assert.equal(originalProof.acceptedAt instanceof Date, true);
  assert.equal(source.payloadHash, hashToken(JSON.stringify({ citizenId, profile: input.profile, records: input.records, agreements: input.agreements })));
  assert.ok(state.records.every(row => row.legalAgreement === originalProof));
  assert.ok(source.internalId > BigInt(Number.MAX_SAFE_INTEGER));
  assert.ok(recordKeys.every(key => typeof key === "bigint" && key > BigInt(Number.MAX_SAFE_INTEGER)));
  assert.deepEqual(state.records.map(row => row.internalId), recordKeys);
  assert.ok(state.records.every(row => row.userKey === source.userKey && row.submissionKey === source.internalId));
  assert.ok(first.body.data.recordIds.every(value => /^[0-9a-f]{24}$/.test(value)));
  assert.match(first.body.data.submissionId, /^[0-9a-f]{24}$/);
  assert.equal(jsonSafe(source).internalId, source.internalId.toString());
  state.records[0].reviewStatus = "approved";
  const second = reply(); await submissionController.submit({ body: input }, second);
  assert.equal(second.statusCode, 202); assert.deepEqual(second.body.data, first.body.data);
  assert.equal(source.legalAgreement, originalProof); assert.equal(state.users[0].legalAgreementHistory.length, 1);
  assert.deepEqual(state.records.map(row => row.internalId), recordKeys);
  assert.equal(state.records.length, 2); assert.equal(state.records[0].reviewStatus, "approved");
});

test("legacy concurrent recovery rereads the winning embedded key before materializing", async t => {
  const state = storeFor(t), source = makeSubmission();
  delete source.records[0].internalId; state.submissions.push(source);
  const winner = big + 50n;
  t.mock.method(Submission.collection, "updateOne", async () => {
    source.records[0].internalId = winner;
    return { matchedCount: 0, modifiedCount: 0 };
  });
  await review.materializeSubmission(source);
  assert.equal(state.records.length, 1); assert.equal(state.records[0].internalId, winner);
  assert.equal(source.records[0].internalId, winner); assert.equal(source.materialized, true);
  assert.notEqual(await ids.allocateInternalId.mock.calls[0].result, winner);
});

test("legacy recovery reuses an existing Health key and never rewrites its approved state or audit", async t => {
  const state = storeFor(t), source = makeSubmission();
  delete source.records[0].internalId; state.submissions.push(source);
  const audit = [{ status: "approved", source: "admin" }];
  state.records.push({ ...source.records[0], internalId: big + 90n, reviewStatus: "approved", reviewHistory: audit });
  await review.materializeSubmission(source); await review.materializeSubmission(source);
  assert.equal(source.records[0].internalId, big + 90n); assert.equal(state.records.length, 1);
  assert.equal(state.records[0].reviewStatus, "approved"); assert.equal(state.records[0].reviewHistory, audit);
  assert.equal(state.records[0].submissionKey, source.internalId); assert.equal(state.records[0].userKey, source.userKey);
});

test("receipt and email GET scope exact numeric relations, retain missing-key legacy rows, and allocate nothing", async t => {
  const state = storeFor(t), source = makeSubmission(), admin = { _id: id(), internalId: big + 5n, isActive: true };
  const { job, token } = makeJob(source, admin), receiptToken = "r".repeat(43);
  source.receiptHash = hashToken(receiptToken); source.receiptExpiresAt = new Date(Date.now() + 600000);
  state.submissions.push(source); state.jobs.push(job); state.admins.push(admin);
  const row = extra => ({ _id: id(), type: "sugar", value: { fbs: 100 }, reviewStatus: "pending", reviewHistory: [], ...extra });
  const numeric = row({ submissionKey: source.internalId, submissionId: id() });
  const legacy = row({ submissionId: source._id });
  const mismatch = row({ submissionKey: source.internalId + 1n, submissionId: source._id });
  state.records.push(numeric, legacy, mismatch);
  const receipt = reply(); await submissionController.receipt({ params: { id: String(source._id) }, query: { token: receiptToken } }, receipt);
  const info = reply(); await controller.emailInfo({ query: { token } }, info);
  assert.equal(receipt.statusCode, 200); assert.equal(info.statusCode, 200);
  const expected = new Set([String(numeric._id), String(legacy._id)]);
  assert.deepEqual(new Set(receipt.body.data.records.map(row => row._id)), expected);
  assert.deepEqual(new Set(info.body.data.records.map(row => row._id)), expected);
  assert.equal(ids.ensureInternalId.mock.callCount(), 0); assert.equal(ids.allocateInternalId.mock.callCount(), 0);
  assert.equal(ids.allocateInternalIds.mock.callCount(), 0);
  assert.ok(state.records.every(row => row.reviewStatus === "pending" && row.reviewHistory.length === 0));
  assert.equal(Outbox.updateOne.mock.callCount(), 0); assert.equal(Submission.updateOne.mock.callCount(), 0);
});

test("legacy read scopes never attach children with an existing unrelated numeric key", t => {
  storeFor(t);
  const source = makeSubmission(); delete source.internalId;
  const filter = submissionRecordsFilter(source);
  assert.equal(matches({ submissionId: source._id }, filter), true);
  assert.equal(matches({ submissionId: source._id, submissionKey: big }, filter), false);
});

test("queue hides populated legacy people whenever an authoritative numeric relation has no numeric match", async t => {
  const state = storeFor(t), stale = { _id: id(), firstName: "Must never leak" }, current = { _id: id(), internalId: big + 2n, firstName: "Current" };
  const base = { reviewStatus: "pending", createdAt: new Date(Date.now() - 1000) };
  const mismatch = { ...base, _id: id(), userKey: big + 1n, userId: stale };
  const numeric = { ...base, _id: id(), userKey: current.internalId, userId: stale, userByKey: current };
  const legacy = { ...base, _id: id(), userId: stale };
  state.records.push(mismatch, numeric, legacy);
  const result = reply(); await controller.list({ query: { status: "pending" } }, result);
  assert.equal(result.statusCode, 200); assert.equal(result.body.total, 3);
  const records = new Map(result.body.data.map(row => [row._id, row]));
  assert.equal(records.get(String(mismatch._id)).userId, null);
  assert.equal(records.get(String(numeric._id)).userId.firstName, "Current");
  assert.equal(records.get(String(numeric._id)).userId.internalId, undefined);
  assert.equal(records.get(String(legacy._id)).userId.firstName, stale.firstName);
  assert.ok(result.body.data.every(row => row.userByKey === undefined));
});

test("email tokens cannot follow mismatched numeric admin or submission relations", async t => {
  const state = storeFor(t), source = makeSubmission(), admin = { _id: id(), internalId: big + 5n, isActive: true };
  const { job, token } = makeJob(source, admin);
  state.submissions.push(source); state.admins.push(admin); state.jobs.push(job);
  job.adminKey = admin.internalId + 1n;
  const wrongAdmin = reply(); await controller.emailInfo({ query: { token } }, wrongAdmin);
  assert.equal(wrongAdmin.statusCode, 410);
  job.adminKey = admin.internalId; job.submissionKey = source.internalId + 1n;
  const wrongSubmission = reply(); await controller.emailDecision({ body: { token, action: "approve" } }, wrongSubmission);
  assert.equal(wrongSubmission.statusCode, 410);
  assert.equal(Health.findOneAndUpdate.mock.callCount(), 0);
  assert.equal(ids.ensureInternalId.mock.callCount(), 0);
});

test("email approval updates numeric-only ownership and records exact admin keys while preserving count numbers", async t => {
  const state = storeFor(t), source = makeSubmission(), admin = { _id: id(), internalId: big + 5n, isActive: true };
  const { job, token } = makeJob(source, admin);
  state.submissions.push(source); state.admins.push(admin); state.jobs.push(job);
  const owned = { _id: id(), internalId: big + 6n, submissionKey: source.internalId, submissionId: id(), reviewStatus: "pending", reviewHistory: [] };
  const mismatch = { _id: id(), internalId: big + 7n, submissionKey: big + 99n, submissionId: source._id, reviewStatus: "pending", reviewHistory: [] };
  state.records.push(owned, mismatch);
  const result = reply(); await controller.emailDecision({ body: { token, action: "approve" } }, result);
  assert.equal(result.statusCode, 200); assert.equal(result.body.data.changed, 1); assert.equal(result.body.data.skipped, 0);
  assert.equal(typeof result.body.data.changed, "number"); assert.equal(owned.reviewStatus, "approved");
  assert.equal(mismatch.reviewStatus, "pending"); assert.equal(owned.reviewHistory[0].adminKey, admin.internalId);
  assert.equal(owned.reviewHistory[0].actorId, String(admin._id));
  assert.equal(jsonSafe(owned).reviewHistory[0].adminKey, admin.internalId.toString());
  const repeated = reply(); await controller.emailDecision({ body: { token, action: "reject" } }, repeated);
  assert.equal(repeated.body.data.changed, 0); assert.equal(repeated.body.data.skipped, 1); assert.equal(owned.reviewHistory.length, 1);
});

test("outbox retries keep exact numeric relations, stable opaque tokens, and idempotent jobs", async t => {
  const state = storeFor(t), source = makeSubmission(), admin = { _id: id(), internalId: big + 5n, isActive: true, email: "staff@example.test" };
  state.submissions.push(source); state.admins.push(admin);
  await review.prepareNotifications(source); await review.prepareNotifications(source);
  assert.equal(state.jobs.length, 1); const job = state.jobs[0];
  assert.ok(job.internalId > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(job.submissionKey, source.internalId); assert.equal(job.adminKey, admin.internalId);
  const expectedToken = tokenFor("email-review", job._id, source._id, admin._id);
  assert.equal(job.tokenHash, hashToken(expectedToken));
  await review.sendOutbox(new Date(Date.now() + 1000));
  assert.equal(job.status, "sent"); assert.equal(email.sendReviewNotification.mock.callCount(), 1);
  const sent = email.sendReviewNotification.mock.calls[0].arguments[0];
  assert.equal(new URL(sent.approveUrl).searchParams.get("token"), expectedToken);
  assert.equal(typeof sent.recordCount, "number"); assert.equal(sent.recordCount, source.records.length);
});

test("outbox refuses stale numeric recipients and does not send to their legacy ObjectId match", async t => {
  const state = storeFor(t), source = makeSubmission(), admin = { _id: id(), internalId: big + 5n, isActive: true };
  const { job } = makeJob(source, admin, { adminKey: admin.internalId + 1n });
  state.submissions.push(source); state.admins.push(admin); state.jobs.push(job);
  await review.sendOutbox(new Date());
  assert.equal(job.status, "failed"); assert.equal(job.lastError, "Recipient no longer active");
  assert.equal(email.sendReviewNotification.mock.callCount(), 0);
});
