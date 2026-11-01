const test = require("node:test");
const assert = require("node:assert/strict");
const { submissionAssessment } = require("../src/utils/submissionAssessment");
const { calculateThaiCvRisk } = require("../src/utils/thaiCvRisk");

const fixture = () => ({ citizenId: "1234567890123", userId: "private-owner", submittedAt: new Date("2026-11-01T16:59:00Z"),
  profile: { firstName: "Private name", phone: "0800000000", birthDate: "19761102", gender: "male", smokingStatus: "current",
    chronicDiseases: ["เบาหวาน"], chronicDiseasesConfirmed: true },
  records: [{ type: "blood_pressure", value: { systolic: 140, diastolic: 80 } }, { type: "cholesterol", value: { total: 220 } }],
  thaiCvRisk: { score: 0, level: "low" } });

test("submission assessment allowlists derived fields and omits identifiers and sensitive raw profile inputs", () => {
  const source = fixture(), original = structuredClone(source);
  const risk = submissionAssessment(source);
  assert.equal(risk.status, "calculated");
  assert.deepEqual(Object.keys(risk.inputs).sort(), ["bloodPressureRecordedAt", "cholesterolRecordedAt", "profileSource"]);
  assert.equal(risk.inputs.profileSource, "submitted-profile");
  for (const secret of [source.citizenId, source.userId, source.profile.firstName, source.profile.phone]) assert.equal(JSON.stringify(risk).includes(secret), false);
  for (const field of ["age", "sex", "diabetes", "smokingStatus", "currentSmoker", "systolic", "totalCholesterol"]) assert.equal(risk.inputs[field], undefined);
  assert.deepEqual(source, original);
});

test("assessment uses the original Bangkok birthday and timestamp instead of the request date or a supplied score", t => {
  const source = fixture(), first = submissionAssessment(source);
  const expected = calculateThaiCvRisk(source.profile, { systolic: 140, totalCholesterol: 220 }, source.submittedAt);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-03T00:00:00Z") });
  const later = submissionAssessment(source);
  assert.deepEqual(later, first); assert.equal(later.score, expected.score); assert.equal(later.calculatedAt.toISOString(), "2026-11-01T16:59:00.000Z");
  assert.notEqual(later.score, calculateThaiCvRisk(source.profile, { systolic: 140, totalCholesterol: 220 }).score);
});
