import { Request, Response } from "express";
import { db } from "../db";

// GET all users
export const getAllUsers = async (req: Request, res: Response) => {
  try {
    const [rows]: any = await db.query(
      `SELECT 
          UserID AS id,
          Name AS name,
          Email AS email,
          PhoneNum AS phoneNum,
          ICNo,
          Role AS role,
          Status AS status
       FROM useraccount
       WHERE Role != 'Admin'
       ORDER BY UserID DESC`
    );

    // Add initials
    const users = rows.map((u: any) => ({
      ...u,
      initials: u.name
        .split(" ")
        .map((n: string) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    }));

    res.json(users);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ 
      success: false,
      message: "Server error fetching users" 
    });
  }
};

// PUT update user
export const updateUser = async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);
    const { name, email, phoneNum, role, status, ICNo } = req.body;

    // Validate required fields
    if (!name || !email || !role || !status) {
      return res.status(400).json({ 
        success: false,
        message: "Missing required fields" 
      });
    }

    // Check if email already exists for another user
    const [existingEmail]: any = await db.query(
      "SELECT UserID FROM useraccount WHERE Email = ? AND UserID != ?",
      [email, userId]
    );

    if (existingEmail.length > 0) {
      return res.status(400).json({ 
        success: false,
        message: "Email already registered to another user" 
      });
    }

    // Check if IC number already exists for another user
    if (ICNo) {
      const cleanICNo = ICNo.replace(/[\s-]/g, '');
      const [existingIC]: any = await db.query(
        "SELECT UserID FROM useraccount WHERE ICNo = ? AND UserID != ?",
        [cleanICNo, userId]
      );

      if (existingIC.length > 0) {
        return res.status(400).json({ 
          success: false,
          message: "IC number already registered to another user" 
        });
      }
    }

    // Update user
    const sql = `
      UPDATE useraccount 
      SET Name = ?, Email = ?, PhoneNum = ?, Role = ?, Status = ?, ICNo = ?
      WHERE UserID = ?
    `;

    const cleanICNo = ICNo ? ICNo.replace(/[\s-]/g, '') : null;

    await db.query(sql, [
      name,
      email,
      phoneNum || null,
      role,
      status,
      cleanICNo,
      userId
    ]);

    // If role is doctor, ensure DoctorProfile exists
    if (role === 'doctor') {
      const [doctorProfile]: any = await db.query(
        "SELECT DoctorID FROM DoctorProfile WHERE DoctorID = ?",
        [userId]
      );

      if (doctorProfile.length === 0) {
        // Create default doctor profile
        await db.query(
          "INSERT INTO DoctorProfile (DoctorID, Specialization) VALUES (?, 'General Medicine')",
          [userId]
        );
      }
    }

    res.json({
      success: true,
      message: "User updated successfully"
    });

  } catch (error: any) {
    console.error("Error updating user:", error);
    
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ 
        success: false,
        message: "Duplicate entry. This email or IC number already exists." 
      });
    }

    res.status(500).json({ 
      success: false,
      message: "Server error updating user" 
    });
  }
};

// DELETE user
export const deleteUser = async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);

    // Check if user exists
    const [user]: any = await db.query(
      "SELECT UserID FROM useraccount WHERE UserID = ?",
      [userId]
    );

    if (user.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: "User not found" 
      });
    }

    // Get user role
    const [userRole]: any = await db.query(
      "SELECT Role FROM useraccount WHERE UserID = ?",
      [userId]
    );

    if (userRole[0].Role === 'Admin') {
      return res.status(403).json({ 
        success: false,
        message: "Cannot delete admin users" 
      });
    }

    // Start transaction for deletion
    await db.query("START TRANSACTION");

    try {
      // Check if user is a doctor and delete from DoctorProfile
      if (userRole[0].Role === 'doctor') {
        await db.query(
          "DELETE FROM DoctorProfile WHERE DoctorID = ?",
          [userId]
        );
      }

      // Delete user from UserAccount
      await db.query(
        "DELETE FROM useraccount WHERE UserID = ?",
        [userId]
      );

      await db.query("COMMIT");

      res.json({
        success: true,
        message: "User deleted successfully"
      });

    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }

  } catch (error: any) {
    console.error("Error deleting user:", error);
    
    // Handle foreign key constraint errors
    if (error.code === "ER_ROW_IS_REFERENCED_2") {
      return res.status(400).json({ 
        success: false,
        message: "Cannot delete user because they have related records in the system" 
      });
    }

    res.status(500).json({ 
      success: false,
      message: "Server error deleting user" 
    });
  }
};