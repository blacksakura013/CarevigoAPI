// ======================================
// src/models/Admin.js
// ======================================

const mongoose = require("mongoose");
const internalIdsPlugin = require("./plugins/internalIds.plugin");

const AdminSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    password: {
      type: String,
      default: null,
    },

    tokenVersion: { type: Number, default: 0, min: 0, max: Number.MAX_SAFE_INTEGER,
      validate: Number.isSafeInteger },
    passwordResetTokenHash: { type: String, select: false },
    passwordResetExpiresAt: { type: Date, select: false },
    passwordResetRequestedAt: { type: Date, select: false },

    role: {
      type: String,
      enum: ["admin", "superadmin"],
      default: "admin",
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    lastLogin: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

AdminSchema.index({ passwordResetTokenHash: 1 }, { sparse: true });

AdminSchema.plugin(internalIdsPlugin, { namespace: "Admin" });
module.exports = mongoose.model("Admin", AdminSchema);
