const test = require("node:test");
const assert = require("node:assert/strict");
const { profileReviewFilter, profileReviewRow } = require("../src/utils/profileReview");

test("profile review filters preserve status, escaped search and snapshot semantics using submission fields", () => {
  const filter = profileReviewFilter({ status: "pending", search: "Name.*" }, "2026-11-01T12:00:00Z");
  const json = JSON.stringify(filter);
  assert.equal(json.includes('"profileOnly":true'), true);
  assert.equal(json.includes('"profileReviewStatus":"pending"'), true);
  assert.equal(json.includes('"profile.firstName"'), true);
  assert.equal(json.includes('"profileMaterializedAt"'), true);
  assert.equal(json.includes('"submittedAt"'), true);
  assert.equal(json.includes('"submittedProfile.'), false);
  assert.equal(json.includes('"reviewStatus"'), false);
  assert.match(json, /Name\\\\\.\\\\\*/);
});

test("public profile review representations retain audit but omit submitted profile and ownership", () => {
  const source = { _id: "submission", internalId: 9007199254740993n, citizenId: "1234567890123", userId: "owner", userKey: 9007199254740994n,
    profile: { firstName: "Private snapshot", phone: "0800000000" }, profileReviewStatus: "rejected",
    profileReviewHistory: [{ status: "pending" }, { status: "rejected", reason: "ไม่ชัดเจน" }], submittedAt: new Date("2026-11-01T01:00:00Z") };
  const safe = profileReviewRow(source);
  assert.equal(safe.type, "profile"); assert.equal(safe.reviewEntity, "submission-profile");
  assert.equal(safe.reviewStatus, "rejected"); assert.equal(safe.reviewHistory.length, 2);
  for (const field of ["citizenId", "userId", "userKey", "submittedProfile", "legalAgreement"]) assert.equal(safe[field], undefined);
  assert.deepEqual(safe.value, {});
  const queue = profileReviewRow(source, { privateFields: true });
  assert.equal(queue.submittedProfile.firstName, "Private snapshot"); assert.equal(queue.userKey, source.userKey);
});
