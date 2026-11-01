// Ramathibodi Thai CV risk score 2.5, total-cholesterol model, 23 April 2021.
// https://www.rama.mahidol.ac.th/cardio_vascular_risk/thai_cv_risk_score/scripts/formular.js
const SOURCE = "https://www.rama.mahidol.ac.th/cardio_vascular_risk/thai_cv_risk_score/";
const SMOKING_STATUSES = ["never", "current", "former"];
const DISEASE_ALIASES = {
  "diabetes": "เบาหวาน", "diabetes mellitus": "เบาหวาน", "โรคเบาหวาน": "เบาหวาน",
  "hypertension": "ความดันโลหิตสูง", "heart disease": "โรคหัวใจ",
  "stroke": "โรคหลอดเลือดสมอง", "ไขมันในเลือดสูง": "ไขมันในเส้นเลือด",
  "dyslipidemia": "ไขมันในเส้นเลือด", "cancer": "มะเร็ง"
};

function normalizeDiseases(diseases) {
  return [...new Set((Array.isArray(diseases) ? diseases : []).filter(item => typeof item === "string")
    .map(item => item.trim()).filter(Boolean)
    .map(item => DISEASE_ALIASES[item.toLowerCase()] || (item.startsWith("มะเร็ง") ? "มะเร็ง" : item)))];
}

function ageAt(birthDate, now = new Date()) {
  if (typeof birthDate !== "string") return null;
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(birthDate);
  if (!match) return null;
  const [, yearString, monthString, dayString] = match;
  const year = Number(yearString), month = Number(monthString), day = Number(dayString);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now).map(part => [part.type, part.value]));
  let age = Number(parts.year) - year;
  if (Number(parts.month) < month || (Number(parts.month) === month && Number(parts.day) < day)) age -= 1;
  return age >= 0 ? age : null;
}

function classifyRisk(score) {
  return score < 10 ? "low" : score <= 20 ? "moderate" : "high";
}
function formatRiskScore(score) {
  const level = classifyRisk(score);
  if (score > 30) return ">30%";
  if (level === "low" && Number(score.toFixed(2)) >= 10) return "<10%";
  if (level === "high" && Number(score.toFixed(2)) <= 20) return ">20%";
  return `${score.toFixed(2)}%`;
}

function calculateThaiCvRisk(profile, measurements = {}, now = new Date()) {
  const age = ageAt(profile.birthDate, now);
  const sex = ["male", "ชาย"].includes(profile.gender) ? 1 : ["female", "หญิง"].includes(profile.gender) ? 0 : null;
  const diseases = normalizeDiseases(profile.chronicDiseases);
  const smokingKnown = SMOKING_STATUSES.includes(profile.smokingStatus);
  const systolic = measurements.systolic === "" || measurements.systolic == null ? null : Number(measurements.systolic);
  const totalCholesterol = measurements.totalCholesterol === "" || measurements.totalCholesterol == null ? null : Number(measurements.totalCholesterol);
  const inputs = {
    age, sex, smokingStatus: smokingKnown ? profile.smokingStatus : null,
    currentSmoker: smokingKnown ? profile.smokingStatus === "current" : null,
    diabetes: profile.chronicDiseasesConfirmed === true ? diseases.includes("เบาหวาน") : null,
    systolic, totalCholesterol,
    bloodPressureRecordedAt: measurements.bloodPressureRecordedAt || null,
    cholesterolRecordedAt: measurements.cholesterolRecordedAt || null
  };
  const base = { status: "incomplete", score: null, level: null, label: "ข้อมูลยังไม่ครบ", missing: [], reason: "",
    model: "thai-cv-total-cholesterol", source: SOURCE, sourceVersion: "2.5 (2021-04-23)",
    inputs, calculatedAt: now, displayScore: null };
  if (diseases.some(item => /โรคหัวใจ|หลอดเลือดหัวใจ|กล้ามเนื้อหัวใจ|หลอดเลือดสมอง|ลิ้นหัวใจ|หัวใจเต้นผิดจังหวะ/i.test(item))) {
    return { ...base, status: "ineligible", label: "ไม่อยู่ในกลุ่มที่ใช้แบบประเมินนี้", reason: "แบบประเมินนี้ไม่ใช้ในผู้ที่มีโรคหัวใจ โรคหลอดเลือดสมอง โรคลิ้นหัวใจ หรือหัวใจเต้นผิดจังหวะอยู่เดิม" };
  }
  if (age !== null && (age < 35 || age > 70)) {
    return { ...base, status: "ineligible", label: "อายุอยู่นอกช่วงของแบบประเมิน", reason: "Thai CV risk ใช้สำหรับคนไทยอายุ 35–70 ปีที่ยังไม่มีโรคหัวใจและหลอดเลือด" };
  }
  if (age === null) base.missing.push("birthDate");
  if (sex === null) base.missing.push("gender");
  if (!smokingKnown) base.missing.push("smokingStatus");
  if (profile.chronicDiseasesConfirmed !== true) base.missing.push("chronicDiseasesConfirmed");
  if (!Number.isFinite(systolic) || systolic < 70 || systolic > 220) base.missing.push("systolic");
  if (!Number.isFinite(totalCholesterol) || totalCholesterol <= 0 || totalCholesterol > 280) base.missing.push("totalCholesterol");
  if (base.missing.length) {
    base.reason = "ต้องมีวันเกิด เพศ ประวัติสูบบุหรี่ ประวัติโรคที่ยืนยันแล้ว ความดันตัวบน 70–220 mmHg และไขมันรวมมากกว่า 0 ถึง 280 mg/dL โดยไม่มีการปรับค่าผลตรวจอัตโนมัติ";
    return base;
  }
  const fullScore = 0.08183 * age + 0.39499 * sex + 0.02084 * systolic +
    0.69974 * Number(inputs.diabetes) + 0.00212 * totalCholesterol + 0.41916 * Number(inputs.currentSmoker);
  const score = 100 * (1 - Math.pow(0.964588, Math.exp(fullScore - 7.04423)));
  const level = classifyRisk(score);
  return { ...base, status: "calculated", score, level,
    label: { low: "ความเสี่ยงต่ำ", moderate: "ความเสี่ยงปานกลาง", high: "ความเสี่ยงสูง" }[level],
    displayScore: formatRiskScore(score),
    reason: "ความเสี่ยงเกิดโรคหัวใจและหลอดเลือดในระยะ 10 ปี จาก Thai CV risk score สูตรใช้ไขมันรวม" };
}

module.exports = { calculateThaiCvRisk, classifyRisk, formatRiskScore, normalizeDiseases, ageAt, SMOKING_STATUSES };
