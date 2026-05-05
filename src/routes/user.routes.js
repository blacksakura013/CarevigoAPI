const router = require("express").Router();

const userController = require("../controllers/user.controller");
const authMiddleware = require("../middleware/auth.middleware");

// 🟢 PUBLIC
router.post("/", userController.createOrUpdateUser);
router.get("/search", userController.getUserByCitizenId);

// 🔒 ADMIN
router.post("/admin", authMiddleware, userController.createUserAdmin);
router.patch("/admin/:id/approve", authMiddleware, userController.approveUser);
router.get("/admin", authMiddleware, userController.getUsers);
router.get("/:id", authMiddleware, userController.getUserById);
router.get(
  "/:id/full",
  authMiddleware,
  userController.getUserFullProfile
);
module.exports = router;   // 🔥 ห้ามลืมบรรทัดนี้