const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const User = require("../src/models/User");
const Health = require("../src/models/Health");
const Submission = require("../src/models/Submission");
const ids = require("../src/services/internalIds.service");
const legal = require("../src/utils/legal");
const { pickProfile } = require("../src/utils/patientProfile");
const patient = require("../src/controllers/patient.auth.controller");
const publicController = require("../src/controllers/public.controller");
const registration = require("../src/controllers/user.controller");
const submission = require("../src/controllers/submission.controller");
const agreements = require("./fixtures/legal-agreements.json");
const citizenId = "1234567890123";
const accountId = "507f1f77bcf86cd799439011";
const actorKey = 9007199254740993n;
const result = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const base = () => ({ citizenId, firstName: "Example", type: "sugar", value: { fbs: 100 }, profile: { firstName: "Example" }, records: [{ type: "sugar", value: { fbs: 100 } }] });

test("every new data entry rejects missing, false and stale agreements before any database mutation", async t => {
  let mutations = 0;
  for (const [Model, methods] of [[User, ["create", "findOneAndUpdate", "findByIdAndUpdate"]], [Health, ["create"]], [Submission, ["create"]]]) {
    for (const method of methods) t.mock.method(Model, method, () => { mutations++; throw new Error("No write is allowed"); });
  }
  const endpoints = [submission.submit, publicController.submitHealth, patient.updateMe, registration.createUserAdmin, registration.createOrUpdateUser];
  for (const endpoint of endpoints) {
    const staff = endpoint === registration.createUserAdmin || endpoint === registration.createOrUpdateUser;
    const current = staff ? agreements.staff : agreements.patient;
    for (const value of [undefined, {}, { ...current, termsAccepted: false }, { ...current, privacyVersion: "old" }, { ...current, termsVersion: "old" }]) {
      const response = result();
      await endpoint({ body: { ...base(), agreements: value }, patient: { _id: accountId }, user: { id: accountId, type: staff ? "admin" : "patient" } }, response);
      assert.equal(response.statusCode, 422, endpoint.name);
      assert.equal(response.body.code, "LEGAL_AGREEMENT_REQUIRED");
      assert.match(response.body.message, /กรุณา/);
    }
  }
  assert.equal(mutations, 0);
});

test("health consent and staff authority are distinct and unchecked values never count as acceptance", () => {
  for (const value of [false, "true", 1, null, undefined]) {
    assert.throws(() => legal.validateAgreements({ ...agreements.patient, healthDataConsent: value }, "patient-consent"), { code: "LEGAL_AGREEMENT_REQUIRED" });
    assert.throws(() => legal.validateAgreements({ ...agreements.staff, lawfulAuthorityConfirmed: value }, "staff-attestation"), { code: "LEGAL_AGREEMENT_REQUIRED" });
    assert.throws(() => legal.validateAgreements({ ...agreements.staff, privacyNoticeAcknowledged: value }, "staff-attestation"), { code: "LEGAL_AGREEMENT_REQUIRED" });
  }
  assert.throws(() => legal.validateAgreements(agreements.patient, "staff-attestation"), { code: "LEGAL_AGREEMENT_REQUIRED" });
  assert.throws(() => legal.validateAgreements(agreements.staff, "patient-consent"), { code: "LEGAL_AGREEMENT_REQUIRED" });
});

test("acceptance proofs use server metadata and exact internal actor keys, never submitted actor/time/purposes", () => {
  const acceptedAt = new Date("2026-11-01T08:00:00Z");
  const normalized = legal.validateAgreements({ ...agreements.patient, acceptedAt: "1900-01-01", actorId: "forged", actorKey: "999", purposes: ["advertising"], source: "staff-attestation" }, "patient-consent");
  const proof = legal.agreementProof(normalized, "patient-consent", { id: accountId, internalId: actorKey }, acceptedAt);
  assert.equal(proof.acceptedAt, acceptedAt); assert.equal(proof.actorId, accountId); assert.equal(proof.actorKey, actorKey);
  assert.equal(proof.source, "patient-consent"); assert.deepEqual(proof.purposes, ["health-records", "cv-risk-assessment"]);
  assert.equal(proof.healthDataConsent, true); assert.equal(proof.privacyNoticeAcknowledged, undefined);
  const staff = legal.agreementProof(legal.validateAgreements({ ...agreements.staff, healthDataConsent: true }, "staff-attestation"), "staff-attestation", { id: accountId });
  assert.equal(staff.healthDataConsent, undefined); assert.equal(staff.privacyNoticeAcknowledged, true); assert.equal(staff.lawfulAuthorityConfirmed, true);
  const guest = legal.agreementProof(legal.validateAgreements(agreements.patient, "guest-consent"), "guest-consent");
  assert.equal(guest.actorId, undefined); assert.equal(guest.actorKey, undefined);
  assert.deepEqual(pickProfile({ firstName: "Allowed", agreements: normalized, legalAgreement: proof, legalAgreementHistory: [proof] }), { firstName: "Allowed" });
});

test("patient profile update atomically replaces the latest proof and appends a new server-controlled history entry", async t => {
  const prior = legal.agreementProof(agreements.patient, "patient-consent", { id: accountId }, new Date("2026-10-01T00:00:00Z"));
  const account = { _id: accountId, internalId: actorKey, citizenId, legalAgreement: prior, legalAgreementHistory: [prior] };
  let profileUpdate;
  t.mock.method(User, "findOne", async () => account);
  t.mock.method(User, "findOneAndUpdate", async (filter, update) => {
    assert.deepEqual(filter, { internalId: actorKey });
    if (update.$push) {
      profileUpdate = update;
      account.legalAgreementHistory.push(update.$push.legalAgreementHistory);
    }
    Object.assign(account, update.$set);
    return account;
  });
  t.mock.method(Health, "findOne", () => ({ sort: async () => null }));
  const response = result();
  await patient.updateMe({ patient: account, user: { id: accountId, internalId: actorKey, type: "patient" }, body: {
    firstName: "Updated", agreements: agreements.patient,
    legalAgreement: { actorId: "forged", acceptedAt: "1900-01-01" }, legalAgreementHistory: [],
  } }, response);
  assert.equal(response.statusCode, 200); assert.equal(account.firstName, "Updated");
  assert.equal(profileUpdate.$set.legalAgreement, profileUpdate.$push.legalAgreementHistory);
  assert.equal(account.legalAgreementHistory.length, 2); assert.equal(account.legalAgreementHistory[0], prior);
  assert.equal(account.legalAgreement.source, "patient-consent"); assert.equal(account.legalAgreement.actorKey, actorKey);
  assert.equal(account.legalAgreement.acceptedAt instanceof Date, true); assert.notEqual(account.legalAgreement.acceptedAt.getTime(), prior.acceptedAt.getTime());
});

test("new staff registrations retain an authority attestation without inventing the patient's health consent", async t => {
  t.mock.method(User, "findOne", async () => null);
  let created;
  t.mock.method(User, "create", async value => { created = value; return { _id: accountId, ...value }; });
  const response = result();
  await registration.createUserAdmin({ user: { id: "staff-account", internalId: actorKey, type: "admin" }, body: {
    citizenId, firstName: "Registered", agreements: { ...agreements.staff, healthDataConsent: true },
    legalAgreement: { source: "patient-consent", actorId: "forged" }, legalAgreementHistory: [{ acceptedAt: "1900-01-01" }],
  } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(created.legalAgreement.source, "staff-attestation"); assert.equal(created.legalAgreement.healthDataConsent, undefined);
  assert.equal(created.legalAgreement.actorId, "staff-account"); assert.equal(created.legalAgreement.actorKey, actorKey);
  assert.deepEqual(created.legalAgreementHistory, [created.legalAgreement]);
});

test("authenticated health saves persist consent or staff attestation according to the authenticated account", async t => {
  const account = { _id: accountId, internalId: actorKey, citizenId };
  const created = [];
  t.mock.method(ids, "ensureInternalId", async () => actorKey);
  t.mock.method(Health, "create", async value => { created.push(value); return { _id: "record", ...value }; });
  let lookupCount = 0;
  t.mock.method(User, "findOne", async filter => {
    lookupCount++;
    return filter.citizenId ? account : null; // Risk refresh failure cannot undo the durable save.
  });
  for (const type of ["patient", "admin"]) {
    const response = result();
    await publicController.submitHealth({ user: { type, id: accountId, internalId: actorKey }, ...(type === "patient" ? { patient: account } : {}),
      body: { citizenId, type: "sugar", value: { fbs: 100 }, agreements: type === "patient" ? agreements.patient : agreements.staff,
        legalAgreement: { acceptedAt: "1900-01-01", source: "guest-consent" } } }, response);
    assert.equal(response.statusCode, 200);
  }
  assert.equal(created[0].legalAgreement.source, "patient-consent"); assert.equal(created[0].legalAgreement.healthDataConsent, true);
  assert.equal(created[1].legalAgreement.source, "staff-attestation"); assert.equal(created[1].legalAgreement.healthDataConsent, undefined);
  assert.ok(created.every(row => row.legalAgreement.acceptedAt instanceof Date && row.legalAgreement.actorKey === actorKey));
  assert.ok(lookupCount > 0);
});

test("Mongoose preserves exact proof keys and legacy documents remain without fabricated consent history", async () => {
  const proof = legal.agreementProof(agreements.patient, "patient-consent", { id: accountId, internalId: actorKey });
  const withProof = new User({ citizenId, legalAgreement: proof, legalAgreementHistory: [proof] });
  await withProof.validate();
  assert.equal(withProof.legalAgreement.actorKey, actorKey);
  assert.equal(withProof.legalAgreementHistory[0].actorKey, actorKey);
  const legacy = new User({ citizenId }); await legacy.validate();
  assert.equal(legacy.legalAgreement, undefined); assert.equal(legacy.legalAgreementHistory, undefined);
  const health = new Health({ type: "sugar", value: { fbs: 100 } }); await health.validate();
  assert.equal(health.legalAgreement, undefined);
  const submittedAt = new Date();
  const oldSubmission = new Submission({ userId: new mongoose.Types.ObjectId(), citizenId, profile: {}, records: [],
    clientRequestId: "legacy", requestKeyHash: "legacy", payloadHash: "legacy", receiptHash: "legacy", submittedAt,
    reviewDueAt: submittedAt, receiptExpiresAt: submittedAt });
  await oldSubmission.validate(); assert.equal(oldSubmission.legalAgreement, undefined);
});
