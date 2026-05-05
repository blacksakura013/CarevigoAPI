// src/models/Admin.js
const mongoose = require("mongoose");

const AdminSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  role: { type: String, default: "admin" },
  isActive: { type: Boolean, default: true },
  lastLogin: Date,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Admin", AdminSchema);