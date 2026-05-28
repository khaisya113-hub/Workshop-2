import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { db } from "../db";

export const registerUser = async (req: Request, res: Response) => {
  console.log("Registration request received:", req.body);
  try {
    const { 
      name, 
      email, 
      password, 
      role, 
      phoneNum, 
      ICNo, 
      status,
      doctorProfile 
    } = req.body;

    // Validate required fields
    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Validate allowed roles
    const allowedRoles = ['doctor', 'receptionist', 'pharmacist'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ 
        message: "Invalid role. Only doctor, receptionist, and pharmacist roles are allowed" 
      });
    }

    // Check if email already exists
    const [existing]: any = await db.query(
      "SELECT UserID FROM useraccount WHERE Email = ?",
      [email]
    );

    if (existing.length > 0) {
      return res.status(400).json({ message: "Email already registered" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Start transaction for multiple table operations
    await db.query("START TRANSACTION");

    try {
      // Insert new user
      const sql = `
        INSERT INTO useraccount (Name, Email, PasswordHash, Role, PhoneNum, ICNo, Status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;

      const values = [
        name,
        email,
        hashedPassword,
        role,
        phoneNum || null,
        ICNo || null,
        status || "Active"
      ];

      const [result]: any = await db.query(sql, values);
      const newUserId = result.insertId;

      // If role is doctor, insert into DoctorProfile
      if (role === 'doctor') {
        // FIXED: Check for specialization and licenseNo from frontend
        if (!doctorProfile || !doctorProfile.specialization || !doctorProfile.licenseNo) {
          throw new Error("Doctor profile information is required");
        }

        // REMOVED: DepartmentID validation since frontend doesn't send it
        // The frontend only sends: specialization, licenseNo, clinicRoom

        const doctorProfileSql = `
          INSERT INTO DoctorProfile (DoctorID, Specialization, LicenseNo, ClinicRoom)
          VALUES (?, ?, ?, ?)
        `;

        const doctorProfileValues = [
          newUserId,
          doctorProfile.specialization,
          doctorProfile.licenseNo,
          doctorProfile.clinicRoom || null
        ];

        await db.query(doctorProfileSql, doctorProfileValues);
      }

      // Commit transaction
      await db.query("COMMIT");

      res.status(201).json({
        message: role === 'doctor' 
          ? "Doctor registered successfully" 
          : "Staff registered successfully",
        user: { 
          id: newUserId, 
          name, 
          email, 
          role,
          ...(role === 'doctor' && { 
            specialization: doctorProfile.specialization,
            licenseNo: doctorProfile.licenseNo,
            clinicRoom: doctorProfile.clinicRoom
          })
        }
      });

    } catch (error) {
      // Rollback transaction on error
      await db.query("ROLLBACK");
      throw error;
    }

  } catch (error: any) {
    console.error("Register error:", error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "Email already registered" });
    }

    if (error.message.includes("Doctor profile")) {
      return res.status(400).json({ message: error.message });
    }

    res.status(500).json({ message: "Server error" });
  }
};

// NEW FUNCTION: Get all departments for dropdown
export const getDepartments = async (req: Request, res: Response) => {
  try {
    const [departments]: any = await db.query(
      "SELECT DepartmentID, DepartmentName, Description FROM department WHERE IsActive = 1 ORDER BY DepartmentName"
    );

    res.json(departments);
  } catch (error) {
    console.error("Get departments error:", error);
    res.status(500).json({ message: "Server error" });
  }
};