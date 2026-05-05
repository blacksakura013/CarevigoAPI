const router = require("express").Router();
const controller = require("../controllers/public.controller");
const rateLimit = require("../middleware/rateLimit.public");

router.post("/health", rateLimit, controller.submitHealth);
router.get("/health", controller.getHealthByCitizen);

module.exports = router;