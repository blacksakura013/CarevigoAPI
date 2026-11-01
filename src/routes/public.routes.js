const router = require("express").Router();
const controller = require("../controllers/public.controller");
const rateLimit = require("../middleware/rateLimit.public");
const auth = require("../middleware/auth.middleware");
const { requirePatientReady, ownCitizen } = require("../middleware/access.middleware");
const submission = require("../controllers/submission.controller");
const guestLimit = require("express-rate-limit")({ windowMs: 60000, max: 10, standardHeaders: true, legacyHeaders: false });
const profileLimit = require("express-rate-limit")({ windowMs: 60000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { statusCode: 429, message: "ค้นหาข้อมูลถี่เกินไป กรุณารอสักครู่แล้วลองอีกครั้ง", data: null } });
router.get("/patient-profile", profileLimit, require("../controllers/public.profile.controller").patientProfile);
router.post("/submissions", guestLimit, submission.submit);
router.get("/submissions/:id", guestLimit, submission.receipt);
router.use(auth, requirePatientReady);

router.get("/health/progress", ownCitizen("query"), require("../controllers/health.progress.controller").getProgress);
router.post("/health", ownCitizen("body"), rateLimit, controller.submitHealth);
router.get("/health", ownCitizen("query"), require("../middleware/review.middleware"), controller.getHealthByCitizen);

module.exports = router;
