const router = require("express").Router();

const userController = require("../controllers/user.controller");
const authMiddleware = require("../middleware/auth.middleware");
const patientAuth = require("../controllers/patient.auth.controller");
const { requireStaff, requirePatientReady, ownCitizen } = require("../middleware/access.middleware");

router.use(authMiddleware, requirePatientReady);

// 🟢 PUBLIC
router.post("/", requireStaff, userController.createUserAdmin);
router.get("/search", ownCitizen("query"), userController.getUserByCitizenId);

// 🔒 ADMIN
router.post("/admin", requireStaff, userController.createUserAdmin);
router.post("/admin/:id/account", requireStaff, patientAuth.provisionAccount);
router.patch("/admin/:id/approve", requireStaff, userController.approveUser);
router.get("/admin", requireStaff, userController.getUsers);
router.get("/:id", userController.getUserById);
router.get(
  "/:id/full",
  require("../middleware/review.middleware"),
  userController.getUserFullProfile
);
module.exports = router;   // 🔥 ห้ามลืมบรรทัดนี้
