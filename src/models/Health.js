const mongoose = require("mongoose");

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

  isVerified: { type: Boolean, default: false },
  source: { type: String, default: "public" },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Health", HealthSchema);