const mongoose = require("mongoose");

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

  status: { type: String, default: "pending" },
  isVerified: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("User", UserSchema);