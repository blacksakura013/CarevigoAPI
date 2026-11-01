const { calculateThaiCvRisk } = require("./thaiCvRisk");

// A guest assessment belongs only to the durable snapshot they submitted. It
// never fills missing inputs from an existing account or approved measurements.
function submissionAssessment(submission) {
  const bloodPressure = submission.records.find(record => record.type === "blood_pressure");
  const cholesterol = submission.records.find(record => record.type === "cholesterol");
  const risk = calculateThaiCvRisk(submission.profile || {}, {
    systolic: bloodPressure?.value?.systolic,
    totalCholesterol: cholesterol?.value?.total,
    bloodPressureRecordedAt: bloodPressure ? submission.submittedAt : null,
    cholesterolRecordedAt: cholesterol ? submission.submittedAt : null,
  }, new Date(submission.submittedAt));
  const { status, score, level, label, displayScore, missing, reason, model, source, sourceVersion, calculatedAt } = risk;
  return { status, score, level, label, displayScore, missing, reason, model, source, sourceVersion, calculatedAt,
    inputs: { profileSource: "submitted-profile", bloodPressureRecordedAt: risk.inputs.bloodPressureRecordedAt,
      cholesterolRecordedAt: risk.inputs.cholesterolRecordedAt } };
}

module.exports = { submissionAssessment };
