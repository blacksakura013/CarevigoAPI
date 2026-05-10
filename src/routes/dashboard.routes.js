// src/routes/dashboard.routes.js

const router = require("express").Router();

const dashboard = require("../controllers/dashboard.controller");

const authMiddleware = require("../middleware/auth.middleware");

// ===============================
// 📊 DASHBOARD SUMMARY
// ===============================
router.get(
  "/summary",
  authMiddleware,
  dashboard.summary
);

// ===============================
// 👥 USER ANALYTICS
// ===============================
router.get(
  "/users",
  authMiddleware,
  dashboard.usersAnalytics
);

// ===============================
// 🩺 HEALTH ANALYTICS
// ===============================
router.get(
  "/health",
  authMiddleware,
  dashboard.healthAnalytics
);

// ===============================
// ❤️ RISK ANALYTICS
// ===============================
router.get(
  "/risk",
  authMiddleware,
  dashboard.riskAnalytics
);

// ===============================
// ✅ VERIFICATION ANALYTICS
// ===============================
router.get(
  "/verification",
  authMiddleware,
  dashboard.verificationAnalytics
);

// ===============================
// ⚙️ SYSTEM ANALYTICS
// ===============================
router.get(
  "/system",
  authMiddleware,
  dashboard.systemAnalytics
);

// ===============================
// 🗺️ RISK BY PROVINCE
// ===============================
router.get(
  "/risk/provinces",
  authMiddleware,
  dashboard.riskByProvince
);

// ===============================
// 🦠 TOP CHRONIC DISEASES
// ===============================
router.get(
  "/chronic-diseases",
  authMiddleware,
  dashboard.topChronicDiseases
);

module.exports = router;