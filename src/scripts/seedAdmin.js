// Explicit provisioning only. Never prints or resets an existing password.
require("dotenv").config();
require("dotenv").config({ path: ".env.local" });
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const Admin = require("../models/Admin");

(async () => {
  try {
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    if (!email || typeof password !== "string" || password.length < 8 || Buffer.byteLength(password,"utf8") > 72) {
      throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD (8+ characters, maximum 72 bytes) before provisioning");
    }
    await mongoose.connect(process.env.MONGO_URI);
    if (await Admin.findOne({ email })) throw new Error("The staff account already exists; provisioning will not reset it");
    await Admin.create({ email, password: await bcrypt.hash(password,12) });
    console.log("Staff account created");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
