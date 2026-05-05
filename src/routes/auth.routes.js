// src/routes/auth.routes.js
const router = require("express").Router();
const auth = require("../controllers/auth.controller");

router.post("/admin/request-otp", auth.requestOTP);
router.post("/admin/verify-otp", auth.verifyOTP);

module.exports = router;