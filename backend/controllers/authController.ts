import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "../db";

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;

  console.log("🔐 Login attempt received:", { 
    email, 
    passwordLength: password?.length 
  });

  try {
    if (!email || !password) {
      console.log("❌ Missing email or password");
      return res.status(400).json({ 
        success: false,
        error: "Email and password are required" 
      });
    }

    const [rows]: any = await db.query(
      "SELECT * FROM UserAccount WHERE Email = ?",
      [email]
    );

    console.log("📊 Database query result count:", rows.length);

    if (rows.length === 0) {
      console.log("❌ User not found:", email);
      return res.status(401).json({ 
        success: false,
        error: "Invalid email or password" 
      });
    }

    const user = rows[0];
    console.log("👤 User found:", { 
      id: user.UserID, 
      name: user.Name, 
      role: user.Role,
      status: user.Status 
    });

    // Check if user is active
    if (user.Status !== 'Active') {
      console.log("❌ User account not active:", user.Status);
      return res.status(403).json({ 
        success: false,
        error: "Account is not active. Please contact administrator." 
      });
    }

    // Compare hashed password
    console.log("🔑 Comparing password...");
    
    // IMPORTANT: Check if password hash exists
    if (!user.PasswordHash) {
      console.log("❌ No password hash found for user");
      return res.status(500).json({
        success: false,
        error: "User password not properly configured. Contact administrator."
      });
    }
    
    const match = await bcrypt.compare(password, user.PasswordHash);

    if (!match) {
      console.log("❌ Password doesn't match");
      return res.status(401).json({ 
        success: false,
        error: "Invalid email or password" 
      });
    }

    console.log("✅ Login successful for:", email);

    // Check if JWT_SECRET is set
    if (!process.env.JWT_SECRET) {
      console.error("❌ JWT_SECRET is not set in environment variables");
      throw new Error("Server configuration error");
    }

    // Create JWT token
    const tokenPayload = {
      userId: user.UserID,
      role: user.Role,
      email: user.Email,
      name: user.Name
    };

    console.log("Creating token with payload:", tokenPayload);

    const token = jwt.sign(
      tokenPayload,
      process.env.JWT_SECRET!,
      { expiresIn: '8h' }
    );

    console.log("✅ Token created successfully");

    // Return response
    res.json({
      success: true,
      message: "Login successful",
      role: user.Role,
      name: user.Name,
      userId: user.UserID,
      email: user.Email,
      token: token
    });

  } catch (error: any) {
    console.error("🔥 Login error details:", error);
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);
    
    // Check specific errors
    if (error.code === 'ECONNREFUSED') {
      console.error("Database connection refused");
    }
    
    if (error.sql) {
      console.error("SQL Error:", error.sql);
      console.error("SQL Message:", error.sqlMessage);
    }
    
    res.status(500).json({ 
      success: false,
      error: "Server error during login",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      sqlError: process.env.NODE_ENV === 'development' && error.sqlMessage ? error.sqlMessage : undefined
    });
  }
};

// Add logout function
export const logout = (req: Request, res: Response) => {
  console.log("👋 Logout requested");
  
  // Clear cookies
  res.clearCookie('token');
  res.clearCookie('refreshToken');
  
  res.json({
    success: true,
    message: "Logged out successfully"
  });
};

// Add token refresh function
export const refreshToken = async (req: Request, res: Response) => {
  console.log("🔄 Token refresh requested");
  
  try {
    const refreshToken = req.cookies?.refreshToken;
    
    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        error: "Refresh token required"
      });
    }
    
    // Verify refresh token
    const decoded = jwt.verify(
      refreshToken, 
      process.env.REFRESH_TOKEN_SECRET!
    ) as { userId: number };
    
    // Get user from database
    const [users]: any = await db.query(
      "SELECT UserID, Role, Email, Name, Status FROM UserAccount WHERE UserID = ?",
      [decoded.userId]
    );
    
    if (users.length === 0 || users[0].Status !== 'Active') {
      return res.status(401).json({
        success: false,
        error: "User not found or inactive"
      });
    }
    
    const user = users[0];
    
    // Create new access token
    const newTokenPayload = {
      userId: user.UserID,
      role: user.Role,
      email: user.Email,
      name: user.Name
    };
    
    const newToken = jwt.sign(
      newTokenPayload,
      process.env.JWT_SECRET!,
      { expiresIn: '8h' }
    );
    
    // Set new token cookie
    res.cookie('token', newToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000
    });
    
    res.json({
      success: true,
      message: "Token refreshed",
      token: newToken
    });
    
  } catch (error: any) {
    console.error("Token refresh error:", error);
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: "Refresh token expired. Please log in again."
      });
    }
    
    res.status(401).json({
      success: false,
      error: "Invalid refresh token"
    });
  }
};

// Add check-auth endpoint to verify current auth status
export const checkAuth = (req: Request, res: Response) => {
  console.log("🔍 Auth check requested");
  
  if (!req.user) {
    return res.status(401).json({
      success: false,
      authenticated: false,
      error: "Not authenticated"
    });
  }
  
  res.json({
    success: true,
    authenticated: true,
    user: req.user
  });
};

// routes/auth.js
export const verifyEmail = async (req: Request, res: Response) => {
  const { email } = req.body;

  console.log("📧 Email verification attempt for:", email);

  try {
    if (!email) {
      console.log("❌ Email is required");
      return res.status(400).json({
        success: false,
        error: "Email is required"
      });
    }

    // Check in useraccount table (staff users)
    const [staffRows]: any = await db.query(
      "SELECT UserID, Name, ICNo FROM useraccount WHERE Email = ? AND Status = 'Active'",
      [email]
    );

    // Check in patientaccount table (patient users)
    const [patientRows]: any = await db.query(
      "SELECT PatientAccountID, Name, ICNumber FROM patientaccount WHERE Email = ?",
      [email]
    );

    let user = null;
    let userType = '';

    if (staffRows.length > 0) {
      user = staffRows[0];
      userType = 'staff';
      console.log("👨‍⚕️ Staff user found:", { id: user.UserID, name: user.Name });
    } else if (patientRows.length > 0) {
      user = patientRows[0];
      userType = 'patient';
      console.log("👤 Patient user found:", { id: user.PatientAccountID, name: user.Name });
    }

    if (!user) {
      console.log("❌ No user found with email:", email);
      return res.status(404).json({
        success: false,
        error: "No account found with this email address"
      });
    }

    // Mask IC number for security (show only last 4 digits)
    const maskedIc = user.ICNo || user.ICNumber;
    const displayIc = maskedIc ? 
      '•••••' + maskedIc.slice(-4) : 
      'Not available';

    console.log("✅ Email verified successfully");

    res.json({
      success: true,
      message: "Email verified",
      user: {
        name: user.Name,
        email: email,
        maskedIc: maskedIc,
        displayIc: displayIc,
        userType: userType,
        userId: user.UserID || user.PatientAccountID
      }
    });

  } catch (error: any) {
    console.error("🔥 Email verification error:", error);
    console.error("Error message:", error.message);
    
    res.status(500).json({
      success: false,
      error: "Server error during email verification",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

export const verifyIcNumber = async (req: Request, res: Response) => {
  const { email, icNumber } = req.body;

  console.log("🔐 IC verification attempt:", { email, icNumber });

  try {
    if (!email || !icNumber) {
      console.log("❌ Email and IC number are required");
      return res.status(400).json({
        success: false,
        error: "Email and IC number are required"
      });
    }

    // Clean IC number (remove non-numeric characters)
    const cleanIc = icNumber.replace(/\D/g, '');

    if (cleanIc.length < 8) {
      console.log("❌ Invalid IC number length");
      return res.status(400).json({
        success: false,
        error: "Invalid IC number format"
      });
    }

    // Check in useraccount table (staff users)
    const [staffRows]: any = await db.query(
      "SELECT UserID, Name, Email, ICNo, Role FROM useraccount WHERE Email = ? AND ICNo = ? AND Status = 'Active'",
      [email, cleanIc]
    );

    // Check in patientaccount table (patient users)
    const [patientRows]: any = await db.query(
      "SELECT PatientAccountID, Name, Email, ICNumber FROM patientaccount WHERE Email = ? AND ICNumber = ?",
      [email, cleanIc]
    );

    let user = null;
    let userType = '';

    if (staffRows.length > 0) {
      user = staffRows[0];
      userType = 'staff';
      console.log("👨‍⚕️ Staff IC verified:", { id: user.UserID, name: user.Name, role: user.Role });
    } else if (patientRows.length > 0) {
      user = patientRows[0];
      userType = 'patient';
      console.log("👤 Patient IC verified:", { id: user.PatientAccountID, name: user.Name });
    }

    if (!user) {
      console.log("❌ IC number doesn't match email:", { email, icNumber });
      return res.status(401).json({
        success: false,
        error: "IC number does not match the email provided"
      });
    }

    console.log("✅ IC number verified successfully");

    res.json({
      success: true,
      message: "Identity verified successfully",
      user: {
        name: user.Name,
        email: user.Email,
        icNumber: cleanIc,
        userType: userType,
        userId: user.UserID || user.PatientAccountID,
        role: user.Role || 'patient'
      }
    });

  } catch (error: any) {
    console.error("🔥 IC verification error:", error);
    console.error("Error message:", error.message);
    
    res.status(500).json({
      success: false,
      error: "Server error during IC verification",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

export const resetPassword = async (req: Request, res: Response) => {
  const { email, icNumber, newPassword } = req.body;

  console.log("🔄 Password reset request for:", email);

  try {
    if (!email || !icNumber || !newPassword) {
      console.log("❌ Missing required fields");
      return res.status(400).json({
        success: false,
        error: "All fields are required"
      });
    }

    // Password validation
    if (newPassword.length < 8) {
      console.log("❌ Password too short");
      return res.status(400).json({
        success: false,
        error: "Password must be at least 8 characters long"
      });
    }

    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(newPassword)) {
      console.log("❌ Password doesn't meet requirements");
      return res.status(400).json({
        success: false,
        error: "Password must contain uppercase, lowercase letters and numbers"
      });
    }

    // Clean IC number
    const cleanIc = icNumber.replace(/\D/g, '');

    // Verify user exists and matches credentials (for security)
    const [staffRows]: any = await db.query(
      "SELECT UserID FROM useraccount WHERE Email = ? AND ICNo = ? AND Status = 'Active'",
      [email, cleanIc]
    );

    const [patientRows]: any = await db.query(
      "SELECT PatientAccountID FROM patientaccount WHERE Email = ? AND ICNumber = ?",
      [email, cleanIc]
    );

    if (staffRows.length === 0 && patientRows.length === 0) {
      console.log("❌ User not found or credentials don't match");
      return res.status(404).json({
        success: false,
        error: "User not found or credentials don't match"
      });
    }

    // Hash the new password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Update password based on user type
    let updateResult;
    if (staffRows.length > 0) {
      // Update staff user password
      updateResult = await db.query(
        "UPDATE useraccount SET PasswordHash = ? WHERE Email = ? AND ICNo = ?",
        [hashedPassword, email, cleanIc]
      );
      console.log("👨‍⚕️ Staff password updated for UserID:", staffRows[0].UserID);
    } else {
      // Update patient password
      updateResult = await db.query(
        "UPDATE patientaccount SET PasswordHash = ? WHERE Email = ? AND ICNumber = ?",
        [hashedPassword, email, cleanIc]
      );
      console.log("👤 Patient password updated for PatientAccountID:", patientRows[0].PatientAccountID);
    }

    console.log("✅ Password reset successfully for:", email);

    // Optional: Log the password reset action
    try {
      await db.query(
        "INSERT INTO password_reset_logs (email, reset_at, ip_address) VALUES (?, NOW(), ?)",
        [email, req.ip || 'unknown']
      );
    } catch (logError) {
      console.log("Note: Could not log password reset action");
    }

    res.json({
      success: true,
      message: "Password has been reset successfully",
      redirect: "/signin"
    });

  } catch (error: any) {
    console.error("🔥 Password reset error:", error);
    console.error("Error message:", error.message);
    
    res.status(500).json({
      success: false,
      error: "Server error during password reset",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};