const mongoose = require("mongoose");
const { keySetter } = require("../utils/internalId");

module.exports = new mongoose.Schema({
  termsVersion: { type: String, required: true },
  privacyVersion: { type: String, required: true },
  termsAccepted: { type: Boolean, required: true },
  healthDataConsent: Boolean,
  privacyNoticeAcknowledged: Boolean,
  lawfulAuthorityConfirmed: Boolean,
  acceptedAt: { type: Date, required: true },
  purposes: [{ type: String }],
  source: { type: String, enum: ["patient-consent", "guest-consent", "staff-attestation"], required: true },
  actorId: String,
  actorKey: { type: mongoose.Schema.Types.BigInt, set: keySetter },
}, { _id: false });
