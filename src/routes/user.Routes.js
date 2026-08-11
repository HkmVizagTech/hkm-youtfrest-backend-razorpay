const userController = require("../controllers/user.Controller");
const { authenticate, requireAdminUnlessFirstUser } = require("../middlewares/auth.middleware");
const { Router } = require("express");
const userRouter = Router();

// Only an existing admin can list team accounts (used by the Team page)
userRouter.get("/", authenticate(["admin"]), userController.getUser);

// Open only when zero accounts exist (bootstrap); otherwise requires an
// authenticated admin, and accepts a `role` in the body.
userRouter.post("/register", requireAdminUnlessFirstUser, userController.register);

userRouter.post("/login", userController.login);

// Admin can remove a teammate's account
userRouter.delete("/:id", authenticate(["admin"]), userController.deleteUser);

module.exports = { userRouter };
