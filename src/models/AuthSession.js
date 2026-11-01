const mongoose = require("mongoose");
const { toInternalId } = require("../utils/internalId");

// Sessions are addressed by a hash of a random identifier, never by a health ID.
// TTL is housekeeping; authentication also checks expiresAt on every request.
const AuthSessionSchema = new mongoose.Schema({
  _id: { type: String },
  scope: { type: String, enum: ["patient", "admin"], required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  accountKey: { type: mongoose.Schema.Types.BigInt, set: value => value == null ? value : toInternalId(value) },
  // Missing on legacy rows; new rows retain the credential generation so
  // delayed cleanup can leave a later valid login intact.
  tokenVersion: { type: Number, min: 0, max: Number.MAX_SAFE_INTEGER, validate: Number.isSafeInteger },
  expiresAt: { type: Date, required: true, expires: 0 },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("AuthSession", AuthSessionSchema);
