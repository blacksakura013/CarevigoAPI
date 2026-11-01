const { test } = require("node:test");
const assert = require("node:assert/strict");
const official = require("./fixtures/thai-cv-official.json");
const { calculateThaiCvRisk, classifyRisk, formatRiskScore, ageAt, normalizeDiseases } = require("../src/utils/thaiCvRisk");
const now = new Date("2026-11-01T05:00:00Z");
const complete = { birthDate: "19761101", gender: "male", smokingStatus: "never", chronicDiseases: [], chronicDiseasesConfirmed: true };
const measured = { systolic: 120, totalCholesterol: 200 };

test("total-cholesterol risk matches golden results produced by official Rama 2.5 JavaScript", () => {
  for (const fixture of official.fixtures) {
    const profile = { birthDate: `${2026 - fixture.age}1101`, gender: fixture.sex ? "male" : "female",
      smokingStatus: fixture.smoke ? "current" : "never", chronicDiseases: fixture.dm ? ["เบาหวาน"] : [], chronicDiseasesConfirmed: true };
    const result = calculateThaiCvRisk(profile, { systolic: fixture.sbp, totalCholesterol: fixture.tc }, now);
    assert.equal(result.status, "calculated");
    assert.ok(Math.abs(result.score - fixture.percent) < 1e-10, `Official fixture: ${JSON.stringify(fixture)}`);
  }
});

test("user requested colors include exactly 20 percent in moderate", () => {
  assert.equal(classifyRisk(9.9999), "low");
  assert.equal(classifyRisk(10), "moderate");
  assert.equal(classifyRisk(20), "moderate");
  assert.equal(classifyRisk(20.0001), "high");
});

test("percentage display never rounds across the color thresholds", () => {
  assert.equal(formatRiskScore(9.999), "<10%");
  assert.equal(formatRiskScore(10), "10.00%");
  assert.equal(formatRiskScore(20), "20.00%");
  assert.equal(formatRiskScore(20.001), ">20%");
  assert.equal(formatRiskScore(30.001), ">30%");
});

test("unanswered smoking and disease history never imply no risk factors", () => {
  const result = calculateThaiCvRisk({ birthDate: complete.birthDate, gender: "male" }, measured, now);
  assert.equal(result.status, "incomplete");
  assert.equal(result.score, null);
  assert.ok(result.missing.includes("smokingStatus"));
  assert.ok(result.missing.includes("chronicDiseasesConfirmed"));
});

test("former smoking is not current smoking and diabetes aliases are normalized", () => {
  const former = calculateThaiCvRisk({ ...complete, smokingStatus: "former", chronicDiseases: ["diabetes"] }, measured, now);
  const never = calculateThaiCvRisk({ ...complete, chronicDiseases: ["เบาหวาน"] }, measured, now);
  assert.equal(former.score, never.score);
  assert.equal(former.inputs.diabetes, true);
  assert.deepEqual(normalizeDiseases(["ไขมันในเลือดสูง", "มะเร็งเต้านม", "โรคเบาหวาน"]), ["ไขมันในเส้นเลือด", "มะเร็ง", "เบาหวาน"]);
});

test("age eligibility and established heart/stroke disease prevent inappropriate estimates", () => {
  for (const birthDate of ["19931101", "19541101"]) assert.equal(calculateThaiCvRisk({ ...complete, birthDate }, measured, now).status, "ineligible");
  for (const disease of ["โรคหัวใจ", "โรคหลอดเลือดสมอง", "โรคลิ้นหัวใจ", "หัวใจเต้นผิดจังหวะ"]) {
    const risk = calculateThaiCvRisk({ ...complete, chronicDiseases: [disease] }, measured, now);
    assert.equal(risk.status, "ineligible"); assert.equal(risk.score, null);
  }
});

test("out-of-domain measurements remain explicit and are never silently clamped", () => {
  for (const measurements of [{ ...measured, systolic: 69 }, { ...measured, systolic: 221 }, { ...measured, totalCholesterol: 281 }]) {
    const result = calculateThaiCvRisk(complete, measurements, now);
    assert.equal(result.status, "incomplete"); assert.equal(result.score, null);
    assert.equal(result.inputs.systolic, measurements.systolic);
    assert.equal(result.inputs.totalCholesterol, measurements.totalCholesterol);
  }
});

test("age accepts compact or ISO dates, rejects invalid dates, and uses Bangkok birthdays", () => {
  assert.equal(ageAt("19761101", now), 50);
  assert.equal(ageAt("1976-11-01", now), 50);
  assert.equal(ageAt("19760230", now), null);
  assert.equal(ageAt("19761102", now), 49);
  assert.equal(ageAt("19761102", new Date("2026-11-01T17:01:00Z")), 50);
});

test("risk above 30 percent preserves raw score but follows official display cap", () => {
  const result = calculateThaiCvRisk({ ...complete, birthDate: "19661101", smokingStatus: "current", chronicDiseases: ["เบาหวาน"] }, { systolic: 160, totalCholesterol: 240 }, now);
  assert.ok(result.score > 30); assert.equal(result.level, "high"); assert.equal(result.displayScore, ">30%");
});
