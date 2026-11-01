const router = require("express").Router();
const controller = require("../controllers/public.controller");
const rateLimit = require("../middleware/rateLimit.public");
const auth = require("../middleware/auth.middleware");
const { requirePatientReady, ownCitizen } = require("../middleware/access.middleware");
const submission = require("../controllers/submission.controller");
const guestLimit = require("express-rate-limit")({ windowMs: 60000, max: 10, standardHeaders: true, legacyHeaders: false });
router.post("/submissions", guestLimit, submission.submit);
router.get("/submissions/:id", guestLimit, submission.receipt);
router.use(auth, requirePatientReady);

router.post("/health", ownCitizen("body"), rateLimit, controller.submitHealth);
router.get("/health", ownCitizen("query"), require("../middleware/review.middleware"), controller.getHealthByCitizen);

module.exports = router;
