const mongoose = require("mongoose");
const ThaiCvRiskSchema = require("./ThaiCvRiskSchema");
const internalIdsPlugin = require("./plugins/internalIds.plugin");
const LegalAgreementSchema = require("./LegalAgreementSchema");

const UserSchema = new mongoose.Schema({
  citizenId: { type: String, required: true, unique: true },

  firstName: String,
  lastName: String,
  gender: String,
  birthDate: String,

  phone: String,
  email: String,
  lineId: String,

  emergencyContactName: String,
  emergencyContactPhone: String,

  province: String,
  district: String,
  subdistrict: String,
  address: String,

  weight: Number,
  height: Number,

  education: String,
  maritalStatus: String,
  occupation: String,
  economicStatus: String,

  chronicDiseases: [String],
  chronicDiseasesConfirmed: { type: Boolean, default: false },
  smokingStatus: { type: String, enum: ["never", "current", "former", ""] },
  smokingQuitMonths: { type: Number, min: 0 },
  cancerDetails: String,
  thaiCvRisk: ThaiCvRiskSchema,
  legalAgreement: LegalAgreementSchema,
  legalAgreementHistory: { type: [LegalAgreementSchema], default: undefined },

  passwordHash: { type: String, select: false },
  tokenVersion: { type: Number, default: 0, select: false },
  accountEnabled: { type: Boolean, default: false },
  requiresPasswordChange: { type: Boolean, default: false },

  status: { type: String, default: "pending" },
  isVerified: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now }
});

UserSchema.plugin(internalIdsPlugin, { namespace: "User" });
module.exports = mongoose.model("User", UserSchema);
