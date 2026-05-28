import express from "express";
import { login, 
    verifyEmail, verifyIcNumber, resetPassword, logout, refreshToken, checkAuth } from "../controllers/authController";
import { verifyToken } from "../middleware/authMiddleware";

const router = express.Router();

// Public routes
router.post("/login", login);
router.post("/refresh", refreshToken);
router.post("/logout", logout);

// Protected route (requires authentication)
router.get("/check", verifyToken, checkAuth);

router.post("/verify-email", verifyEmail);
router.post("/verify-ic", verifyIcNumber);
router.post("/reset-password", resetPassword);

export default router;
