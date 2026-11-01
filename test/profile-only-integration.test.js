// Actual routes and models against a fresh loopback MongoDB; email is stubbed.
const assert = require("node:assert/strict");
const { describe, test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { startWorkflowHarness, assertStatus, profile } = require("./helpers/workflowHarness");
const { installedMongod } = require("./helpers/isolatedMongo");
const { reviewDeadline, tokenFor } = require("../src/utils/review");
const ENABLED = process.env.CAREVIGO_WORKFLOW_INTEGRATION === "1";
const binary = ENABLED ? installedMongod() : null;

describe("profile-only guest submissions keep review and audit without fictional health records", {
  skip: !ENABLED ? "Set CAREVIGO_WORKFLOW_INTEGRATION=1 for isolated real MongoDB tests" : !binary ? "No installed mongod" : false,
  concurrency: false, timeout: 180000,
}, () => {
  let h, staff, nextCitizen = 8800000000000;
  const citizenId = () => String(++nextCitizen);
  before(async () => { h = await startWorkflowHarness(); assert.ok(h); staff = h.newClient("admin"); await staff.loginStaff(); });
  after(async () => {
    if (!h) return;
    const cleanup = await h.stop(); assert.equal(cleanup.exited, true); assert.equal(cleanup.removed, true);
    console.log(`Profile-only cleanup verified: private MongoDB PID ${cleanup.pid} exited and directory removed`);
  });
  async function submit(overrides = {}, client = h.newClient()) {
    const payload = h.guestPayload(citizenId(), { records: [], ...overrides });
    const result = await client.request("/public/submissions", { anonymous: true, method: "POST", body: payload });
    assertStatus(result, 202);
    const receipt = result.body.data, source = await h.models.Submission.findById(receipt.submissionId);
    assert.equal(source.reviewDueAt.getTime(), reviewDeadline(source.submittedAt).getTime());
    // Manual-review assertions stay stable even when this suite runs at 23:59.
    await h.models.Submission.updateOne({ internalId: source.internalId }, { $set: { reviewDueAt: new Date(Date.now() + 86400000) } });
    await h.models.Health.updateMany({ submissionKey: source.internalId }, { $set: { reviewDueAt: new Date(Date.now() + 86400000) } });
    return { payload, client, receipt, source };
  }
  async function source(fixture) { return h.models.Submission.findById(fixture.receipt.submissionId); }
  async function decision(ids, action, reason) {
    const result = await staff.request("/reviews/decision", { method: "POST", body: { ids, action, ...(reason ? { reason } : {}) } });
    assertStatus(result, 200); return result.body.data;
  }

  test("zero measurements persist only a consented submission and profile, reserve no Health IDs, and return a real timestamp with an empty receipt history", async () => {
    const beforeCounter = await h.models.Counter.findById("Health").lean();
    const fixture = await submit();
    assert.deepEqual(fixture.receipt.recordIds, []); assert.equal(fixture.receipt.profileOnly, true);
    assert.equal(fixture.receipt.submittedAt, fixture.source.submittedAt.toISOString());
    const stored = await source(fixture);
    assert.equal(stored.profileOnly, true); assert.equal(stored.profileReviewStatus, "pending");
    assert.equal(stored.profileReviewHistory.length, 1); assert.equal(stored.profileReviewHistory[0].source, "guest");
    assert.equal(stored.materialized, true); assert.equal(stored.notificationsPrepared, true);
    assert.equal(stored.legalAgreement.healthDataConsent, true);
    assert.equal(await h.models.Health.countDocuments({ submissionKey: stored.internalId }), 0);
    assert.equal((await h.models.Counter.findById("Health").lean()).value, beforeCounter.value);
    assert.equal(await h.models.ReviewOutbox.countDocuments({ submissionKey: stored.internalId }), 2);
    const read = await fixture.client.request(`/public/submissions/${stored._id}?token=${fixture.receipt.receiptToken}`, { anonymous: true });
    assertStatus(read, 200); assert.equal(read.body.data.recordCount, 0); assert.deepEqual(read.body.data.records, []);
    assert.equal(read.body.data.profileReviewStatus, "pending"); assert.equal(read.body.data.profileReview.type, "profile");
    assert.equal(read.body.data.profileReview.submittedProfile, undefined); assert.equal(read.body.data.profileReview.citizenId, undefined);
    const retry = await fixture.client.request("/public/submissions", { anonymous: true, method: "POST", body: fixture.payload });
    assertStatus(retry, 202); assert.deepEqual(retry.body.data.recordIds, []);
    assert.equal(retry.body.data.submissionId, fixture.receipt.submissionId); assert.equal(retry.body.data.submittedAt, fixture.receipt.submittedAt);
    assert.equal((await source(fixture)).profileReviewHistory.length, 1);
  });

  test("mixed queue pagination and search contain real health rows and virtual profile rows with exact numeric owners and combined settings counts", async () => {
    const tag = `Mixed-${randomUUID()}`;
    const settingsBefore = await staff.request("/reviews/settings"); assertStatus(settingsBefore, 200);
    const first = await submit({ profile: profile({ firstName: `${tag} A` }) });
    await delay(5);
    const measured = await submit({ profile: profile({ firstName: `${tag} B` }), records: [{ type: "sugar", value: { fbs: 97 } }] });
    await delay(5);
    const latest = await submit({ profile: profile({ firstName: `${tag} C` }) });
    const expected = [latest.receipt.submissionId, measured.receipt.recordIds[0], first.receipt.submissionId];
    for (let page = 1; page <= 3; page++) {
      const result = await staff.request(`/reviews?status=pending&search=${tag}&page=${page}&limit=1`);
      assertStatus(result, 200); assert.equal(result.body.total, 3); assert.equal(result.body.data.length, 1);
      assert.equal(result.body.data[0]._id, expected[page - 1]);
      if (page !== 2) {
        const row = result.body.data[0];
        assert.equal(row.type, "profile"); assert.equal(row.reviewEntity, "submission-profile");
        assert.ok(BigInt(row.internalId) > 9007199254740993n);
        assert.match(row.userId.firstName, new RegExp(tag)); assert.match(row.submittedProfile.firstName, new RegExp(tag));
      }
    }
    const beyond = await staff.request(`/reviews?status=pending&search=${tag}&page=20&limit=1`);
    assertStatus(beyond, 200); assert.deepEqual(beyond.body.data, []);
    const settingsAfter = await staff.request("/reviews/settings"); assertStatus(settingsAfter, 200);
    assert.equal(settingsAfter.body.data.counts.pending, settingsBefore.body.data.counts.pending + 3);
    assert.equal(await h.models.Health.countDocuments({ type: "profile" }), 0);
  });

  test("single rejection, repeated decision and mixed multi-selection retain audit and never overwrite an existing official profile", async () => {
    const officialId = citizenId();
    const official = await h.models.User.create({ citizenId: officialId, ...profile({ firstName: "Official profile" }), isVerified: true, accountEnabled: true });
    const rejected = await submit();
    const approved = await submit({ citizenId: officialId, profile: profile({ firstName: "Submitted snapshot" }) });
    const measured = await submit({ records: [{ type: "sugar", value: { fbs: 98 } }] });
    assert.equal((await decision([rejected.receipt.submissionId], "reject", "ข้อมูลไม่ชัดเจน")).changed, 1);
    assert.equal((await decision([rejected.receipt.submissionId], "approve")).changed, 0);
    const mixed = await decision([approved.receipt.submissionId, measured.receipt.recordIds[0]], "approve");
    assert.equal(mixed.changed, 2); assert.equal(mixed.matched, 2);
    const rejection = await source(rejected), approval = await source(approved);
    assert.equal(rejection.profileReviewStatus, "rejected"); assert.equal(rejection.profileReviewHistory.length, 2);
    assert.equal(rejection.profileReviewReason, "ข้อมูลไม่ชัดเจน"); assert.equal(rejection.profileReviewHistory.at(-1).adminKey, h.admins[0].internalId);
    assert.equal(approval.profileReviewStatus, "approved"); assert.equal(approval.profileReviewHistory.length, 2);
    assert.equal((await h.models.User.findById(official._id)).firstName, "Official profile");
    assert.equal(await h.models.Health.countDocuments({ submissionKey: approval.internalId }), 0);
    const retry = await approved.client.request("/public/submissions", { anonymous: true, method: "POST", body: approved.payload });
    assertStatus(retry, 202); assert.equal(retry.body.data.reviewStatus, "approved");
    assert.equal((await source(approved)).profileReviewHistory.length, 2);
  });

  test("filtered approve-all uses the shared snapshot and excludes newer profile-only submissions", async () => {
    const tag = `Snapshot-${randomUUID()}`;
    const first = await submit({ profile: profile({ firstName: tag }) });
    const second = await submit({ profile: profile({ firstName: tag }) });
    const measured = await submit({ profile: profile({ firstName: tag }), records: [{ type: "sugar", value: { fbs: 99 } }] });
    const queue = await staff.request(`/reviews?status=pending&search=${tag}`);
    assertStatus(queue, 200); assert.equal(queue.body.total, 3);
    await delay(10);
    const later = await submit({ profile: profile({ firstName: tag }) });
    const all = await staff.request("/reviews/decision", { method: "POST", body: {
      all: true, filters: { status: "pending", search: tag }, cutoff: queue.body.snapshotAt, action: "approve",
    } });
    assertStatus(all, 200); assert.equal(all.body.data.changed, 3); assert.equal(all.body.data.matched, 3);
    assert.equal((await source(first)).profileReviewStatus, "approved"); assert.equal((await source(second)).profileReviewStatus, "approved");
    assert.equal((await h.models.Health.findById(measured.receipt.recordIds[0])).reviewStatus, "approved");
    assert.equal((await source(later)).profileReviewStatus, "pending");
    const remaining = await staff.request(`/reviews?status=pending&search=${tag}`);
    assertStatus(remaining, 200); assert.equal(remaining.body.total, 1); assert.equal(remaining.body.data[0]._id, later.receipt.submissionId);
  });

  test("email GET exposes only its authorized submitted profile and cannot decide; concurrent email/admin decisions transition once", async () => {
    const tag = `EmailProfile-${randomUUID()}`;
    const target = await submit({ profile: { ...profile({ firstName: tag }), passwordHash: "must-not-expose", accountEnabled: true } });
    const other = await submit();
    for (let index = 0; index < 5; index++) await h.review.sendOutbox();
    const message = h.sentEmails.find(row => row.patientName.startsWith(tag) && row.recipient === h.admins[0].email);
    assert.ok(message); assert.equal(message.recordCount, 0); assert.equal(message.profileOnly, true);
    const token = new URL(message.approveUrl).searchParams.get("token");
    const before = (await source(target)).toObject();
    const read = await target.client.request(`/reviews/email?token=${token}`, { anonymous: true });
    assertStatus(read, 200); assert.equal(read.body.data.profileOnly, true); assert.equal(read.body.data.recordCount, 0);
    assert.equal(read.body.data.records.length, 1); assert.equal(read.body.data.records[0].type, "profile");
    assert.equal(read.body.data.records[0].submittedProfile.firstName, tag);
    assert.equal(read.body.data.records[0].submittedProfile.passwordHash, undefined);
    assert.equal(read.body.data.records[0].userId, undefined); assert.equal(read.body.data.records[0].citizenId, undefined);
    assert.deepEqual((await source(target)).toObject(), before);
    const [email, manual] = await Promise.all([
      target.client.request("/reviews/email", { anonymous: true, method: "POST", body: { token, action: "reject", ids: [other.receipt.submissionId] } }),
      staff.request("/reviews/decision", { method: "POST", body: { ids: [target.receipt.submissionId], action: "approve" } }),
    ]);
    assertStatus(email, 200); assertStatus(manual, 200); assert.equal(email.body.data.changed + manual.body.data.changed, 1);
    assert.equal((await source(target)).profileReviewHistory.length, 2); assert.equal((await source(other)).profileReviewStatus, "pending");
    const repeat = await target.client.request("/reviews/email", { anonymous: true, method: "POST", body: { token, action: "approve" } });
    assertStatus(repeat, 200); assert.equal(repeat.body.data.changed, 0);
  });

  test("23:59 catch-up reviews profile-only submissions without Health records and wins over late manual/email cancellation", async () => {
    const fixture = await submit();
    const job = await h.models.ReviewOutbox.findOne({ submissionKey: fixture.source.internalId, adminKey: h.admins[0].internalId });
    const token = tokenFor("email-review", job._id, job.submissionId, job.adminId);
    await h.models.Submission.updateOne({ internalId: fixture.source.internalId }, { $set: { reviewDueAt: new Date(Date.now() - 1000) } });
    const pure = await fixture.client.request(`/reviews/email?token=${token}`, { anonymous: true });
    assertStatus(pure, 200); assert.equal(pure.body.data.canDecide, true); assert.equal((await source(fixture)).profileReviewStatus, "pending");
    const [email, manual] = await Promise.all([
      fixture.client.request("/reviews/email", { anonymous: true, method: "POST", body: { token, action: "reject" } }),
      staff.request("/reviews/decision", { method: "POST", body: { ids: [fixture.receipt.submissionId], action: "reject" } }),
    ]);
    assertStatus(email, 200); assertStatus(manual, 200); assert.equal(email.body.data.changed + manual.body.data.changed, 0);
    const final = await source(fixture);
    assert.equal(final.profileReviewStatus, "approved"); assert.equal(final.profileReviewSource, "automatic"); assert.equal(final.profileReviewHistory.length, 2);
    const read = await fixture.client.request(`/public/submissions/${fixture.receipt.submissionId}?token=${fixture.receipt.receiptToken}`, { anonymous: true });
    assertStatus(read, 200); assert.equal(read.body.data.profileReviewStatus, "approved"); assert.deepEqual(read.body.data.records, []);
    assert.equal(await h.models.Health.countDocuments({ submissionKey: final.internalId }), 0);
  });

  test("concurrent identical profile-only requests reuse one batch, no Health counter allocation and one outbox per recipient", async () => {
    const payload = h.guestPayload(citizenId(), { records: [] }), client = h.newClient();
    const beforeCounter = await h.models.Counter.findById("Health").lean();
    const results = await Promise.all(Array.from({ length: 8 }, () => client.request("/public/submissions", { anonymous: true, method: "POST", body: payload })));
    results.forEach(result => assertStatus(result, 202));
    assert.equal(new Set(results.map(result => result.body.data.submissionId)).size, 1);
    const stored = await h.models.Submission.findOne({ clientRequestId: payload.clientRequestId });
    assert.equal(stored.profileReviewHistory.length, 1); assert.equal(await h.models.Health.countDocuments({ submissionKey: stored.internalId }), 0);
    assert.equal((await h.models.Counter.findById("Health").lean()).value, beforeCounter.value);
    assert.equal(await h.models.ReviewOutbox.countDocuments({ submissionKey: stored.internalId }), 2);
    const changed = await client.request("/public/submissions", { anonymous: true, method: "POST", body: { ...payload, profile: profile({ firstName: "Changed" }) } });
    assertStatus(changed, 409);
    const materializedAt = stored.profileMaterializedAt.getTime();
    await h.models.Submission.updateOne({ internalId: stored.internalId }, { $set: { materialized: false, notificationsPrepared: false } });
    await h.review.runReviewWorker();
    const recovered = await h.models.Submission.findById(stored._id);
    assert.equal(recovered.materialized, true); assert.equal(recovered.notificationsPrepared, true);
    assert.equal(recovered.profileMaterializedAt.getTime(), materializedAt); assert.equal(recovered.profileReviewHistory.length, 1);
    assert.equal(await h.models.Health.countDocuments({ submissionKey: stored.internalId }), 0);
  });

  test("optional categories do not allow half-completed selected measurements and missing consent still prevents persistence", async () => {
    for (const records of [[{ type: "blood_pressure", value: { systolic: 130 } }], [{ type: "bmi", value: { weight: 60 } }]]) {
      const id = citizenId(), result = await h.newClient().request("/public/submissions", { anonymous: true, method: "POST", body: h.guestPayload(id, { records }) });
      assertStatus(result, 400); assert.equal(await h.models.Submission.countDocuments({ citizenId: id }), 0);
      assert.equal(await h.models.User.countDocuments({ citizenId: id }), 0);
    }
    const id = citizenId(), noConsent = await h.newClient().request("/public/submissions", { anonymous: true, method: "POST", body: h.guestPayload(id, { records: [], agreements: undefined }) });
    assertStatus(noConsent, 422); assert.equal(await h.models.Submission.countDocuments({ citizenId: id }), 0);
  });
});
