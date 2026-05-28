import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { db } from "../db";

// Define the user interface for TypeScript
interface UserPayload {
  userId: number;
  role: string;
  email: string;
  name: string;
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
    }
  }
}

// DEVELOPMENT MODE: Set this to true to bypass all authentication
const DISABLE_AUTH = process.env.NODE_ENV === 'development' && process.env.DISABLE_AUTH === 'true';

// Verify JWT token from Authorization header
export const verifyToken = async (req: Request, res: Response, next: NextFunction) => {
  console.log("🔐 Auth Middleware - Verifying token for:", req.path);
  
  // DEVELOPMENT BYPASS: Skip all authentication if enabled
  if (DISABLE_AUTH) {
    console.log("🔧 DEVELOPMENT MODE: Bypassing authentication");
    
    // Default admin user for development
    req.user = {
      userId: 1,
      role: 'Admin',
      email: 'admin@gmail.com',
      name: 'Admin User'
    };
    
    console.log("✅ Development user authenticated:", req.user);
    return next();
  }
  
  try {
    // Get token from Authorization header or cookies
    const authHeader = req.headers.authorization;
    let token: string | undefined;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
      console.log("📝 Token from Authorization header");
    } else if (req.cookies?.token) {
      token = req.cookies.token;
      console.log("🍪 Token from cookie");
    } else {
      console.log("❌ No token found");
      return res.status(401).json({
        success: false,
        error: "Access denied. No token provided."
      });
    }
    
    if (!token) {
      console.log("❌ Token is empty");
      return res.status(401).json({
        success: false,
        error: "Access denied. Invalid token."
      });
    }
    
    console.log("🔍 Verifying token...");
    
    // Verify the token with better error handling (from old system)
    let decoded: UserPayload;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET!) as UserPayload;
    } catch (jwtError: any) {
      if (jwtError.name === 'TokenExpiredError') {
        console.log("⚠️ Token expired");
        
        // For development: auto-generate a new token
        if (process.env.NODE_ENV === 'development' && process.env.AUTO_RENEW_TOKEN === 'true') {
          console.log("🔄 Development mode: Auto-renewing token");
          
          // Create a fresh token
          const newToken = jwt.sign(
            {
              userId: 1,
              role: 'Admin',
              email: 'admin@gmail.com',
              name: 'Admin User'
            },
            process.env.JWT_SECRET!,
            { expiresIn: '24h' }
          );
          
          // Set the new token in response header
          res.setHeader('X-New-Token', newToken);
          
          // Continue with the decoded user
          req.user = {
            userId: 1,
            role: 'Admin',
            email: 'admin@gmail.com',
            name: 'Admin User'
          };
          
          console.log("✅ Generated new token for expired token");
          return next();
        }
        
        return res.status(401).json({
          success: false,
          error: "Token expired. Please log in again.",
          code: 'TOKEN_EXPIRED'
        });
      }
      throw jwtError;
    }
    
    // Check if user still exists and is active (improved from old system)
    try {
      const [users]: any = await db.query(
        "SELECT UserID, Name, Email, Role, Status FROM UserAccount WHERE UserID = ?",
        [decoded.userId]
      );
      
      if (users.length === 0) {
        console.log("❌ User not found in database");
        return res.status(401).json({
          success: false,
          error: "User no longer exists."
        });
      }
      
      const user = users[0];
      
      if (user.Status !== 'Active') {
        console.log("❌ User account is not active:", user.Status);
        return res.status(403).json({
          success: false,
          error: "Account is deactivated."
        });
      }
      
      // Update decoded info with latest from database
      req.user = {
        userId: user.UserID,
        role: user.Role,
        email: user.Email,
        name: user.Name
      };
      
      console.log("✅ User authenticated:", {
        userId: req.user.userId,
        role: req.user.role,
        email: req.user.email
      });
      
      next();
    } catch (dbError: any) {
      console.error("❌ Database error during auth:", dbError.message);
      
      // If database error, allow development mode to continue
      if (process.env.NODE_ENV === 'development') {
        console.log("🔧 Development mode: Continuing despite database error");
        req.user = decoded;
        next();
      } else {
        return res.status(500).json({
          success: false,
          error: "Authentication service error."
        });
      }
    }
  } catch (error: any) {
    console.error("❌ Token verification failed:", error.message);
    
    // Last resort: development bypass
    if (process.env.NODE_ENV === 'development') {
      console.log("🔧 Development fallback: Using default admin");
      req.user = {
        userId: 1,
        role: 'Admin',
        email: 'admin@gmail.com',
        name: 'Admin User'
      };
      return next();
    }
    
    return res.status(401).json({
      success: false,
      error: "Authentication failed.",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Middleware to require specific role
export const requireRole = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: "Authentication required."
      });
    }
    
    // Development bypass: always allow all roles if DISABLE_AUTH is true
    if (DISABLE_AUTH) {
      console.log("🔧 DEVELOPMENT: Bypassing role check");
      return next();
    }
    
    if (!roles.includes(req.user.role)) {
      console.log(`❌ Role ${req.user.role} not allowed for ${roles}`);
      return res.status(403).json({
        success: false,
        error: "Insufficient permissions."
      });
    }
    
    next();
  };
};

// Improved devAuth from old system
export const devAuth = (req: Request, res: Response, next: NextFunction) => {
  console.log("🔧 devAuth middleware called");
  
  // Always set a user in development
  if (process.env.NODE_ENV === 'development') {
    const devUserId = req.headers['x-dev-user-id'];
    const devUserRole = req.headers['x-dev-user-role'];
    
    if (devUserId && devUserRole) {
      console.log("🔧 Development auth via headers");
      req.user = {
        userId: parseInt(devUserId as string),
        role: devUserRole as string,
        email: 'dev@example.com',
        name: 'Dev User'
      };
      return next();
    }
    
    // Fallback to default admin if no headers
    req.user = {
      userId: 1,
      role: 'Admin',
      email: 'admin@gmail.com',
      name: 'Admin User'
    };
    console.log("✅ Development auth set:", req.user);
    return next();
  }
  
  // In production, use verifyToken
  verifyToken(req, res, next);
};

// NEW: Completely disable auth for testing (from old system)
export const noAuth = (req: Request, res: Response, next: NextFunction) => {
  console.log("🔓 No-auth middleware: All requests allowed");
  
  req.user = {
    userId: 1,
    role: 'Admin',
    email: 'admin@gmail.com',
    name: 'Admin User'
  };
  
  next();
};

// NEW: Alias for requireRole (pharmacist system compatibility)
export const authorizeRole = requireRole;
