// Opt in explicitly: CAREVIGO_WORKFLOW_INTEGRATION=1 node --test test/workflow-integration.test.js
// Uses a freshly spawned loopback mongod, actual models/routes, and email stub only.
// Default test runs do not inspect binaries, load .env, connect to MongoDB, or start HTTP.
const assert = require("node:assert/strict");
const { describe, test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { startWorkflowHarness, assertStatus, subjectAgreements, staffAgreements, profile, measurements, BASE } = require("./helpers/workflowHarness");
const { installedMongod } = require("./helpers/isolatedMongo");

const ENABLED = process.env.CAREVIGO_WORKFLOW_INTEGRATION === "1";
const executable = ENABLED ? installedMongod() : null;
describe("complete care workflows over HTTP and an isolated real MongoDB", {
  skip: !ENABLED ? "Set CAREVIGO_WORKFLOW_INTEGRATION=1 for a fresh local MongoDB integration run" :
    !executable ? "No installed mongod; set CAREVIGO_TEST_MONGOD to an installed binary" : false,
  concurrency: false, timeout: 180000,
}, () => {
  let h, staff;
  let nextCitizen = 8100000000000;
  const citizenId = () => String(++nextCitizen);
  before(async () => {
    h = await startWorkflowHarness();
    assert.ok(h, "The installed mongod binary must remain available during setup");
    staff = h.newClient("admin");
    await staff.loginStaff();
  });
  after(async () => {
    if (!h) return;
    const cleanup = await h.stop();
    assert.equal(cleanup.exited, true); assert.equal(cleanup.removed, true);
    console.log(`Cleanup verified: mongod PID ${cleanup.pid} exited and its fresh temporary directory was removed`);
  });

  // Review scheduling itself is tested below. Manual-review fixtures are moved
  // into the future after checking the real generated deadline, so running the
  // suite at Bangkok 23:59 cannot turn a concurrency test into a deadline test.
  async function manualReviewFixture(receipt) {
    const { Submission, Health } = h.models;
    const submission = await Submission.findById(receipt.submissionId);
    const { reviewDeadline } = require("../src/utils/review");
    assert.equal(submission.reviewDueAt.getTime(), reviewDeadline(submission.submittedAt).getTime());
    const future = new Date(Date.now() + 86400000);
    await Submission.updateOne({ internalId: submission.internalId }, { $set: { reviewDueAt: future } });
    await Health.updateMany({ submissionKey: submission.internalId }, { $set: { reviewDueAt: future } });
    return Submission.findById(submission._id);
  }
  async function guest(payload, client = h.newClient()) {
    const result = await client.request("/public/submissions", { anonymous: true, method: "POST", body: payload });
    assertStatus(result, 202);
    return { receipt: result.body.data, client };
  }
  async function assertMaterialized(receipt) {
    const submission = await h.models.Submission.findById(receipt.submissionId);
    const records = await h.models.Health.find({ submissionKey: submission.internalId });
    if (!submission.materialized || records.length !== submission.records.length) {
      const initial = `Initial materialized=${submission.materialized}, Health=${records.length}/${submission.records.length}`;
      try { await h.review.materializeSubmission(submission); }
      catch (error) { assert.fail(`${initial}; real recovery error: ${error.message}`); }
      assert.fail(`${initial}; manual recovery was required despite a healthy local database`);
    }
    assert.equal(submission.notificationsPrepared, true, "Recipient outbox must be durably prepared");
    assert.equal(await h.models.ReviewOutbox.countDocuments({ submissionKey: submission.internalId }), 2);
    return { submission, records };
  }

  test("guest batch materializes real numeric relations, legal evidence, and exactly one outbox job per active admin", async context => {
    context.diagnostic(`${h.mongo.version}; real models; isolated PID ${h.mongo.pid}; signed int64 counters start above ${BASE}`);
    const id = citizenId(), payload = h.guestPayload(id);
    const { receipt, client } = await guest(payload);
    const { submission, records } = await assertMaterialized(receipt);
    assert.equal(records.length, 4);
    const person = await h.models.User.findOne({ citizenId: id });
    assert.equal(typeof person.internalId, "bigint"); assert.ok(person.internalId > BASE);
    assert.equal(submission.userKey, person.internalId);
    assert.equal(person.accountEnabled, false); assert.equal(person.isVerified, false);
    for (const record of records) {
      assert.equal(record.userKey, person.internalId); assert.equal(record.submissionKey, submission.internalId);
      const reserved = submission.records.find(item => String(item._id) === String(record._id));
      assert.equal(record.internalId, reserved.internalId);
      assert.equal(record.reviewStatus, "pending"); assert.equal(record.reviewHistory.length, 1);
      assert.equal(record.legalAgreement.source, "guest-consent");
      assert.equal(record.legalAgreement.healthDataConsent, true);
      assert.ok(record.legalAgreement.acceptedAt instanceof Date);
    }
    await manualReviewFixture(receipt);
    const same = await client.request("/public/submissions", { anonymous: true, method: "POST", body: payload });
    assertStatus(same, 202); assert.equal(same.body.data.submissionId, receipt.submissionId);
    assert.deepEqual(same.body.data.recordIds, receipt.recordIds);
    assert.equal(await h.models.Health.countDocuments({ submissionKey: submission.internalId }), 4);
    assert.equal(await h.models.ReviewOutbox.countDocuments({ submissionKey: submission.internalId }), 2);
    const changed = await client.request("/public/submissions", { anonymous: true, method: "POST",
      body: { ...payload, profile: { ...payload.profile, firstName: "different payload" } } });
    assertStatus(changed, 409);
    const receiptRead = await client.request(`/public/submissions/${receipt.submissionId}?token=${receipt.receiptToken}`, { anonymous: true });
    assertStatus(receiptRead, 200); assert.equal(receiptRead.body.data.recordCount, 4);
    assert.equal(receiptRead.body.data.processing, false);
    assert.equal(receiptRead.body.data.records[0].citizenId, undefined);
    assert.equal(receiptRead.body.data.records[0].submittedProfile, undefined);
    assertStatus(await client.request(`/public/submissions/${receipt.submissionId}?token=${"x".repeat(43)}`, { anonymous: true }), 404);
    assertStatus(await client.request(`/public/health?citizenId=${id}`, { anonymous: true }), 401);
    assertStatus(await client.request(`/users/search?citizenId=${id}`, { anonymous: true }), 401);
  });

  test("concurrent identical anonymous submissions allocate one durable batch and never duplicate records or notifications", async () => {
    const payload = h.guestPayload(citizenId()), client = h.newClient();
    const results = await Promise.all(Array.from({ length: 8 }, () => client.request("/public/submissions", { anonymous: true, method: "POST", body: payload })));
    results.forEach(result => assertStatus(result, 202));
    const receipt = results[0].body.data;
    assert.equal(new Set(results.map(result => result.body.data.submissionId)).size, 1);
    assert.equal(await h.models.Submission.countDocuments({ clientRequestId: payload.clientRequestId }), 1);
    const { records, submission } = await assertMaterialized(receipt);
    assert.equal(records.length, 4);
    assert.equal(new Set(records.map(row => row.internalId.toString())).size, 4);
    assert.equal(await h.models.User.countDocuments({ citizenId: payload.citizenId }), 1);
    const jobs = await h.models.ReviewOutbox.find({ submissionKey: submission.internalId });
    assert.equal(new Set(jobs.map(job => `${job.submissionKey}:${job.adminKey}`)).size, 2);
  });

  test("staff registration and provisioning lead through temporary-PIN gates, password rotation, full profile, health and Thai CV", async () => {
    const client = h.newClient("admin");
    const login = await client.loginStaff();
    assert.equal(login.body.data.accessToken, undefined); assert.equal(login.body.data.refreshToken, undefined);
    assert.match(login.headers.get("set-cookie"), /HttpOnly/);
    const id = citizenId(), data = { citizenId: id, ...profile(), agreements: staffAgreements() };
    assertStatus(await client.request("/users/admin", { method: "POST", body: { ...data, agreements: undefined } }), 422);
    assert.equal(await h.models.User.countDocuments({ citizenId: id }), 0);
    const registration = await client.request("/users/admin", { method: "POST", body: data });
    assertStatus(registration, 200);
    const personId = registration.body.data._id;
    assert.match(registration.body.data.internalId, /^[1-9]\d+$/);
    assert.ok(BigInt(registration.body.data.internalId) > BASE);
    const provision = await client.request(`/users/admin/${personId}/account`, { method: "POST", body: {} });
    assertStatus(provision, 200); assert.match(provision.body.data.temporaryPassword, /^\d{6}$/);
    assert.equal(provision.body.data.patient.passwordHash, undefined);
    const temporary = provision.body.data.temporaryPassword;
    const patientLogin = await client.request("/auth/patient/login", { method: "POST", scope: "patient", body: { citizenId: id, password: temporary } });
    assertStatus(patientLogin, 200); assert.equal(patientLogin.body.data.requiresPasswordChange, true);
    assert.equal(patientLogin.body.data.accessToken, undefined);
    const old = client.clone(), oldSessionId = client.sessions.get("patient").sessionId;
    assertStatus(await client.request("/auth/session?scope=patient", { scope: "patient" }), 200);
    const blocked = await client.request(`/public/health?citizenId=${id}`, { scope: "patient" });
    assertStatus(blocked, 403); assert.equal(blocked.body.code, "PASSWORD_CHANGE_REQUIRED");
    assertStatus(await client.request("/auth/patient/me", { method: "PATCH", scope: "patient", body: { firstName: "blocked", agreements: subjectAgreements() } }), 403);
    const changed = await client.request("/auth/patient/change-password", { method: "POST", scope: "patient",
      body: { currentPassword: temporary, password: "patient-new-password" } });
    assertStatus(changed, 200); assert.equal(changed.body.data.requiresPasswordChange, false);
    assert.notEqual(changed.body.data.session.sessionId, oldSessionId);
    assertStatus(await old.request("/auth/session?scope=patient", { scope: "patient" }), 401);
    const fields = profile({ firstName: "ข้อมูลครบ", lastName: "บันทึกจริง", gender: "male", phone: "0800000001",
      email: "patient@example.test", lineId: "integration-line", emergencyContactName: "ผู้ติดต่อ", emergencyContactPhone: "0800000002",
      district: "เมือง", subdistrict: "สุเทพ", address: "ที่อยู่จำลอง", occupation: "พนักงาน", education: "ปริญญาตรี",
      maritalStatus: "สมรส", economicStatus: "พอใช้", weight: 60.5, height: 165,
      smokingStatus: "former", smokingQuitMonths: 12, chronicDiseases: ["เบาหวาน", "มะเร็ง"], cancerDetails: "มะเร็งเต้านม" });
    const profileSave = await client.request("/auth/patient/me", { method: "PATCH", scope: "patient", body: {
      ...fields, citizenId: "9999999999999", status: "rejected", isVerified: false, accountEnabled: false,
      passwordHash: "cannot-assign", tokenVersion: 999, agreements: subjectAgreements(),
    } });
    assertStatus(profileSave, 200);
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(profileSave.body.data.patient[key], value, key);
    assert.equal(profileSave.body.data.patient.citizenId, id);
    assert.equal(profileSave.body.data.patient.status, "active"); assert.equal(profileSave.body.data.patient.isVerified, true);
    assert.equal(profileSave.body.data.patient.passwordHash, undefined); assert.equal(profileSave.body.data.patient.tokenVersion, undefined);
    const saves = await Promise.all(measurements().map(record => client.request("/public/health", { method: "POST", scope: "patient",
      body: { citizenId: id, ...record, agreements: subjectAgreements() } })));
    saves.forEach(result => assertStatus(result, 200));
    const me = await client.request("/auth/patient/me", { scope: "patient" });
    assertStatus(me, 200); assert.equal(me.body.data.thaiCvRisk.status, "calculated");
    assert.ok(me.body.data.thaiCvRisk.score > 0); assert.equal(me.body.data.thaiCvRisk.inputs.systolic, 130);
    assert.equal(me.body.data.thaiCvRisk.inputs.totalCholesterol, 210);
    const history = await client.request(`/public/health?citizenId=${id}&page=1&limit=10`, { scope: "patient" });
    assertStatus(history, 200); assert.equal(history.body.total, 4);
    assert.equal(history.body.data.find(record => record.type === "bmi").weight, 60.5);
    assert.ok(history.body.data.every(record => record.legalAgreement.source === "patient-consent"));
    const stored = await h.models.User.findById(personId).select("+passwordHash +tokenVersion");
    assert.match(stored.passwordHash, /^\$2[aby]\$/); assert.notEqual(stored.tokenVersion, 999);
    assert.equal(stored.legalAgreementHistory.length, 2);
    const privateId = citizenId();
    await h.models.User.create({ citizenId: privateId, ...profile({ firstName: "บัญชีอื่น" }) });
    assertStatus(await client.request(`/public/health?citizenId=${privateId}`, { scope: "patient" }), 403);
    assertStatus(await client.request(`/users/search?citizenId=${privateId}`, { scope: "patient" }), 403);
    const csrfDenied = await client.request("/auth/patient/me", { method: "PATCH", scope: "patient", headers: { "X-CSRF-Token": "wrong" },
      body: { firstName: "forged", agreements: subjectAgreements() } });
    assertStatus(csrfDenied, 403); assert.equal((await h.models.User.findById(personId)).firstName, fields.firstName);
    const copied = client.clone();
    assertStatus(await client.request("/auth/logout", { method: "POST", scope: "patient", body: { scope: "patient" } }), 200);
    assertStatus(await copied.request("/auth/session?scope=patient", { scope: "patient" }), 401);
    assertStatus(await client.request("/auth/session?scope=admin", { scope: "admin" }), 200);
    assertStatus(await client.request("/auth/logout", { method: "POST", scope: "admin", body: { scope: "admin" } }), 200);
    assertStatus(await client.request("/auth/session?scope=admin", { scope: "admin" }), 401);
  });

  test("guest entries for an existing account preserve the official profile and assess the approved submitted snapshot", async () => {
    const id = citizenId();
    const official = await h.models.User.create({ citizenId: id, ...profile({ firstName: "ข้อมูลยืนยันแล้ว" }),
      status: "active", isVerified: true, accountEnabled: true });
    const submitted = profile({ firstName: "ข้อมูลจากผู้ส่ง", gender: "male", smokingStatus: "current", chronicDiseases: ["เบาหวาน"] });
    const { receipt } = await guest(h.guestPayload(id, { profile: submitted,
      records: measurements().filter(row => ["blood_pressure", "cholesterol"].includes(row.type)) }));
    const { submission, records } = await assertMaterialized(receipt);
    await manualReviewFixture(receipt);
    const before = await h.models.User.findById(official._id);
    assert.equal(before.firstName, "ข้อมูลยืนยันแล้ว"); assert.equal(before.gender, "female");
    assert.equal(before.isVerified, true); assert.equal(before.accountEnabled, true);
    assert.equal(await h.models.User.countDocuments({ citizenId: id }), 1);
    const decision = await staff.request("/reviews/decision", { method: "POST", body: { ids: records.map(row => String(row._id)), action: "approve" } });
    assertStatus(decision, 200); assert.equal(decision.body.data.changed, 2);
    const primary = await h.models.User.findById(official._id);
    assert.equal(primary.firstName, "ข้อมูลยืนยันแล้ว"); assert.deepEqual([...primary.chronicDiseases], []);
    assert.equal(primary.thaiCvRisk.status, "calculated"); assert.equal(primary.thaiCvRisk.inputs.sex, 0);
    const approved = await h.models.Health.find({ submissionKey: submission.internalId });
    approved.forEach(row => {
      assert.equal(row.reviewStatus, "approved"); assert.equal(row.thaiCvRisk.status, "calculated");
      assert.equal(row.thaiCvRisk.inputs.profileSource, "submitted-profile"); assert.equal(row.thaiCvRisk.inputs.sex, 1);
      assert.equal(row.thaiCvRisk.inputs.currentSmoker, true); assert.equal(row.thaiCvRisk.inputs.diabetes, true);
    });
  });

  test("selected rejection and filtered approve-all preserve audit/history and exclude submissions newer than the confirmation snapshot", async () => {
    const id = citizenId(), first = await guest(h.guestPayload(id));
    const { records } = await assertMaterialized(first.receipt);
    await manualReviewFixture(first.receipt);
    const rejected = records.find(row => row.type === "sugar");
    const rejection = await staff.request("/reviews/decision", { method: "POST", body: {
      ids: [String(rejected._id)], action: "reject", reason: "ผลตรวจไม่ชัดเจน" } });
    assertStatus(rejection, 200); assert.equal(rejection.body.data.changed, 1);
    const repeat = await staff.request("/reviews/decision", { method: "POST", body: { ids: [String(rejected._id)], action: "approve" } });
    assertStatus(repeat, 200); assert.equal(repeat.body.data.changed, 0); assert.equal(repeat.body.data.skipped, 1);
    const queue = await staff.request(`/reviews?status=pending&search=${id}&page=1&limit=1`);
    assertStatus(queue, 200); assert.equal(queue.body.total, 3); assert.equal(queue.body.data.length, 1); assert.equal(queue.body.hasMore, true);
    assert.equal(queue.body.data[0].userId.firstName, "ทดสอบ");
    await delay(15);
    const later = await guest(h.guestPayload(id, { records: [{ type: "sugar", value: { fbs: 99 } }] }));
    await assertMaterialized(later.receipt); await manualReviewFixture(later.receipt);
    const all = await staff.request("/reviews/decision", { method: "POST", body: {
      all: true, filters: { status: "pending", search: id }, cutoff: queue.body.snapshotAt, action: "approve" } });
    assertStatus(all, 200); assert.equal(all.body.data.changed, 3); assert.equal(all.body.data.matched, 3);
    const latest = await h.models.Health.findById(later.receipt.recordIds[0]);
    assert.equal(latest.reviewStatus, "pending"); assert.equal(latest.reviewHistory.length, 1);
    const history = await staff.request(`/public/health?citizenId=${id}&limit=20`);
    assertStatus(history, 200); assert.equal(history.body.total, 5);
    assert.equal(history.body.data.filter(row => row.reviewStatus === "approved").length, 3);
    assert.equal(history.body.data.filter(row => row.reviewStatus === "rejected").length, 1);
    assert.equal(history.body.data.filter(row => row.reviewStatus === "pending").length, 1);
    const cancelled = history.body.data.find(row => row._id === String(rejected._id));
    assert.equal(cancelled.reviewReason, "ผลตรวจไม่ชัดเจน"); assert.equal(cancelled.reviewHistory.length, 2);
    assert.equal(cancelled.reviewHistory.at(-1).status, "rejected");
    assert.equal(cancelled.reviewHistory.at(-1).adminKey, h.admins[0].internalId.toString());
    assert.equal(await h.models.Health.countDocuments({ citizenId: id }), 5, "Review decisions never delete records");
  });

  test("email GET is read-only, token actions stay within one submission, and simultaneous email/admin decisions transition each row once", async () => {
    const tag = `Email-${randomUUID()}`;
    const target = await guest(h.guestPayload(citizenId(), { profile: profile({ firstName: tag }), records: measurements().slice(0, 2) }));
    const other = await guest(h.guestPayload(citizenId(), { records: [{ type: "sugar", value: { fbs: 101 } }] }));
    const { submission, records } = await assertMaterialized(target.receipt);
    await assertMaterialized(other.receipt);
    await manualReviewFixture(target.receipt); await manualReviewFixture(other.receipt);
    await h.review.sendOutbox(); await h.review.sendOutbox();
    const message = h.sentEmails.find(item => item.patientName.startsWith(tag) && item.recipient === h.admins[0].email);
    assert.ok(message, "A real durable outbox job reached the stubbed delivery boundary");
    const token = new URL(message.approveUrl).searchParams.get("token");
    assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert.equal(new URL(message.rejectUrl).searchParams.get("token"), token);
    const before = await h.models.Health.find({ submissionKey: submission.internalId }).lean();
    const info = await target.client.request(`/reviews/email?token=${token}`, { anonymous: true });
    assertStatus(info, 200); assert.equal(info.body.data.canDecide, true); assert.equal(info.body.data.records.length, 2);
    assert.equal(info.body.data.submissionId, target.receipt.submissionId);
    assert.notEqual(info.body.data.maskedCitizenId, submission.citizenId);
    assert.equal(info.body.data.records[0].citizenId, undefined); assert.equal(info.body.data.records[0].userId, undefined);
    assert.deepEqual(await h.models.Health.find({ submissionKey: submission.internalId }).lean(), before);
    const [emailDecision, adminDecision] = await Promise.all([
      target.client.request("/reviews/email", { anonymous: true, method: "POST", body: { token, action: "approve", ids: other.receipt.recordIds } }),
      staff.request("/reviews/decision", { method: "POST", body: { ids: records.map(row => String(row._id)), action: "reject" } }),
    ]);
    assertStatus(emailDecision, 200); assertStatus(adminDecision, 200);
    assert.equal(emailDecision.body.data.changed + adminDecision.body.data.changed, 2);
    const final = await h.models.Health.find({ submissionKey: submission.internalId });
    final.forEach(row => {
      assert.ok(["approved", "rejected"].includes(row.reviewStatus)); assert.equal(row.reviewHistory.length, 2);
      assert.ok(["admin", "email"].includes(row.reviewHistory.at(-1).source));
      assert.equal(row.reviewHistory.at(-1).adminKey, h.admins[0].internalId);
    });
    assert.equal((await h.models.Health.findById(other.receipt.recordIds[0])).reviewStatus, "pending");
    const again = await target.client.request("/reviews/email", { anonymous: true, method: "POST", body: { token, action: "reject" } });
    assertStatus(again, 200); assert.equal(again.body.data.changed, 0);
    assertStatus(await target.client.request(`/reviews/email?token=${"z".repeat(43)}`, { anonymous: true }), 410);
  });

  test("Bangkok same-day 23:59 deadlines catch up through reads and win over late manual/email cancellation", async () => {
    const { reviewDeadline, tokenFor } = require("../src/utils/review");
    assert.equal(reviewDeadline(new Date("2026-11-01T16:58:59Z")).toISOString(), "2026-11-01T16:59:00.000Z");
    assert.equal(reviewDeadline(new Date("2026-11-01T17:00:00Z")).toISOString(), "2026-11-02T16:59:00.000Z");
    assert.equal(reviewDeadline(new Date("2026-11-01T16:59:30Z")).toISOString(), "2026-11-01T16:59:00.000Z");
    const { receipt, client } = await guest(h.guestPayload(citizenId(), { records: measurements().filter(row => ["blood_pressure", "cholesterol"].includes(row.type)) }));
    const { submission, records } = await assertMaterialized(receipt);
    assert.equal(submission.reviewDueAt.getTime(), reviewDeadline(submission.submittedAt).getTime());
    const due = new Date(Date.now() - 1000);
    await h.models.Submission.updateOne({ internalId: submission.internalId }, { $set: { reviewDueAt: due } });
    await h.models.Health.updateMany({ submissionKey: submission.internalId }, { $set: { reviewDueAt: due } });
    const job = await h.models.ReviewOutbox.findOne({ submissionKey: submission.internalId, adminKey: h.admins[0].internalId });
    const token = tokenFor("email-review", job._id, job.submissionId, job.adminId);
    const pure = await client.request(`/reviews/email?token=${token}`, { anonymous: true });
    assertStatus(pure, 200); assert.equal(pure.body.data.canDecide, true);
    assert.equal(await h.models.Health.countDocuments({ submissionKey: submission.internalId, reviewStatus: "pending" }), 2);
    const [email, manual] = await Promise.all([
      client.request("/reviews/email", { method: "POST", anonymous: true, body: { token, action: "reject" } }),
      staff.request("/reviews/decision", { method: "POST", body: { ids: records.map(row => String(row._id)), action: "reject" } }),
    ]);
    assertStatus(email, 200); assertStatus(manual, 200);
    assert.equal(email.body.data.changed, 0); assert.equal(manual.body.data.changed, 0);
    const final = await h.models.Health.find({ submissionKey: submission.internalId });
    final.forEach(row => { assert.equal(row.reviewStatus, "approved"); assert.equal(row.reviewSource, "automatic"); assert.equal(row.reviewHistory.length, 2);
      assert.equal(row.reviewHistory.at(-1).source, "automatic"); assert.equal(row.thaiCvRisk.status, "calculated"); });
    const readOnlyCatchup = await guest(h.guestPayload(citizenId(), { records: [{ type: "sugar", value: { fbs: 102 } }] }));
    const saved = await assertMaterialized(readOnlyCatchup.receipt);
    await h.models.Health.updateMany({ submissionKey: saved.submission.internalId }, { $set: { reviewDueAt: due } });
    const receiptRead = await readOnlyCatchup.client.request(`/public/submissions/${readOnlyCatchup.receipt.submissionId}?token=${readOnlyCatchup.receipt.receiptToken}`, { anonymous: true });
    assertStatus(receiptRead, 200); assert.equal(receiptRead.body.data.records[0].reviewStatus, "approved");
    assert.equal(receiptRead.body.data.records[0].reviewHistory.at(-1).source, "automatic");
  });

  test("durable email retries use real leases and a slow stale claimant cannot overwrite a newer sent result", async () => {
    await h.review.sendOutbox(); await h.review.sendOutbox();
    const retry = await guest(h.guestPayload(citizenId(), { records: [{ type: "sugar", value: { fbs: 103 } }] }));
    const retryRows = await assertMaterialized(retry.receipt);
    const email = require("../src/services/email.service"), normalSend = email.sendReviewNotification;
    let failOnce = true;
    email.sendReviewNotification = async message => { if (failOnce) { failOnce = false; throw new Error("Isolated SMTP failure"); } return normalSend(message); };
    try {
      await h.review.sendOutbox();
      const failed = await h.models.ReviewOutbox.findOne({ submissionKey: retryRows.submission.internalId, status: "failed" });
      assert.ok(failed); assert.equal(failed.attempts, 1); assert.ok(failed.nextAttemptAt > new Date());
      await h.models.ReviewOutbox.updateOne({ internalId: failed.internalId }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await h.review.sendOutbox();
      const recovered = await h.models.ReviewOutbox.findById(failed._id);
      assert.equal(recovered.status, "sent"); assert.equal(recovered.attempts, 2); assert.equal(recovered.leaseId, undefined);
    } finally { email.sendReviewNotification = normalSend; }
    const overlap = await guest(h.guestPayload(citizenId(), { profile: profile({ firstName: "Lease-overlap" }), records: [{ type: "sugar", value: { fbs: 104 } }] }));
    const overlapRows = await assertMaterialized(overlap.receipt);
    let began, release;
    const started = new Promise(resolve => { began = resolve; });
    let held = false;
    email.sendReviewNotification = message => {
      if (!held && message.patientName.startsWith("Lease-overlap")) {
        held = true; began(); return new Promise((resolve, reject) => { release = () => reject(new Error("Late failed claimant")); });
      }
      return normalSend(message);
    };
    let first;
    try {
      first = h.review.sendOutbox();
      await Promise.race([started, delay(10000).then(() => { throw new Error("Expected the first email lease to be claimed"); })]);
      const claim = await h.models.ReviewOutbox.findOne({ submissionKey: overlapRows.submission.internalId, status: "sending" });
      assert.ok(claim); assert.equal(typeof claim.leaseId, "string");
      await h.models.ReviewOutbox.updateOne({ internalId: claim.internalId }, { $set: { leaseUntil: new Date(Date.now() - 1000) } });
      await h.review.sendOutbox();
      assert.equal((await h.models.ReviewOutbox.findById(claim._id)).status, "sent");
      release(); await first;
      const finished = await h.models.ReviewOutbox.findById(claim._id);
      assert.equal(finished.status, "sent"); assert.equal(finished.attempts, 2); assert.equal(finished.lastError, "");
      assert.equal(finished.leaseId, undefined);
    } finally { if (release) release(); if (first) await first; email.sendReviewNotification = normalSend; }
  });

  test("disabled patient and staff accounts can revoke their session and cannot resurrect copied cookies after re-enabling", async () => {
    const bcrypt = require("bcrypt");
    const person = await h.models.User.create({ citizenId: citizenId(), ...profile(), accountEnabled: true,
      passwordHash: await bcrypt.hash("patient-disable-password", 4), tokenVersion: 1 });
    const client = h.newClient();
    assertStatus(await client.request("/auth/patient/login", { method: "POST", body: { citizenId: person.citizenId, password: "patient-disable-password" } }), 200);
    const copy = client.clone();
    await h.models.User.updateOne({ internalId: person.internalId }, { $set: { accountEnabled: false } });
    assertStatus(await client.request("/auth/session?scope=patient"), 401);
    assertStatus(await client.request("/auth/logout", { method: "POST", body: { scope: "patient" } }), 200);
    await h.models.User.updateOne({ internalId: person.internalId }, { $set: { accountEnabled: true } });
    assertStatus(await copy.request("/auth/session?scope=patient"), 401);
    const reviewer = h.newClient("admin");
    assertStatus(await reviewer.request("/auth/login", { method: "POST", body: { email: h.admins[1].email, password: "workflow-staff-password" } }), 200);
    const previous = reviewer.clone();
    await h.models.Admin.updateOne({ internalId: h.admins[1].internalId }, { $set: { isActive: false } });
    assertStatus(await reviewer.request("/auth/session?scope=admin"), 401);
    assertStatus(await reviewer.request("/auth/logout", { method: "POST", body: { scope: "admin" } }), 200);
    await h.models.Admin.updateOne({ internalId: h.admins[1].internalId }, { $set: { isActive: true } });
    assertStatus(await previous.request("/auth/session?scope=admin"), 401);
  });

  test("switching the browser cookie to a new account rejects stale generations and never exposes the former account", async () => {
    const bcrypt = require("bcrypt"), passwordHash = await bcrypt.hash("account-switch-password", 4);
    const [a, b] = await h.models.User.create(["First-account", "Second-account"].map(firstName => ({ citizenId: citizenId(),
      ...profile({ firstName }), accountEnabled: true, passwordHash, tokenVersion: 1 })));
    const client = h.newClient();
    assertStatus(await client.request("/auth/patient/login", { method: "POST", body: { citizenId: a.citizenId, password: "account-switch-password" } }), 200);
    const older = client.clone(), oldSession = client.sessions.get("patient");
    assertStatus(await client.request("/auth/patient/login", { method: "POST", body: { citizenId: b.citizenId, password: "account-switch-password" } }), 200);
    const stale = await client.request("/auth/patient/me", { session: oldSession });
    assertStatus(stale, 409); assert.equal(stale.body.code, "SESSION_CHANGED"); assert.equal(stale.headers.get("set-cookie"), null);
    const current = await client.request("/auth/patient/me");
    assertStatus(current, 200); assert.equal(current.body.data.patient.firstName, "Second-account");
    assert.equal(current.body.data.patient.citizenId, b.citizenId);
    assertStatus(await client.request(`/public/health?citizenId=${a.citizenId}`), 403);
    assertStatus(await older.request("/auth/session?scope=patient"), 401);
    const staleLogout = await client.request("/auth/logout", { method: "POST", session: oldSession, body: { scope: "patient" } });
    assertStatus(staleLogout, 409); assert.equal(staleLogout.headers.get("set-cookie"), null);
    assertStatus(await client.request("/auth/session?scope=patient"), 200);
  });

  test("staff PIN reset revokes every existing patient generation and the new PIN stays behind the password-change gate", async () => {
    const bcrypt = require("bcrypt");
    const person = await h.models.User.create({ citizenId: citizenId(), ...profile(), accountEnabled: true,
      passwordHash: await bcrypt.hash("original-patient-password", 4), tokenVersion: 1 });
    const first = h.newClient(), second = h.newClient();
    for (const client of [first, second]) {
      assertStatus(await client.request("/auth/patient/login", { method: "POST", body: {
        citizenId: person.citizenId, password: "original-patient-password" } }), 200);
    }
    assert.notEqual(first.sessions.get("patient").sessionId, second.sessions.get("patient").sessionId);
    const reset = await staff.request(`/users/admin/${person._id}/account`, { method: "POST", body: { password: "000123" } });
    assertStatus(reset, 200); assert.equal(reset.body.data.temporaryPassword, "000123");
    assert.equal(reset.body.data.patient.passwordHash, undefined);
    for (const client of [first, second]) {
      assertStatus(await client.request("/auth/session?scope=patient"), 401);
      assertStatus(await client.request(`/public/health?citizenId=${person.citizenId}`), 401);
      assertStatus(await client.request("/auth/patient/change-password", { method: "POST", body: {
        currentPassword: "original-patient-password", password: "stale-session-password" } }), 401);
    }
    const replacement = h.newClient();
    assertStatus(await replacement.request("/auth/patient/login", { method: "POST", body: {
      citizenId: person.citizenId, password: "original-patient-password" } }), 401);
    const login = await replacement.request("/auth/patient/login", { method: "POST", body: {
      citizenId: person.citizenId, password: "000123" } });
    assertStatus(login, 200); assert.equal(login.body.data.requiresPasswordChange, true);
    const blocked = await replacement.request(`/users/${person._id}/full`);
    assertStatus(blocked, 403); assert.equal(blocked.body.code, "PASSWORD_CHANGE_REQUIRED");
    assertStatus(await replacement.request("/auth/patient/change-password", { method: "POST", body: {
      currentPassword: "000123", password: "replacement-patient-password" } }), 200);
    assertStatus(await replacement.request(`/users/${person._id}/full`), 200);
    for (const client of [first, second]) assertStatus(await client.request("/auth/session?scope=patient"), 401);
  });

  test("concurrent password rotations have one winner and cannot revive the losing session", async () => {
    const bcrypt = require("bcrypt");
    const original = "parallel-original-password";
    const person = await h.models.User.create({ citizenId: citizenId(), ...profile(), accountEnabled: true,
      passwordHash: await bcrypt.hash(original, 4), tokenVersion: 7 });
    const clients = [h.newClient(), h.newClient()];
    for (const client of clients) assertStatus(await client.request("/auth/patient/login", { method: "POST", body: {
      citizenId: person.citizenId, password: original } }), 200);
    const before = clients.map(client => client.clone());
    const passwords = ["parallel-new-password-A", "parallel-new-password-B"];
    const results = await Promise.all(clients.map((client, index) => client.request("/auth/patient/change-password", {
      method: "POST", body: { currentPassword: original, password: passwords[index] } })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
    const winner = results.findIndex(result => result.status === 200), loser = 1 - winner;
    const stored = await h.models.User.findById(person._id).select("+passwordHash +tokenVersion");
    assert.equal(stored.tokenVersion, 8);
    assert.equal(await bcrypt.compare(passwords[winner], stored.passwordHash), true);
    assert.equal(await bcrypt.compare(passwords[loser], stored.passwordHash), false);
    assertStatus(await clients[winner].request("/auth/session?scope=patient"), 200);
    assertStatus(await clients[loser].request("/auth/session?scope=patient"), 401);
    for (const client of before) assertStatus(await client.request("/auth/session?scope=patient"), 401);
    assert.equal(await h.models.AuthSession.countDocuments({ accountId: person._id, scope: "patient" }), 1);
  });

  test("ObjectID profile routes, write endpoints, and operator-shaped input enforce ownership without exposing another person's records", async () => {
    const bcrypt = require("bcrypt");
    const [owner, other] = await h.models.User.create(["IDOR-owner", "IDOR-other"].map(firstName => ({
      citizenId: citizenId(), ...profile({ firstName }), accountEnabled: true,
      passwordHash: "", tokenVersion: 1,
    })));
    const passwordHash = await bcrypt.hash("idor-owner-password", 4);
    await h.models.User.updateOne({ internalId: owner.internalId }, { $set: { passwordHash } });
    const client = h.newClient();
    assertStatus(await client.request("/auth/patient/login", { method: "POST", body: {
      citizenId: owner.citizenId, password: "idor-owner-password" } }), 200);
    const own = await client.request(`/users/${owner._id}/full`);
    assertStatus(own, 200); assert.equal(own.body.data.user.citizenId, owner.citizenId);
    assert.equal(own.body.data.user.passwordHash, undefined); assert.equal(own.body.data.user.tokenVersion, undefined);
    for (const pathname of [`/users/${other._id}`, `/users/${other._id}/full`, "/users/admin", "/reviews", "/reviews/settings", "/dashboard/summary"]) {
      const result = await client.request(pathname);
      assertStatus(result, 403); assert.equal(JSON.stringify(result.body).includes(other.citizenId), false);
    }
    for (const [pathname, method, body] of [
      ["/users/admin", "POST", { citizenId: other.citizenId, ...profile(), agreements: staffAgreements() }],
      [`/users/admin/${other._id}/account`, "POST", { password: "123456" }],
      [`/users/admin/${other._id}/approve`, "PATCH", {}],
      ["/reviews/decision", "POST", { all: true, action: "approve" }],
      ["/public/health", "POST", { citizenId: other.citizenId, ...measurements()[0], agreements: subjectAgreements() }],
      ["/public/health", "POST", { citizenId: { $ne: null }, ...measurements()[0], agreements: subjectAgreements() }],
    ]) assertStatus(await client.request(pathname, { method, body }), 403);
    for (const pathname of ["/users/search?citizenId[$ne]=", "/public/health?citizenId[$ne]="]) {
      assertStatus(await client.request(pathname), 403);
      assertStatus(await staff.request(pathname), 400);
    }
    assertStatus(await staff.request("/users/admin?search[$ne]=x"), 400);
    assert.equal(await h.models.Health.countDocuments({ userKey: other.internalId }), 0);
    const unchanged = await h.models.User.findById(other._id).select("+passwordHash +tokenVersion");
    assert.equal(unchanged.passwordHash, ""); assert.equal(unchanged.tokenVersion, 1);
  });
});
