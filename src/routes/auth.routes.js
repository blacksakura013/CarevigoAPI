const express = require("express");
const router = express.Router();

const authController = require("../controllers/auth.controller");
const authMiddleware = require("../middleware/auth.middleware");

router.post("/login", authController.login);

router.post(
  "/change-password",
  authMiddleware,
  authController.changePassword
);

module.exports = router;