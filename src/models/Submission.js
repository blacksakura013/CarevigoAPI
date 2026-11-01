const mongoose = require("mongoose");
const internalIdsPlugin = require("./plugins/internalIds.plugin");
const { keySetter } = require("../utils/internalId");
const LegalAgreementSchema = require("./LegalAgreementSchema");
const SubmissionSchema = new mongoose.Schema({
  citizenId: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  profile: { type: mongoose.Schema.Types.Mixed, required: true },
  profileOnly: { type: Boolean, default: false },
  profileReviewStatus: { type: String, enum: ["pending", "approved", "rejected"] },
  profileMaterializedAt: Date,
  profileReviewedAt: Date,
  profileReviewSource: { type: String, enum: ["admin", "email", "automatic"] },
  profileReviewReason: String,
  profileReviewHistory: [{ at: Date, status: String, from: String, to: String, source: String, actor: String, actorId: String,
    adminKey: { type: mongoose.Schema.Types.BigInt, set: keySetter }, reason: String, _id: false }],
  legalAgreement: LegalAgreementSchema,
  records: [{ _id: mongoose.Schema.Types.ObjectId, internalId: { type: mongoose.Schema.Types.BigInt, set: keySetter },
    type: { type: String }, value: mongoose.Schema.Types.Mixed,
    weight: Number, height: Number, bmi: Number, cvdRisk: mongoose.Schema.Types.Mixed }],
  clientRequestId: { type: String, required: true },
  requestKeyHash: { type: String, required: true, unique: true, select: false },
  payloadHash: { type: String, required: true, select: false },
  receiptHash: { type: String, required: true, select: false },
  submittedAt: { type: Date, required: true },
  reviewDueAt: { type: Date, required: true },
  receiptExpiresAt: { type: Date, required: true },
  materialized: { type: Boolean, default: false, index: true },
  notificationsPrepared: { type: Boolean, default: false, index: true }
});
SubmissionSchema.index({ profileOnly: 1, profileReviewStatus: 1, reviewDueAt: 1 });
SubmissionSchema.plugin(internalIdsPlugin, { namespace: "Submission", relations: {
  userKey: { model: "User", legacyField: "userId", virtual: "userByKey" }
} });
module.exports = mongoose.model("Submission", SubmissionSchema);
