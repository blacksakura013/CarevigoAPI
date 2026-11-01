const mongoose = require("mongoose");
const internalIdsPlugin = require("./plugins/internalIds.plugin");
const ReviewOutboxSchema = new mongoose.Schema({
  submissionId: { type: mongoose.Schema.Types.ObjectId, ref: "Submission", required: true },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
  recipient: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  expiresAt: { type: Date, required: true },
  status: { type: String, enum: ["pending", "sending", "sent", "failed", "expired"], default: "pending" },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  leaseUntil: Date, leaseId: String, sentAt: Date, lastError: String,
  createdAt: { type: Date, default: Date.now }
});
ReviewOutboxSchema.index({ submissionId: 1, adminId: 1 }, { unique: true });
ReviewOutboxSchema.index({ status: 1, nextAttemptAt: 1 });
ReviewOutboxSchema.plugin(internalIdsPlugin, { namespace: "ReviewOutbox", relations: {
  submissionKey: { model: "Submission", legacyField: "submissionId", virtual: "submissionByKey" },
  adminKey: { model: "Admin", legacyField: "adminId", virtual: "adminByKey" }
} });
ReviewOutboxSchema.index({ submissionKey: 1, adminKey: 1 }, { unique: true, name: "outbox_submission_admin_int64",
  partialFilterExpression: { submissionKey: { $type: "long" }, adminKey: { $type: "long" } } });
module.exports = mongoose.model("ReviewOutbox", ReviewOutboxSchema);
