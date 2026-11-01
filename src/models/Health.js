const mongoose = require("mongoose");
const ThaiCvRiskSchema = require("./ThaiCvRiskSchema");
const internalIdsPlugin = require("./plugins/internalIds.plugin");
const { keySetter } = require("../utils/internalId");
const LegalAgreementSchema = require("./LegalAgreementSchema");

const HealthSchema = new mongoose.Schema({
  userId: { type: mongoose.Types.ObjectId, ref: "User", index: true },
  citizenId: { type: String, index: true },

  type: { type: String, required: true }, // blood_pressure | sugar | cholesterol | bmi

  value: { type: Object }, // flexible payload

  // BMI + CVD
  weight: Number,
  height: Number,
  bmi: Number,
  cvdRisk: {
    level: String,
    label: String
  },
  thaiCvRisk: ThaiCvRiskSchema,
  legalAgreement: LegalAgreementSchema,
  submissionId: { type: mongoose.Schema.Types.ObjectId, ref: "Submission", index: true },
  submittedProfile: mongoose.Schema.Types.Mixed,
  submittedAt: Date,
  materializedAt: { type: Date, index: true },
  reviewStatus: { type: String, enum: ["pending", "approved", "rejected"], default: "approved", index: true },
  reviewDueAt: { type: Date, index: true },
  reviewedAt: Date,
  reviewSource: { type: String, enum: ["patient", "admin", "email", "automatic"] },
  reviewReason: String,
  reviewHistory: [{ at: Date, status: String, from: String, to: String, source: String, actor: String, actorId: String,
    adminKey: { type: mongoose.Schema.Types.BigInt, set: keySetter }, reason: String, _id: false }],

  isVerified: { type: Boolean, default: false },
  source: { type: String, default: "public" },

  createdAt: { type: Date, default: Date.now }
});

HealthSchema.plugin(internalIdsPlugin, { namespace: "Health", relations: {
  userKey: { model: "User", legacyField: "userId", virtual: "userByKey" },
  submissionKey: { model: "Submission", legacyField: "submissionId", virtual: "submissionByKey" }
} });
HealthSchema.index({ userKey: 1, type: 1, createdAt: -1, _id: -1 }, { name: "health_user_type_date_int64", partialFilterExpression: { userKey: { $type: "long" } } });
HealthSchema.index({ submissionKey: 1, createdAt: 1, _id: 1 }, { name: "health_submission_date_int64", partialFilterExpression: { submissionKey: { $type: "long" } } });
module.exports = mongoose.model("Health", HealthSchema);
