// src/scripts/seedAdmin.js
require("dotenv").config();

require("dotenv").config({ path: ".env.local" });

const mongoose = require("mongoose");
const Admin = require("../models/Admin");

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  await Admin.create({
    email: "carevigo2026@gmail.com"
  });

  console.log("✅ Admin created");
  process.exit();
})();