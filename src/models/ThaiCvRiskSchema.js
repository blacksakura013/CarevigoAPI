const mongoose = require("mongoose");
module.exports = new mongoose.Schema({
  status: { type: String, enum: ["calculated", "incomplete", "ineligible"] },
  score: Number, level: { type: String, enum: ["low", "moderate", "high", null] },
  label: String, missing: [String], reason: String, model: String,
  source: String, sourceVersion: String, inputs: mongoose.Schema.Types.Mixed,
  calculatedAt: Date, displayScore: String
}, { _id: false });
