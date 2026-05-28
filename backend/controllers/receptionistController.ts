import { Request, Response } from 'express';
import { RowDataPacket, OkPacket, ResultSetHeader } from 'mysql2';
import { db } from "../db";
import bcrypt from 'bcryptjs';

// ============ PATIENT MANAGEMENT ============
export const registerPatient = async (req: Request, res: Response) => {
  try {
    const { 
      name, icNo, gender, dob, phoneNumber, createdBy,
      email, bloodType, address,
      insuranceProvider, insurancePolicyNo,
      emergencyContactName, emergencyContactPhone,
      reasonForVisit, doctorId,
      // NEW FIELDS from frontend
      addressLine1, addressLine2, city, state, zipCode, country,
      chronicDisease, allergy
    } = req.body;
    
    console.log("Received patient data:", req.body);
    
    if (!name || !icNo || !gender || !dob || !phoneNumber || !createdBy) {
      return res.status(400).json({ 
        success: false,
        error: "Missing required fields: name, IC, gender, DOB, phone, createdBy"
      });
    }
    
    await db.query("START TRANSACTION");
    
    // Check duplicate IC
    const [existing]: any = await db.query(
      "SELECT PatientID FROM Patient WHERE ICNo = ?",
      [icNo]
    );
    
    if (existing.length > 0) {
      await db.query("ROLLBACK");
      return res.status(400).json({ 
        success: false,
        error: "Patient with this IC number already exists"
      });
    }
    
    // Build address from components if separate address fields are provided
    let finalAddress = address;
    if (!finalAddress && addressLine1) {
      finalAddress = [
        addressLine1,
        addressLine2,
        city,
        state,
        zipCode,
        country
      ].filter(Boolean).join(', ');
    }
    
    // Insert patient with ALL fields from database schema
    const [patient]: any = await db.query(`
      INSERT INTO Patient 
      (Name, ICNo, Gender, DOB, PhoneNumber, Email, Address, BloodType,
       InsuranceProvider, InsurancePolicyNo,
       EmergencyContactName, EmergencyContactPhone,
       CreatedBy, RegistrationDate,
       AddressLine1, AddressLine2, City, State, ZipCode, Country,
       ChronicDisease, Allergy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      name, 
      icNo, 
      gender.toUpperCase(), 
      dob, 
      phoneNumber, 
      email || null,
      finalAddress || null, 
      bloodType || null,
      insuranceProvider || null, 
      insurancePolicyNo || null,
      emergencyContactName || null, 
      emergencyContactPhone || null,
      createdBy,
      // New fields
      addressLine1 || null,
      addressLine2 || null,
      city || null,
      state || null,
      zipCode || null,
      country || 'USA',
      chronicDisease || 'N',
      allergy || 'N'
    ]);
    
    const patientId = patient.insertId;
    console.log(`Patient inserted with ID: ${patientId}`);
    
    // If there's a doctor and reason for visit, create an appointment and visit
    if (doctorId && reasonForVisit) {
      // Create an appointment first
      const [appointment]: any = await db.query(`
        INSERT INTO appointment 
        (AppointmentDateTime, Purpose, Status, PatientID, DoctorID, CreatedBy, QueueNumber)
        VALUES (NOW(), ?, 'scheduled', ?, ?, ?, ?)
      `, [reasonForVisit, patientId, doctorId, createdBy, 'TEMP']);
      
      const appointmentId = appointment.insertId;
      
      // Generate proper queue number
      const now = new Date();
      const year = now.getFullYear().toString().slice(-2);
      const month = (now.getMonth() + 1).toString().padStart(2, '0');
      const day = now.getDate().toString().padStart(2, '0');
      const dateStr = `${year}${month}${day}`;
      
      // Get max appointment number for today
      const [maxAppointment]: any = await db.query(`
        SELECT 
          CASE 
            WHEN QueueNumber LIKE 'Q-${dateStr}-%' 
            THEN MAX(CAST(SUBSTRING_INDEX(QueueNumber, '-', -1) AS UNSIGNED))
            ELSE 0
          END as maxNumber
        FROM appointment 
        WHERE DATE(AppointmentDateTime) = CURDATE()
      `, []);
      
      const lastNumber = maxAppointment[0].maxNumber || 0;
      const count = lastNumber + 1;
      const queueNumber = `Q-${dateStr}-${count.toString().padStart(3, '0')}`;
      
      // Update appointment with correct queue number
      await db.query(`
        UPDATE appointment 
        SET QueueNumber = ?
        WHERE AppointmentID = ?
      `, [queueNumber, appointmentId]);
      
      // Create patient visit
      const [visit]: any = await db.query(`
        INSERT INTO patient_visit 
        (AppointmentID, PatientID, DoctorID, VisitType, ArrivalTime, 
         CheckInTime, VisitStatus, QueueStatus, QueueNumber, QueuePosition, TriagePriority)
        VALUES (?, ?, ?, 'first-time', NOW(), NOW(), 'checked-in', 'waiting', ?, 1, 'low')
      `, [appointmentId, patientId, doctorId, queueNumber]);
      
      console.log(`Created appointment ${appointmentId} and visit ${visit.insertId} for new patient`);
    }
    
    await db.query("COMMIT");
    
    res.json({
      success: true,
      message: "Patient registered successfully",
      patientId,
      patientName: name
    });
    
  } catch (error: any) {
    await db.query("ROLLBACK");
    console.error("❌ Registration error:", error);
    
    // Log the SQL error details
    if (error.sql) {
      console.error("SQL Error:", error.sql);
      console.error("SQL Message:", error.sqlMessage);
    }
    
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ 
        success: false,
        error: "Duplicate entry. Patient may already exist."
      });
    }
    
    // Check for missing column errors
    if (error.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(400).json({ 
        success: false,
        error: `Database field error: ${error.sqlMessage}. Check your database schema.`
      });
    }
    
    res.status(500).json({ 
      success: false,
      error: "Registration failed",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// In your receptionist controller (receptionistController.js)
export const registerWalkIn = async (req: Request, res: Response) => {
  const { patientId, doctorId, reason, receptionistId, priority  } = req.body;

  try {
    if (!patientId || !reason || !receptionistId) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing required fields' 
      });
    }

    // Check if patient exists
    const [patientCheck]: any = await db.query(
      'SELECT PatientID FROM Patient WHERE PatientID = ?',
      [patientId]
    );

    if (patientCheck.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Patient not found' 
      });
    }

    // Check if patient already has an ACTIVE visit today
    const today = new Date().toISOString().split('T')[0];
    const [activeVisits]: any = await db.query(`
      SELECT VisitID FROM patient_visit 
      WHERE PatientID = ? 
        AND DATE(ArrivalTime) = ?
        AND QueueStatus IN ('waiting', 'in-progress')
        AND VisitStatus IN ('checked-in', 'in-consultation', 'waiting-for-results', 'ready-for-checkout')
    `, [patientId, today]);

    if (activeVisits.length > 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Patient already has an active visit today and cannot be added again' 
      });
    }

    // If doctor is specified, check if doctor exists
    if (doctorId) {
      const [doctorCheck]: any = await db.query(
        'SELECT UserID FROM useraccount WHERE UserID = ? AND Role = ?',
        [doctorId, 'doctor']
      );

      if (doctorCheck.length === 0) {
        return res.status(404).json({ 
          success: false,
          error: 'Doctor not found' 
        });
      }
    }

    // Get date in local timezone (YYMMDD format)
    const now = new Date();
    const year = now.getFullYear().toString().slice(-2); // Last 2 digits
    const month = (now.getMonth() + 1).toString().padStart(2, '0'); // Month is 0-indexed
    const day = now.getDate().toString().padStart(2, '0');
    const dateStr = `${year}${month}${day}`; // YYMMDD
    
    console.log('Date calculation:', {
      now: now.toISOString(),
      year,
      month,
      day,
      dateStr
    });

    // Get the MAX queue number for today that matches Q-YYMMDD-XXX pattern from patient_visit
    // Just get the maximum number from today's visits
    const [maxNumberResult]: any = await db.query(`
      SELECT MAX(CAST(SUBSTRING_INDEX(QueueNumber, '-', -1) AS UNSIGNED)) as maxNumber
      FROM patient_visit 
      WHERE DATE(ArrivalTime) = CURDATE()
      AND QueueNumber LIKE 'Q-${dateStr}-%'
    `, []);

    const lastNumber = maxNumberResult[0].maxNumber || 0;
    const count = lastNumber + 1;
    const queueNumber = `Q-${dateStr}-${count.toString().padStart(3, '0')}`;

    console.log('Queue number generation:', {
      dateStr,
      lastNumber,
      count,
      queueNumber
    });
    
    // Get next queue position
    const [maxPosition]: any = await db.query(
      'SELECT MAX(QueuePosition) as maxPos FROM patient_visit WHERE DATE(ArrivalTime) = CURDATE()',
      []
    );
    const queuePosition = (maxPosition[0].maxPos || 0) + 1;

    console.log('Queue position:', queuePosition);

    // Insert into patient_visit (CORRECTED: No ReasonForVisit column, use VisitNotes)
    // In your receptionistController.ts - registerWalkIn function
// Add priority parameter to the SQL query:
// CORRECTED VERSION:
    const [result]: any = await db.query(
      `INSERT INTO patient_visit (
        PatientID, 
        DoctorID, 
        VisitType, 
        ArrivalTime, 
        CheckInTime,
        VisitStatus, 
        QueueStatus,
        VisitNotes, 
        QueueNumber,
        QueuePosition,
        TriagePriority
      ) VALUES (?, ?, 'walk-in', NOW(), NOW(), 'checked-in', 'waiting', ?, ?, ?, ?)`,
      [
        patientId,
        doctorId || null,
        reason,
        queueNumber,
        queuePosition,
        priority || 'low'
      ]
    );

    res.json({
      success: true,
      visitId: result.insertId,
      queueNumber: queueNumber,
      queuePosition: queuePosition
    });

  } catch (error: any) {
    console.error('Walk-in registration error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to register walk-in patient',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

export const cancelVisit = async (req: Request, res: Response) => {
  const { visitId, reason, cancelledBy } = req.body;

  try {
    const [result]: any = await db.query(
      `UPDATE patient_visit 
       SET 
         VisitStatus = 'cancelled',
         QueueStatus = 'cancelled',
         VisitNotes = CONCAT(COALESCE(VisitNotes, ''), '\nCancelled by ${cancelledBy}: ${reason}')
       WHERE VisitID = ?`,
      [visitId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Visit not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Cancel visit error:", error);
    res.status(500).json({ error: "Failed to cancel visit" });
  }
};

export const markNoShow = async (req: Request, res: Response) => {
  const { visitId } = req.body;

  try {
    const [result]: any = await db.query(
      `UPDATE patient_visit 
       SET 
         VisitStatus = 'no-show',
         QueueStatus = 'cancelled',
         VisitNotes = CONCAT(COALESCE(VisitNotes, ''), '\nMarked as No Show')
       WHERE VisitID = ?`,
      [visitId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Visit not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("No show error:", error);
    res.status(500).json({ error: "Failed to mark as no show" });
  }
};

export const searchPatient = async (req: Request, res: Response) => {
  const { search } = req.query;
  
  try {
    console.log('=== SEARCH PATIENT DEBUG v3 ===');
    console.log('Search term:', search);
    
    if (!search || (typeof search === 'string' && search.trim() === '')) {
      return res.json([]);
    }

    const searchTerm = `%${search}%`;
    
    // FIXED: Use local date for comparison
    const now = new Date();
    const today = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
    
    console.log('Today (local):', today);
    console.log('Current time:', now.toISOString());
    
    // SIMPLE VERSION: Get patients first, then check visits
    const [patients]: any = await db.query(`
      SELECT 
        PatientID as id, 
        Name, 
        ICNo, 
        PhoneNumber, 
        Email,
        Gender,
        DATE_FORMAT(DOB, '%Y-%m-%d') as DOB,
        BloodType
      FROM Patient 
      WHERE (Name LIKE ? OR ICNo LIKE ? OR PhoneNumber LIKE ?)
      ORDER BY Name
      LIMIT 20
    `, [searchTerm, searchTerm, searchTerm]);
    
    console.log(`Found ${patients.length} patients matching search`);
    
    // Check visits for each patient
    const patientsWithVisits = await Promise.all(
      patients.map(async (patient: any) => {
        // Get the LATEST visit for this patient today
        const [visits]: any = await db.query(`
          SELECT 
            VisitID,
            VisitStatus,
            QueueStatus,
            QueueNumber,
            ArrivalTime
          FROM patient_visit 
          WHERE PatientID = ? 
            AND DATE(ArrivalTime) = ?
          ORDER BY VisitID DESC
          LIMIT 1
        `, [patient.id, today]);
        
        const hasVisit = visits.length > 0;
        const visit = hasVisit ? visits[0] : null;
        
        // DEBUG: Log raw data
        console.log(`\nPatient: ${patient.Name} (ID: ${patient.id})`);
        console.log('Has visit today?', hasVisit);
        if (visit) {
          console.log('Latest VisitID:', visit.VisitID);
          console.log('QueueStatus:', visit.QueueStatus);
          console.log('QueueNumber:', visit.QueueNumber);
          console.log('VisitStatus:', visit.VisitStatus);
          console.log('ArrivalTime:', visit.ArrivalTime);
        }
        
        // Determine if active - FIXED: Use both VisitStatus and QueueStatus
        let hasActiveVisit = false;
        if (visit) {
          const queueStatus = visit.QueueStatus ? visit.QueueStatus.trim().toLowerCase() : '';
          const visitStatus = visit.VisitStatus ? visit.VisitStatus.trim().toLowerCase() : '';
          
          console.log('QueueStatus (trimmed, lower):', queueStatus);
          console.log('VisitStatus (trimmed, lower):', visitStatus);
          
          // Active if not completed, cancelled, or no-show
          const completedStatuses = ['completed', 'cancelled', 'no-show'];
          hasActiveVisit = !completedStatuses.includes(queueStatus) && 
                          !completedStatuses.includes(visitStatus);
          console.log('Is active status?', hasActiveVisit);
        }
        
        const canRegister = !hasActiveVisit;
        console.log('Can register?', canRegister);
        
        return {
          ...patient,
          canRegister: canRegister,
          queueInfo: visit ? {
            queueNumber: visit.QueueNumber,
            queueStatus: visit.QueueStatus,
            visitStatus: visit.VisitStatus,
            arrivalTime: visit.ArrivalTime
          } : null,
          queueStatusCategory: !visit ? 'no-visit-today' :
                              hasActiveVisit ? 'active-visit' : 
                              'completed-or-cancelled'
        };
      })
    );
    
    console.log('\n=== FINAL RESULTS ===');
    patientsWithVisits.forEach((p, i) => {
      console.log(`${i + 1}. ${p.Name}: canRegister=${p.canRegister}, queueStatus=${p.queueInfo?.queueStatus || 'none'}, queueNumber=${p.queueInfo?.queueNumber || 'none'}`);
    });
    
    res.json(patientsWithVisits);
    
  } catch (error) {
    console.error("Patient search error:", error);
    res.status(500).json({ error: "Search failed" });
  }
};

export const getPatientDetails = async (req: Request, res: Response) => {
  const { patientId } = req.params;
  
  try {
    const [patient]: any = await db.query(`
      SELECT 
        p.*,
        COUNT(DISTINCT a.AppointmentID) as totalAppointments,
        COUNT(DISTINCT pv.VisitID) as totalVisits,
        DATE_FORMAT(MAX(pv.ArrivalTime), '%Y-%m-%d') as lastVisitDate
      FROM Patient p
      LEFT JOIN appointment a ON p.PatientID = a.PatientID
      LEFT JOIN patient_visit pv ON p.PatientID = pv.PatientID
      WHERE p.PatientID = ?
      GROUP BY p.PatientID
    `, [patientId]);
    
    if (patient.length === 0) {
      return res.status(404).json({ error: "Patient not found" });
    }
    
    res.json(patient[0]);
  } catch (error) {
    console.error("Get patient details error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ============ APPOINTMENT MANAGEMENT ============
export const scheduleAppointment = async (req: Request, res: Response) => {
  const { 
    patientId, 
    doctorId, 
    appointmentDateTime, 
    purpose, 
    notes, 
    createdBy
  } = req.body;
  
  try {
    if (!patientId || !doctorId || !appointmentDateTime || !purpose || !createdBy) {
      return res.status(400).json({ 
        success: false,
        error: "Missing required fields"
      });
    }
    
    await db.query("START TRANSACTION");
    
    // Check patient exists
    const [patient]: any = await db.query(
      "SELECT PatientID, Name FROM Patient WHERE PatientID = ?",
      [patientId]
    );
    
    if (patient.length === 0) {
      await db.query("ROLLBACK");
      return res.status(404).json({ 
        success: false,
        error: "Patient not found" 
      });
    }
    
    // Generate queue number using YYMMDD format
    const now = new Date(appointmentDateTime);
    const year = now.getFullYear().toString().slice(-2);
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const dateStr = `${year}${month}${day}`;
    
    // Get max appointment number for that date
    const appointmentDate = new Date(appointmentDateTime).toISOString().split('T')[0];
    const [maxAppointment]: any = await db.query(`
      SELECT 
        CASE 
          WHEN QueueNumber LIKE 'Q-${dateStr}-%' 
          THEN MAX(CAST(SUBSTRING_INDEX(QueueNumber, '-', -1) AS UNSIGNED))
          ELSE 0
        END as maxNumber
      FROM appointment 
      WHERE DATE(AppointmentDateTime) = ?
    `, [appointmentDate]);
    
    const lastNumber = maxAppointment[0].maxNumber || 0;
    const count = lastNumber + 1;
    const queueNumber = `Q-${dateStr}-${count.toString().padStart(3, '0')}`;
    
    // Insert appointment
    const [appointment]: any = await db.query(`
      INSERT INTO appointment 
      (AppointmentDateTime, Purpose, Status, PatientID, DoctorID, 
       CreatedBy, QueueNumber, Notes)
      VALUES (?, ?, 'scheduled', ?, ?, ?, ?, ?)
    `, [
      appointmentDateTime, 
      purpose, 
      patientId, 
      doctorId, 
      createdBy, 
      queueNumber,
      notes || ''
    ]);
    
    const appointmentId = appointment.insertId;
    
    // Also create a patient_visit record for the appointment
    await db.query(`
      INSERT INTO patient_visit 
      (AppointmentID, PatientID, DoctorID, VisitType, 
       VisitStatus, QueueStatus, QueueNumber, TriagePriority)
      VALUES (?, ?, ?, 'follow-up', 'scheduled', 'waiting', ?, 'low')
    `, [appointmentId, patientId, doctorId, queueNumber]);
    
    await db.query("COMMIT");
    
    res.json({ 
      success: true,
      message: "Appointment scheduled successfully",
      appointmentId,
      queueNumber,
      patientName: patient[0].Name
    });
    
  } catch (error: any) {
    await db.query("ROLLBACK");
    console.error("Schedule appointment error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to schedule appointment"
    });
  }
};

export const getAppointments = async (req: Request, res: Response) => {
  try {
    const [appointments]: any = await db.query(`
      SELECT 
        a.AppointmentID as id,
        a.AppointmentDateTime,
        p.Name as patientName,
        p.PatientID,
        u.Name as doctorName,
        dp.Specialization,
        a.Purpose,
        a.Status,
        a.QueueNumber,
        a.Notes,
        DATE_FORMAT(a.AppointmentDateTime, '%Y-%m-%d') as date,
        DATE_FORMAT(a.AppointmentDateTime, '%h:%i %p') as time,
        pv.VisitStatus as visitStatus
      FROM appointment a
      JOIN Patient p ON a.PatientID = p.PatientID
      JOIN useraccount u ON a.DoctorID = u.UserID
      LEFT JOIN doctorprofile dp ON u.UserID = dp.DoctorID
      LEFT JOIN patient_visit pv ON a.AppointmentID = pv.AppointmentID
      WHERE a.AppointmentDateTime >= CURDATE()
      ORDER BY a.AppointmentDateTime ASC
    `);
    
    res.json(appointments);
  } catch (error) {
    console.error("Appointments error:", error);
    res.status(500).json({ error: "Server error" });
  }
};


// ============ WAITING LIST / CHECK-IN ============
export const getTodayVisits = async (req: Request, res: Response) => {
  try {
    const [visits]: any = await db.query(`
      SELECT 
        pv.VisitID,
        pv.QueueNumber,
        pv.QueuePosition,
        pv.VisitStatus,
        pv.QueueStatus,
        pv.ArrivalTime,
        pv.CheckInTime,
        pv.VisitNotes,
        p.Name as patientName,
        p.PhoneNumber,
        u.Name as doctorName,
        pv.DoctorID,
        pv.PatientID,
        pv.VisitType,
        pv.TriagePriority,
        CASE 
          WHEN pv.VisitType = 'walk-in' THEN 'Walk-in'
          WHEN pv.VisitType = 'first-time' THEN 'First Visit'
          WHEN pv.VisitType = 'follow-up' THEN 'Follow-up'
          ELSE pv.VisitType
        END as visitTypeLabel
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      LEFT JOIN useraccount u ON pv.DoctorID = u.UserID
      WHERE DATE(pv.ArrivalTime) = CURDATE()
        AND pv.QueueStatus NOT IN ('cancelled')
        AND pv.VisitStatus NOT IN ('cancelled', 'no-show')
      ORDER BY 
        CASE pv.QueueStatus 
          WHEN 'in-progress' THEN 1 
          WHEN 'waiting' THEN 2 
          ELSE 3
        END,
        CASE pv.TriagePriority
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
          ELSE 5
        END,
        pv.QueuePosition,
        pv.ArrivalTime
    `);
    
    res.json(visits);
  } catch (error) {
    console.error("Fetch today visits error:", error);
    res.status(500).json({ error: "Failed to fetch today's visits" });
  }
};

export const checkInPatient = async (req: Request, res: Response) => {
  const { appointmentId } = req.body;
  
  try {
    const [appointment]: any = await db.query(`
      SELECT a.*, pv.VisitID 
      FROM appointment a
      LEFT JOIN patient_visit pv ON a.AppointmentID = pv.AppointmentID
      WHERE a.AppointmentID = ?
    `, [appointmentId]);
    
    if (appointment.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: "Appointment not found" 
      });
    }
    
    await db.query("START TRANSACTION");
    
    // Update appointment status
    await db.query(`
      UPDATE appointment 
      SET Status = 'confirmed'
      WHERE AppointmentID = ?
    `, [appointmentId]);
    
    // Update or create visit record
    const appt = appointment[0];
    if (appt.VisitID) {
      // Update existing visit
      await db.query(`
        UPDATE patient_visit 
        SET 
          CheckInTime = NOW(),
          VisitStatus = 'checked-in',
          QueueStatus = 'waiting'
        WHERE VisitID = ?
      `, [appt.VisitID]);
    } else {
      // Create new visit record
      const now = new Date();
      const year = now.getFullYear().toString().slice(-2);
      const month = (now.getMonth() + 1).toString().padStart(2, '0');
      const day = now.getDate().toString().padStart(2, '0');
      const dateStr = `${year}${month}${day}`;
      
      // Get queue position
      const [maxPosition]: any = await db.query(
        'SELECT MAX(QueuePosition) as maxPos FROM patient_visit WHERE DATE(ArrivalTime) = CURDATE()',
        []
      );
      const queuePosition = (maxPosition[0].maxPos || 0) + 1;
      
      await db.query(`
        INSERT INTO patient_visit 
        (AppointmentID, PatientID, DoctorID, VisitType, ArrivalTime, 
         CheckInTime, VisitStatus, QueueStatus, QueueNumber, QueuePosition, TriagePriority)
        VALUES (?, ?, ?, 'follow-up', NOW(), NOW(), 'checked-in', 'waiting', ?, ?, 'low')
      `, [appointmentId, appt.PatientID, appt.DoctorID, appt.QueueNumber, queuePosition]);
    }
    
    await db.query("COMMIT");
    
    res.json({
      success: true,
      message: "Patient checked in successfully"
    });
    
  } catch (error: any) {
    await db.query("ROLLBACK");
    console.error("Check-in error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to check in patient"
    });
  }
};

export const updateVisitStatus = async (req: Request, res: Response) => {
  const { visitId, status } = req.body;
  
  try {
    // Update both VisitStatus and QueueStatus based on the new status
    let visitStatus = status;
    let queueStatus = 'waiting';
    
    switch (status) {
      case 'checked-in':
        queueStatus = 'waiting';
        break;
      case 'in-consultation':
        queueStatus = 'in-progress';
        break;
      case 'completed':
        queueStatus = 'completed';
        // Also set checkout time
        await db.query(`
          UPDATE patient_visit 
          SET CheckOutTime = NOW()
          WHERE VisitID = ?
        `, [visitId]);
        break;
    }
    
    await db.query(`
      UPDATE patient_visit 
      SET VisitStatus = ?, QueueStatus = ?
      WHERE VisitID = ?
    `, [visitStatus, queueStatus, visitId]);
    
    res.json({
      success: true,
      message: `Visit status updated to ${status}`
    });
    
  } catch (error: any) {
    console.error("Update visit status error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to update visit status"
    });
  }
};

// ============ BILLING MANAGEMENT ============
export const getBillingRecords = async (req: Request, res: Response) => {
  try {
    const [billing]: any = await db.query(`
      SELECT 
        b.BillID as id,
        p.Name as patient,
        u.Name as doctor,
        'Consultation' as service,
        b.TotalAmount as amount,
        b.Status as status,
        DATE(b.BillingDate) as date,
        b.AmountPaid,
        b.PatientResponsibility
      FROM billing b
      JOIN Patient p ON b.PatientID = p.PatientID
      JOIN useraccount u ON b.HandledBy = u.UserID
      WHERE b.Status != 'cancelled'
      ORDER BY b.BillingDate DESC
      LIMIT 10
    `);
    
    res.json(billing);
  } catch (error) {
    console.error("Billing records error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const processPayment = async (req: Request, res: Response) => {
  const { 
    billId, 
    amountPaid, 
    paymentMethod, 
    notes, 
    processedBy 
  } = req.body;
  
  try {
    await db.query("START TRANSACTION");
    
    const [billing]: any = await db.query(`
      SELECT TotalAmount, AmountPaid FROM billing WHERE BillID = ?
    `, [billId]);
    
    if (billing.length === 0) {
      await db.query("ROLLBACK");
      return res.status(404).json({ 
        success: false,
        error: "Bill not found" 
      });
    }
    
    const totalAmount = parseFloat(billing[0].TotalAmount);
    const currentPaid = parseFloat(billing[0].AmountPaid || 0);
    const newPaid = currentPaid + parseFloat(amountPaid);
    
    // Determine new status
    let newStatus = 'pending';
    if (newPaid >= totalAmount) {
      newStatus = 'paid';
    } else if (newPaid > 0) {
      newStatus = 'partial';
    }
    
    // Update billing
    await db.query(`
      UPDATE billing 
      SET Status = ?, AmountPaid = ?, PaymentDate = CURDATE()
      WHERE BillID = ?
    `, [newStatus, newPaid, billId]);
    
    // Create payment record
    await db.query(`
      INSERT INTO payment 
      (BillID, AmountPaid, PaymentMethod, PaymentDate, ProcessedBy, Notes)
      VALUES (?, ?, ?, CURDATE(), ?, ?)
    `, [billId, amountPaid, paymentMethod, processedBy, notes]);
    
    await db.query("COMMIT");
    
    res.json({ 
      success: true,
      message: "Payment processed successfully",
      newStatus,
      amountPaid: newPaid
    });
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Payment processing error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to process payment" 
    });
  }
};

// ============ DOCTOR MANAGEMENT ============
export const getDoctors = async (req: Request, res: Response) => {
  try {
    const [doctors]: any = await db.query(`
      SELECT 
        u.UserID as id, 
        u.Name, 
        dp.Specialization,
        dp.ClinicRoom
      FROM useraccount u
      LEFT JOIN doctorprofile dp ON u.UserID = dp.DoctorID
      WHERE u.Role = 'doctor' AND u.Status = 'Active'
      ORDER BY u.Name
    `);
    
    res.json(doctors);
  } catch (error) {
    console.error("Doctors error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// ============ DASHBOARD & PROFILE ============
export const getReceptionistProfile = async (req: Request, res: Response) => {
  const { receptionistId } = req.params;
  
  try {
    const [receptionist]: any = await db.query(`
      SELECT UserID as userId, Name, Email, PhoneNum as phone, Role, Status
      FROM useraccount 
      WHERE UserID = ? AND Role = 'receptionist'
    `, [receptionistId]);
    
    if (receptionist.length === 0) {
      return res.status(404).json({ error: "Receptionist not found" });
    }
    
    res.json(receptionist[0]);
  } catch (error) {
    console.error("Receptionist profile error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const getDashboardStats = async (req: Request, res: Response) => {
  try {
    const [todayAppointments]: any = await db.query(`
      SELECT 
        COUNT(*) as count,
        SUM(CASE WHEN Status = 'scheduled' THEN 1 ELSE 0 END) as scheduled,
        SUM(CASE WHEN Status = 'confirmed' THEN 1 ELSE 0 END) as confirmed
      FROM appointment 
      WHERE DATE(AppointmentDateTime) = CURDATE()
    `);
    
    const [todayVisits]: any = await db.query(`
      SELECT 
        COUNT(*) as count,
        SUM(CASE WHEN VisitStatus = 'checked-in' THEN 1 ELSE 0 END) as checkedIn,
        SUM(CASE WHEN VisitStatus = 'in-consultation' THEN 1 ELSE 0 END) as inConsultation
      FROM patient_visit 
      WHERE DATE(ArrivalTime) = CURDATE()
        AND VisitStatus NOT IN ('cancelled', 'no-show')
    `);
    
    const [waitingPatients]: any = await db.query(`
      SELECT COUNT(*) as count FROM patient_visit 
      WHERE DATE(ArrivalTime) = CURDATE() 
        AND QueueStatus = 'waiting'
        AND VisitStatus = 'checked-in'
    `);
    
    const [pendingPayments]: any = await db.query(`
      SELECT COUNT(*) as count FROM billing 
      WHERE Status IN ('pending', 'partial')
        AND BillingDate = CURDATE()
    `);
    
    res.json({
      success: true,
      stats: {
        todayAppointments: todayAppointments[0].count,
        scheduledAppointments: todayAppointments[0].scheduled,
        confirmedAppointments: todayAppointments[0].confirmed,
        todayVisits: todayVisits[0].count,
        checkedInPatients: todayVisits[0].checkedIn,
        inConsultationPatients: todayVisits[0].inConsultation,
        waitingPatients: waitingPatients[0].count,
        pendingPayments: pendingPayments[0].count
      }
    });
  } catch (error) {
    console.error("Dashboard stats error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to load dashboard stats" 
    });
  }
};

// receptionistController.ts
export const goToBilling = async (req: Request, res: Response) => {
  const { visitId } = req.body;

  if (!visitId) {
    return res.status(400).json({ 
      success: false,
      error: "Missing visitId" 
    });
  }

  try {
    await db.query('START TRANSACTION');
    
    // Update VisitStatus to something like 'payment-processing' or keep as 'to-be-billed'
    const [result]: any = await db.query(`
      UPDATE patient_visit 
      SET 
        VisitStatus = 'in-payment',  // You might want to add this to your ENUM
        UpdatedAt = NOW()
      WHERE VisitID = ? 
        AND VisitStatus = 'to-be-billed'
        AND QueueStatus = 'in-progress'
    `, [visitId]);

    if (result.affectedRows === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ 
        success: false,
        error: "Visit not found or not in correct status" 
      });
    }

    await db.query('COMMIT');

    res.json({
      success: true,
      message: "Patient at billing counter",
      visitId: visitId,
      newVisitStatus: 'in-payment'
    });

  } catch (error) {
    await db.query('ROLLBACK');
    console.error("Go to billing error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to update billing status"
    });
  }
};

// ============ BILLING MANAGEMENT ============

// Get all billing records
export const getAllBilling = async (req: Request, res: Response) => {
  try {
    const [billing]: any = await db.query(`
      SELECT 
        b.*,
        p.Name AS PatientName
      FROM billing b
      JOIN patient p ON b.PatientID = p.PatientID
      ORDER BY b.BillingDate DESC, b.BillID DESC
    `);
    
    res.json(billing);
  } catch (error) {
    console.error('Billing records error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch billing records',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

// Get billing items for a specific bill
export const getBillingItems = async (req: Request, res: Response) => {
  const { billId } = req.params;
  
  try {
    const [items]: any = await db.query(`
      SELECT 
        bi.*,
        s.ServiceName
      FROM billingitem bi
      LEFT JOIN service s ON bi.ServiceID = s.ServiceID
      WHERE bi.BillID = ?
      ORDER BY bi.BillingItemID
    `, [billId]);
    
    res.json(items);
  } catch (error) {
    console.error('Billing items error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch billing items',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

// Create billing record
export const createBilling = async (req: Request, res: Response) => {
  const {
    PatientID,
    AppointmentID,
    ConsultationID,
    TotalAmount,
    AmountDue,
    AmountPaid,
    InsuranceCoverage,
    PatientResponsibility,
    BillingDate,
    DueDate,
    Status,
    HandledBy,
    items
  } = req.body;

  // Validate required fields
  if (!PatientID || !HandledBy || !items || items.length === 0) {
    return res.status(400).json({ 
      error: 'PatientID, HandledBy, and at least one service item are required' 
    });
  }

  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // Insert billing record
    const billingQuery = `
      INSERT INTO billing (
        PatientID, AppointmentID, ConsultationID, TotalAmount,
        AmountDue, AmountPaid, InsuranceCoverage, PatientResponsibility,
        BillingDate, DueDate, Status, HandledBy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const [billingResult]: any = await connection.execute(billingQuery, [
      PatientID,
      AppointmentID || null,
      ConsultationID || null,
      TotalAmount,
      AmountDue,
      AmountPaid || 0,
      InsuranceCoverage || 0,
      PatientResponsibility,
      BillingDate,
      DueDate,
      Status || 'pending',
      HandledBy
    ]);

    const billId = billingResult.insertId;

    // Insert billing items
    const itemQuery = `
      INSERT INTO billingitem (
        BillID, ServiceID, Quantity, UnitPrice, TotalAmount, Description
      ) VALUES (?, ?, ?, ?, ?, ?)
    `;

    for (const item of items) {
      await connection.execute(itemQuery, [
        billId,
        item.ServiceID,
        item.Quantity || 1,
        item.UnitPrice,
        item.TotalAmount,
        item.Description || `${item.ServiceName} (${item.Quantity || 1})`
      ]);
    }

    await connection.commit();
    
    res.json({ 
      success: true, 
      billId,
      message: 'Billing record created successfully' 
    });
  } catch (error) {
    await connection.rollback();
    console.error('Create billing error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to create billing record',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  } finally {
    connection.release();
  }
};

// // Update visit status
// export const updateVisitStatus = async (req: Request, res: Response) => {
//   const { VisitID, VisitStatus } = req.body;

//   if (!VisitID || !VisitStatus) {
//     return res.status(400).json({ 
//       error: 'VisitID and VisitStatus are required' 
//     });
//   }

//   try {
//     const [result]: any = await db.execute(
//       `UPDATE patient_visit 
//        SET VisitStatus = ?, UpdatedAt = NOW()
//        WHERE VisitID = ?`,
//       [VisitStatus, VisitID]
//     );
    
//     if (result.affectedRows === 0) {
//       return res.status(404).json({ error: 'Visit not found' });
//     }

//     res.json({ 
//       success: true, 
//       message: 'Visit status updated successfully' 
//     });
//   } catch (error) {
//     console.error('Update visit status error:', error);
//     res.status(500).json({ 
//       error: 'Failed to update visit status',
//       details: error instanceof Error ? error.message : 'Unknown error'
//     });
//   }
// };

// // Process payment
// export const processPayment = async (req: Request, res: Response) => {
//   const {
//     BillID,
//     AmountPaid,
//     PaymentMethod,
//     PaymentDate,
//     TransactionID,
//     ProcessedBy,
//     Notes
//   } = req.body;

//   // Validate required fields
//   if (!BillID || !AmountPaid || !PaymentMethod || !ProcessedBy) {
//     return res.status(400).json({ 
//       error: 'BillID, AmountPaid, PaymentMethod, and ProcessedBy are required' 
//     });
//   }

//   const connection = await db.getConnection();
  
//   try {
//     await connection.beginTransaction();

//     // Get current billing info
//     const [billing]: any = await connection.query(
//       'SELECT AmountDue, AmountPaid, Status FROM billing WHERE BillID = ?',
//       [BillID]
//     );

//     if (billing.length === 0) {
//       await connection.rollback();
//       return res.status(404).json({ error: 'Billing record not found' });
//     }

//     const currentBill = billing[0];
//     const newAmountPaid = currentBill.AmountPaid + AmountPaid;
//     const newAmountDue = currentBill.AmountDue - AmountPaid;
    
//     // Determine new status
//     let newStatus = currentBill.Status;
//     if (newAmountDue <= 0) {
//       newStatus = 'paid';
//     } else if (newAmountPaid > 0 && newAmountDue > 0) {
//       newStatus = 'partial';
//     }

//     // Update billing record
//     const updateBillingQuery = `
//       UPDATE billing 
//       SET 
//         AmountPaid = ?,
//         AmountDue = ?,
//         Status = ?,
//         PaymentMethod = ?,
//         PaymentDate = ?
//       WHERE BillID = ?
//     `;

//     await connection.execute(updateBillingQuery, [
//       newAmountPaid,
//       newAmountDue,
//       newStatus,
//       PaymentMethod,
//       PaymentDate,
//       BillID
//     ]);

//     // Create payment record
//     const paymentQuery = `
//       INSERT INTO payment (
//         BillID, AmountPaid, PaymentMethod, PaymentDate,
//         TransactionID, ProcessedBy, Notes
//       ) VALUES (?, ?, ?, ?, ?, ?, ?)
//     `;

//     await connection.execute(paymentQuery, [
//       BillID,
//       AmountPaid,
//       PaymentMethod,
//       PaymentDate,
//       TransactionID || `TRX-${Date.now()}`,
//       ProcessedBy,
//       Notes || null
//     ]);

//     await connection.commit();
    
//     res.json({ 
//       success: true, 
//       message: 'Payment processed successfully',
//       newStatus,
//       newAmountDue
//     });
//   } catch (error) {
//     await connection.rollback();
//     console.error('Process payment error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to process payment',
//       details: error instanceof Error ? error.message : 'Unknown error'
//     });
//   } finally {
//     connection.release();
//   }
// };

// Get all services
export const getServices = async (req: Request, res: Response) => {
  try {
    const [services]: any = await db.query(`
      SELECT * FROM service 
      WHERE IsActive = 1
      ORDER BY ServiceName
    `);
    
    res.json(services);
  } catch (error) {
    console.error('Services error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch services',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

// receptionistController.ts
export const processPaymentForBilling = async (req: Request, res: Response) => {
  const {
    billId,
    amountPaid,
    paymentMethod,
    receptionistId,
    notes = ''
  } = req.body;

  if (!billId || !amountPaid || !paymentMethod || !receptionistId) {
    return res.status(400).json({
      error: "Missing required fields: billId, amountPaid, paymentMethod, receptionistId"
    });
  }

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    // 1. Get billing details
    const [billing]: any = await connection.query(`
      SELECT 
        b.*, 
        p.Name AS PatientName,
        p.ICNo,
        c.ConsultationID,
        c.VisitID
      FROM billing b
      JOIN patient p ON b.PatientID = p.PatientID
      LEFT JOIN consultation c ON b.ConsultationID = c.ConsultationID
      WHERE b.BillID = ?
    `, [billId]);

    if (billing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: "Billing record not found" });
    }

    const billingData = billing[0];

    // 2. Validate payment amount
    if (amountPaid <= 0) {
      await connection.rollback();
      return res.status(400).json({ error: "Payment amount must be greater than 0" });
    }

    if (amountPaid > billingData.AmountDue) {
      await connection.rollback();
      return res.status(400).json({ 
        error: "Payment amount exceeds balance due",
        maxAmount: billingData.AmountDue
      });
    }

    // 3. Update billing with payment
    const newAmountPaid = billingData.AmountPaid + amountPaid;
    const newAmountDue = billingData.AmountDue - amountPaid;
    
    let newStatus = billingData.Status;
    if (newAmountDue <= 0) {
      newStatus = 'paid';
    } else if (amountPaid > 0 && amountPaid < billingData.AmountDue) {
      newStatus = 'partial';
    }

    await connection.query(`
      UPDATE billing 
      SET 
        AmountPaid = ?,
        AmountDue = ?,
        Status = ?,
        PaymentMethod = ?,
        PaymentDate = NOW(),
        UpdatedAt = NOW()
      WHERE BillID = ?
    `, [newAmountPaid, newAmountDue, newStatus, paymentMethod, billId]);

    // 4. Create payment record
    const transactionId = `PAY-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    
    await connection.query(`
      INSERT INTO payment (
        BillID, AmountPaid, PaymentMethod, PaymentDate,
        TransactionID, ProcessedBy, Notes
      ) VALUES (?, ?, ?, NOW(), ?, ?, ?)
    `, [billId, amountPaid, paymentMethod, transactionId, receptionistId, notes]);

    // 5. If fully paid, update prescription items status to 'ready' for dispensing
    if (newStatus === 'paid') {
      // Get prescription items for this consultation
      await connection.query(`
        UPDATE prescriptionitem pi
        JOIN prescription p ON pi.PrescriptionID = p.PrescriptionID
        SET pi.Status = 'ready',
            pi.StatusUpdatedAt = NOW(),
            pi.StatusUpdatedBy = ?
        WHERE p.ConsultationID = ?
          AND pi.Status = 'pending'
      `, [receptionistId, billingData.ConsultationID]);
      
      // Update consultation status
      await connection.query(`
        UPDATE consultation 
        SET TreatmentPlan = CONCAT(
          IFNULL(TreatmentPlan, ''),
          '\n\n## Payment Received\n',
          '- Date: ', DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'), '\n',
          '- Amount: $', ?, '\n',
          '- Method: ', ?
        )
        WHERE ConsultationID = ?
      `, [amountPaid, paymentMethod, billingData.ConsultationID]);
    }

    // 6. Update drug inventory when payment is completed (not for partial payments)
    if (newStatus === 'paid') {
      // Deduct from inventory for paid prescriptions
      await connection.query(`
        UPDATE drug d
        JOIN prescriptionitem pi ON d.DrugID = pi.DrugID
        JOIN prescription p ON pi.PrescriptionID = p.PrescriptionID
        SET d.QuantityInStock = d.QuantityInStock - pi.Quantity,
            d.LastUpdated = NOW()
        WHERE p.ConsultationID = ?
          AND d.QuantityInStock >= pi.Quantity
      `, [billingData.ConsultationID]);

      // Log inventory changes
      await connection.query(`
        INSERT INTO inventorylog (Action, QuantityChange, Timestamp, DrugID, PerformedBy)
        SELECT 
          'payment-dispensed',
          -pi.Quantity,
          NOW(),
          pi.DrugID,
          ?
        FROM prescriptionitem pi
        JOIN prescription p ON pi.PrescriptionID = p.PrescriptionID
        WHERE p.ConsultationID = ?
      `, [receptionistId, billingData.ConsultationID]);
    }

    await connection.commit();

    res.json({
      success: true,
      message: `Payment processed successfully. Status: ${newStatus}`,
      paymentDetails: {
        billId,
        transactionId,
        amountPaid,
        previousBalance: billingData.AmountDue,
        newBalance: newAmountDue,
        status: newStatus,
        paymentMethod,
        processedBy: receptionistId,
        timestamp: new Date().toISOString()
      },
      receiptInfo: {
        patientName: billingData.PatientName,
        patientIC: billingData.ICNo,
        billId: billingData.BillID,
        totalAmount: billingData.TotalAmount,
        insuranceCoverage: billingData.InsuranceCoverage,
        amountPaid: newAmountPaid,
        balance: newAmountDue
      }
    });

  } catch (error) {
    await connection.rollback();
    console.error("Process payment error:", error);
    res.status(500).json({ 
      error: "Failed to process payment",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    connection.release();
  }
};

// Updated endpoint: Get patients to bill (simplified)
export const getPatientsToBill = async (req: Request, res: Response) => {
  try {
    const [patients]: any = await db.query(`
      SELECT 
        pv.VisitID,
        pv.PatientID,
        p.Name AS PatientName,
        p.ICNo,
        pv.VisitType,
        pv.VisitStatus,
        pv.ArrivalTime,
        c.ConsultationID,
        u.Name AS DoctorName,
        d.Specialization,
        pv.VisitNotes,
        -- Check if billing already exists
        (SELECT COUNT(*) FROM billing b 
         WHERE b.ConsultationID = c.ConsultationID) AS HasBilling
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      JOIN consultation c ON pv.VisitID = c.VisitID
      JOIN useraccount u ON c.DoctorID = u.UserID
      JOIN doctorprofile d ON c.DoctorID = d.DoctorID
      WHERE pv.VisitStatus = 'to-be-billed'
        AND c.EndTime IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM billing b 
          WHERE b.ConsultationID = c.ConsultationID 
        )
      ORDER BY pv.ArrivalTime DESC
    `);
    
    res.json(patients);
  } catch (error) {
    console.error('Patients to bill error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch patients to bill',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

export const createBillingFromPatient = async (req: Request, res: Response) => {
  const {
    consultationId,
    patientId,
    receptionistId,
    insuranceCoverage = 0
  } = req.body;

  try {
    // 1. Get consultation details with prescription info
    const [consultationDetails]: any = await db.query(`
      SELECT 
        c.*,
        pv.VisitID,
        pv.PatientID,
        u.Name AS DoctorName,
        d.Specialization,
        -- Get prescription total
        COALESCE((
          SELECT SUM(pi.Quantity * drg.UnitPrice)
          FROM prescription pr
          JOIN prescriptionitem pi ON pr.PrescriptionID = pi.PrescriptionID
          JOIN drug drg ON pi.DrugID = drg.DrugID
          WHERE pr.ConsultationID = c.ConsultationID
        ), 0) AS PrescriptionTotal
      FROM consultation c
      JOIN patient_visit pv ON c.VisitID = pv.VisitID
      JOIN useraccount u ON c.DoctorID = u.UserID
      JOIN doctorprofile d ON c.DoctorID = d.DoctorID
      WHERE c.ConsultationID = ? AND pv.PatientID = ?
    `, [consultationId, patientId]);

    if (consultationDetails.length === 0) {
      return res.status(404).json({ error: "Consultation not found" });
    }

    const consultation = consultationDetails[0];
    
    // 2. Calculate totals
    const consultationFee = 150.00;
    const prescriptionTotal = parseFloat(consultation.PrescriptionTotal) || 0;
    const subtotal = consultationFee + prescriptionTotal;
    const patientResponsibility = subtotal - insuranceCoverage;

    // 3. Check if billing already exists
    const [existingBilling]: any = await db.query(`
      SELECT BillID, Status FROM billing 
      WHERE ConsultationID = ? AND PatientID = ?
    `, [consultationId, patientId]);

    if (existingBilling.length > 0) {
      return res.status(400).json({
        error: "Billing already exists for this consultation",
        billId: existingBilling[0].BillID,
        status: existingBilling[0].Status
      });
    }

    // 4. Create billing record
    const [billingResult]: any = await db.query(`
      INSERT INTO billing (
        PatientID, ConsultationID, TotalAmount, AmountDue, AmountPaid,
        InsuranceCoverage, PatientResponsibility, BillingDate, DueDate,
        Status, HandledBy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE(), 
                DATE_ADD(CURDATE(), INTERVAL 30 DAY), 'pending', ?)
    `, [
      patientId,
      consultationId,
      subtotal,
      patientResponsibility,
      0,
      insuranceCoverage,
      patientResponsibility,
      receptionistId
    ]);

    const billId = billingResult.insertId;

    // 5. Create billing items
    // Consultation fee
    await db.query(`
      INSERT INTO billingitem (BillID, ServiceID, Quantity, UnitPrice, TotalAmount, Description)
      VALUES (?, 1, 1, ?, ?, ?)
    `, [billId, consultationFee, consultationFee, `Consultation Fee`]);

    // Prescription items
    const [prescriptionItems]: any = await db.query(`
      SELECT 
        pi.*,
        drg.DrugName,
        drg.UnitPrice,
        (pi.Quantity * drg.UnitPrice) AS ItemTotal
      FROM prescription pr
      JOIN prescriptionitem pi ON pr.PrescriptionID = pi.PrescriptionID
      JOIN drug drg ON pi.DrugID = drg.DrugID
      WHERE pr.ConsultationID = ?
    `, [consultationId]);

    for (const item of prescriptionItems) {
      await db.query(`
        INSERT INTO billingitem (BillID, ServiceID, Quantity, UnitPrice, TotalAmount, Description)
        VALUES (?, NULL, ?, ?, ?, ?)
      `, [
        billId,
        item.Quantity,
        item.UnitPrice,
        item.ItemTotal,
        `${item.DrugName} - ${item.Dosage || 'As prescribed'}`
      ]);
    }

    // 6. Update visit status
    await db.query(`
      UPDATE patient_visit 
      SET VisitStatus = 'to-be-billed', UpdatedAt = NOW()
      WHERE VisitID = ?
    `, [consultation.VisitID]);

    res.json({
      success: true,
      billId,
      message: "Billing created successfully",
      summary: {
        consultationFee: consultationFee,
        prescriptionTotal: prescriptionTotal,
        subtotal: subtotal,
        insuranceCoverage: insuranceCoverage,
        patientResponsibility: patientResponsibility,
        itemsCount: 1 + prescriptionItems.length, // Consultation + medications
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      }
    });

  } catch (error) {
    console.error("Create billing error:", error);
    res.status(500).json({ 
      error: "Failed to create billing",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// controllers/receptionistController.ts
export const getPatientBillDetails = async (req: Request, res: Response) => {
  try {
    const { consultationId } = req.params;
    
    // Get consultation details
    const [consultationDetails]: any = await db.query(`
      SELECT 
        c.ConsultationID,
        c.VisitID,
        c.DoctorID,
        c.StartTime,
        c.EndTime,
        c.Diagnosis,
        c.DiagnosisCode,
        pv.PatientID,
        p.Name AS PatientName,
        p.ICNo,
        p.InsuranceProvider,
        p.InsurancePolicyNo,
        u.Name AS DoctorName,
        dp.Specialization,
        pv.VisitType,
        pv.ArrivalTime,
        pv.VisitStatus,
        (SELECT COUNT(*) FROM billing b 
         WHERE b.ConsultationID = c.ConsultationID) AS HasBilling
      FROM consultation c
      JOIN patient_visit pv ON c.VisitID = pv.VisitID
      JOIN patient p ON pv.PatientID = p.PatientID
      JOIN useraccount u ON c.DoctorID = u.UserID
      LEFT JOIN doctorprofile dp ON c.DoctorID = dp.DoctorID
      WHERE c.ConsultationID = ?
    `, [consultationId]);
    
    if (!consultationDetails || consultationDetails.length === 0) {
      return res.status(404).json({ error: 'Consultation not found' });
    }
    
    const result = consultationDetails[0];
    
    // Get prescription details if exists
    const [prescriptionDetails]: any = await db.query(`
      SELECT 
        pr.PrescriptionID,
        COUNT(pi.ItemID) AS ItemCount,
        GROUP_CONCAT(d.DrugName SEPARATOR ', ') AS Medications
      FROM prescription pr
      LEFT JOIN prescriptionitem pi ON pr.PrescriptionID = pi.PrescriptionID
      LEFT JOIN drug d ON pi.DrugID = d.DrugID
      WHERE pr.ConsultationID = ?
      GROUP BY pr.PrescriptionID
    `, [consultationId]);
    
    // Get consultation fee
    const [consultationService]: any = await db.query(`
      SELECT StandardFee FROM service 
      WHERE ServiceName LIKE '%Consultation%' 
      ORDER BY StandardFee DESC LIMIT 1
    `);
    
    const consultationFee = consultationService && consultationService.length > 0 
      ? parseFloat(consultationService[0].StandardFee) 
      : 150.00;
    
    // Calculate medication cost
    const medicationCost = 0; // Default to 0, can be calculated if needed
    
    const subtotal = consultationFee + medicationCost;
    const insuranceCoverage = 0;
    const patientResponsibility = subtotal - insuranceCoverage;
    
    res.json({
      consultation: result,
      prescription: prescriptionDetails && prescriptionDetails.length > 0 ? prescriptionDetails[0] : null,
      billSummary: {
        consultationFee,
        medicationCost,
        subtotal,
        insuranceCoverage,
        patientResponsibility
      }
    });
    
  } catch (error) {
    console.error('Bill details error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch bill details',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

export const createBillingForConsultation = async (req: Request, res: Response) => {
  console.log('=== START createBillingForConsultation ===');
  console.log('Request body:', req.body);
  
  try {
    const { 
      consultationId, 
      patientId,
      receptionistId, 
      insuranceCoverage = 0, 
      consultationFee = 150, 
      medicationTotal = 0,
      paymentMethod = 'cash'
    } = req.body;
    
    console.log(`Processing consultation: ${consultationId}, patient: ${patientId}`);
    
    if (!consultationId || !patientId || !receptionistId) {
      console.error('Missing required fields');
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Check if billing already exists
    const [existingBilling] = await db.query<RowDataPacket[]>(
      'SELECT BillID FROM billing WHERE ConsultationID = ?',
      [consultationId]
    );
    
    if (existingBilling && existingBilling.length > 0) {
      console.log(`Billing already exists for consultation ${consultationId}`);
      return res.status(400).json({ 
        error: 'Billing already exists for this consultation',
        billId: existingBilling[0].BillID
      });
    }
    
    // Check consultation exists and get VisitID
    console.log(`Checking consultation ${consultationId}...`);
    const [consultationCheck] = await db.query<RowDataPacket[]>(
      'SELECT VisitID, DoctorID FROM consultation WHERE ConsultationID = ?',
      [consultationId]
    );
    
    if (!consultationCheck || consultationCheck.length === 0) {
      console.error(`CONSULTATION NOT FOUND: No consultation with ID ${consultationId}`);
      return res.status(404).json({ error: `Consultation ${consultationId} not found` });
    }
    
    const visitId = consultationCheck[0].VisitID;
    const doctorId = consultationCheck[0].DoctorID;
    
    console.log(`Consultation found. VisitID: ${visitId}, DoctorID: ${doctorId}`);
    console.log(`PatientID from request: ${patientId}`);
    
    // Try to find an appointment for this consultation
    let appointmentId: number | null = null;
    
    try {
      const [appointmentData] = await db.query<RowDataPacket[]>(`
        SELECT pv.AppointmentID 
        FROM patient_visit pv
        WHERE pv.VisitID = ?
      `, [visitId]);
      
      if (appointmentData && appointmentData.length > 0) {
        appointmentId = appointmentData[0].AppointmentID;
        console.log(`Found AppointmentID: ${appointmentId} for VisitID: ${visitId}`);
      } else {
        console.log(`No AppointmentID found for VisitID: ${visitId}`);
      }
    } catch (error) {
      console.log('Error finding appointment:', error);
    }
    
    // Calculate totals
    const totalAmount = parseFloat(consultationFee.toString()) + parseFloat(medicationTotal.toString());
    const insuranceCoverageAmount = parseFloat(insuranceCoverage.toString());
    const patientResponsibility = totalAmount - insuranceCoverageAmount;
    
    // Generate dates
    const billingDate = new Date();
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30);
    
    // Mark as PAID
    const status = 'paid';
    const amountPaid = patientResponsibility;
    
    console.log(`Creating bill. Total: ${totalAmount}, Patient Responsibility: ${patientResponsibility}`);
    
    // Insert into billing table
    const [billingResult] = await db.query<ResultSetHeader>(`
      INSERT INTO billing (
        TotalAmount, 
        AmountDue, 
        AmountPaid, 
        InsuranceCoverage, 
        PatientResponsibility,
        BillingDate, 
        DueDate, 
        Status, 
        PatientID, 
        AppointmentID,
        ConsultationID, 
        HandledBy,
        PaymentMethod,
        PaymentDate
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      totalAmount,
      0,
      amountPaid,
      insuranceCoverageAmount,
      patientResponsibility,
      billingDate,
      dueDate,
      status,
      patientId,
      appointmentId,
      consultationId,
      receptionistId,
      paymentMethod,
      billingDate
    ]);
    
    const billId = billingResult.insertId;
    console.log(`Bill created with ID: ${billId}`);
    
    // Create payment record if amount paid > 0
    if (amountPaid > 0) {
      await db.query<ResultSetHeader>(`
        INSERT INTO payment (
          BillID,
          AmountPaid,
          PaymentMethod,
          PaymentDate,
          ProcessedBy,
          TransactionID,
          Notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        billId,
        amountPaid,
        paymentMethod,
        billingDate,
        receptionistId,
        `PAY-${billId}-${Date.now()}`,
        `Payment received for consultation #${consultationId}`
      ]);
      console.log(`Payment record created for bill ${billId}`);
    }
    
    // DEBUG: Check current visit status BEFORE update
    const [visitCheckBefore] = await db.query<RowDataPacket[]>(
      'SELECT VisitID, VisitStatus, QueueStatus, PatientID FROM patient_visit WHERE VisitID = ?',
      [visitId]
    );
    
    if (!visitCheckBefore || visitCheckBefore.length === 0) {
      console.error(`VISIT NOT FOUND: No patient_visit with VisitID ${visitId}`);
    } else {
      console.log(`Before update - VisitID: ${visitCheckBefore[0].VisitID}, ` +
                  `VisitStatus: ${visitCheckBefore[0].VisitStatus}, ` +
                  `QueueStatus: ${visitCheckBefore[0].QueueStatus}, ` +
                  `PatientID: ${visitCheckBefore[0].PatientID}`);
    }
    
    // Update patient visit status AND queue status
    console.log(`Updating patient_visit: VisitStatus to 'completed', QueueStatus to 'completed' for VisitID: ${visitId}`);
    
    try {
      const [updateResult] = await db.query<ResultSetHeader>(
        `UPDATE patient_visit 
         SET VisitStatus = 'completed',
             QueueStatus = 'completed',
             UpdatedAt = NOW()
         WHERE VisitID = ?`,
        [visitId]
      );
      
      console.log(`Update result: ${updateResult.affectedRows} row(s) affected`);
      
      if (updateResult.affectedRows === 0) {
        console.error(`WARNING: No rows updated for VisitID ${visitId}`);
        
        // Check what status values are allowed
        const [visitStatusInfo] = await db.query<RowDataPacket[]>(`
          SHOW COLUMNS FROM patient_visit WHERE Field = 'VisitStatus'
        `);
        console.log('VisitStatus allowed values:', visitStatusInfo[0]?.Type);
        
        const [queueStatusInfo] = await db.query<RowDataPacket[]>(`
          SHOW COLUMNS FROM patient_visit WHERE Field = 'QueueStatus'
        `);
        console.log('QueueStatus allowed values:', queueStatusInfo[0]?.Type);
      }
      
    } catch (updateError) {
      console.error('ERROR updating patient_visit:', updateError);
    }
    
    // DEBUG: Verify the update
    const [verifyUpdate] = await db.query<RowDataPacket[]>(
      'SELECT VisitStatus, QueueStatus FROM patient_visit WHERE VisitID = ?',
      [visitId]
    );
    
    if (verifyUpdate && verifyUpdate.length > 0) {
      console.log(`VERIFIED: ` +
                  `New VisitStatus is: ${verifyUpdate[0].VisitStatus}, ` +
                  `New QueueStatus is: ${verifyUpdate[0].QueueStatus}`);
    }
    
    console.log('=== END createBillingForConsultation ===');
    
    res.json({
      success: true,
      billId: billId,
      status: status,
      visitId: visitId,
      appointmentId: appointmentId,
      visitStatusUpdated: verifyUpdate?.[0]?.VisitStatus === 'completed',
      queueStatusUpdated: verifyUpdate?.[0]?.QueueStatus === 'completed',
      message: `Bill created, visit marked as completed, and queue status updated successfully`
    });
    
  } catch (error) {
    console.error('=== ERROR in createBillingForConsultation ===');
    console.error('Full error:', error);
    console.error('=== END ERROR ===');
    
    const err = error as any;
    if (err.errno === 1054) {
      return res.status(500).json({ 
        error: 'Database column error',
        details: err.sqlMessage,
        suggestion: 'Check if QueueStatus column exists in patient_visit table'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to create billing',
      details: error instanceof Error ? error.message : 'Unknown error',
      code: err.code || 'UNKNOWN_ERROR'
    });
  }
};

export const getConsultationDetails = async (req: Request, res: Response) => {
  try {
    const { consultationId } = req.params;
    
    if (!consultationId || isNaN(Number(consultationId))) {
      return res.status(400).json({ error: 'Valid consultation ID is required' });
    }

    const query = `
      SELECT 
        c.*,
        CONCAT(u.Name, ' (', dp.Specialization, ')') as DoctorName,
        u.Name as DoctorFullName,
        dp.Specialization
      FROM consultation c
      LEFT JOIN useraccount u ON c.DoctorID = u.UserID
      LEFT JOIN doctorprofile dp ON c.DoctorID = dp.DoctorID
      WHERE c.ConsultationID = ?
    `;
    
    // Cast the result as any first, then access the array
    const result = await db.execute(query, [consultationId]) as any;
    const rows = result[0]; // First element is the rows array
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Consultation not found' });
    }
    
    const consultation = rows[0];
    if (consultation.PhysicalExamFindings && typeof consultation.PhysicalExamFindings === 'string') {
      try {
        consultation.PhysicalExamFindings = JSON.parse(consultation.PhysicalExamFindings);
      } catch (e) {
        console.warn('Failed to parse PhysicalExamFindings JSON:', e);
      }
    }
    
    res.json(consultation);
  } catch (error) {
    console.error('Error fetching consultation details:', error);
    res.status(500).json({ error: 'Failed to fetch consultation details' });
  }
};

export const getPrescriptionDetails = async (req: Request, res: Response) => {
  try {
    const { consultationId } = req.params;
    
    const query = `
      SELECT 
        p.PrescriptionID as prescriptionId,
        COUNT(pi.ItemID) as itemCount,
        GROUP_CONCAT(d.DrugName SEPARATOR ', ') as medications
      FROM prescription p
      LEFT JOIN prescriptionitem pi ON p.PrescriptionID = pi.PrescriptionID
      LEFT JOIN drug d ON pi.DrugID = d.DrugID
      WHERE p.ConsultationID = ?
      GROUP BY p.PrescriptionID
    `;
    
    const [rows] = await db.execute(query, [consultationId]) as [any[], any];
    
    if (rows.length === 0) {
      return res.json(null); // Return null if no prescription
    }
    
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching prescription details:', error);
    res.status(500).json({ error: 'Failed to fetch prescription details' });
  }
};

export const getMedicationCost = async (req: Request, res: Response) => {
  try {
    const { consultationId } = req.params;
    
    const query = `
      SELECT 
        SUM(d.UnitPrice * pi.Quantity) as totalCost
      FROM prescription p
      JOIN prescriptionitem pi ON p.PrescriptionID = pi.PrescriptionID
      JOIN drug d ON pi.DrugID = d.DrugID
      WHERE p.ConsultationID = ?
    `;
    
    const [rows] = await db.execute(query, [consultationId]) as [any[], any];
    
    res.json({ totalCost: rows[0]?.totalCost || 0 });
  } catch (error) {
    console.error('Error fetching medication cost:', error);
    res.status(500).json({ error: 'Failed to fetch medication cost' });
  }
};

export const getPatientBillingInfo = async (req: Request, res: Response) => {
  try {
    const { patientId, consultationId } = req.params;
    
    // Check if billing already exists for this consultation
    const billingQuery = `
      SELECT COUNT(*) as hasBilling
      FROM billing
      WHERE PatientID = ? AND ConsultationID = ?
    `;
    
    const [billingRows] = await db.execute(billingQuery, [patientId, consultationId]) as [any[], any];
    
    // Get patient insurance info
    const patientQuery = `
      SELECT InsuranceProvider, InsurancePolicyNo, InsuranceName
      FROM patient
      WHERE PatientID = ?
    `;
    
    const [patientRows] = await db.execute(patientQuery, [patientId]) as [any[], any];
    
    res.json({
      hasBilling: billingRows[0]?.hasBilling || 0,
      insuranceInfo: patientRows[0] || null
    });
  } catch (error) {
    console.error('Error fetching patient billing info:', error);
    res.status(500).json({ error: 'Failed to fetch patient billing info' });
  }
};

// In your backend (Node.js/Express example)
  export const medicationItems = async (req: Request, res: Response) => {
  try {
    const { consultationId } = req.params;
    
    const query = `
      SELECT 
        pm.PrescriptionMedicationID as medicationId,
        m.MedicationName as medicationName,
        pm.Dosage,
        pm.Quantity,
        m.UnitPrice,
        (pm.Quantity * m.UnitPrice) as totalCost
      FROM PrescriptionMedications pm
      JOIN Medications m ON pm.MedicationID = m.MedicationID
      JOIN Prescriptions p ON pm.PrescriptionID = p.PrescriptionID
      WHERE p.ConsultationID = ?
    `;
    
    const [medicationItems] = await db.execute(query, [consultationId]);
    
    res.json(medicationItems);
  } catch (error) {
    console.error('Error fetching medication items:', error);
    res.status(500).json({ error: 'Failed to fetch medication items' });
  }
};

// backend/controllers/receptionistController.ts
export const sendAppointmentReminder = async (req: Request, res: Response) => {
  try {
    const { 
      appointmentId, 
      patientAccountId, 
      patientName, 
      appointmentDateTime,
      doctorName,
      method, 
      message,
      receptionistId 
    } = req.body;

    if (!appointmentId || !patientAccountId || !patientName || !method) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Create notification title based on method
    const title = `Appointment Reminder - ${method.toUpperCase()}`;
    
    // Format the notification message
    const formattedMessage = message || 
      `Reminder: You have an appointment with Dr. ${doctorName} on ` +
      `${new Date(appointmentDateTime).toLocaleDateString()} at ` +
      `${new Date(appointmentDateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

    // Insert into notification table
    const [notificationResult] = await db.query<ResultSetHeader>(`
      INSERT INTO notification (
        Title,
        Message,
        Type,
        Status,
        CreatedAt,
        PatientAccountID
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
      title,
      formattedMessage,
      'appointment_reminder',
      'sent',
      new Date(),
      patientAccountId
    ]);

    const notificationId = notificationResult.insertId;

    res.json({
      success: true,
      notificationId: notificationId,
      message: 'Reminder sent successfully'
    });

  } catch (error) {
    console.error('Send reminder error:', error);
    res.status(500).json({ 
      error: 'Failed to send reminder',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

export const getUpcomingAppointments = async (req: Request, res: Response) => {
  try {
    // Get the query parameter to filter by patient account status
    const { hasAccount } = req.query;
    
    let query = `
      SELECT 
        a.AppointmentID,
        a.AppointmentDateTime,
        a.Purpose,
        a.Status,
        a.QueueNumber,
        p.PatientID,
        p.Name as PatientName,
        p.Email as PatientEmail,
        p.PhoneNumber as PatientPhone,
        pa.PatientAccountID,
        d.Specialization as DoctorSpecialization,
        u.Name as DoctorName
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      LEFT JOIN patientaccount pa ON p.PatientID = pa.PatientID
      JOIN doctorprofile d ON a.DoctorID = d.DoctorID
      JOIN useraccount u ON d.DoctorID = u.UserID
      WHERE a.Status = 'scheduled' 
        AND a.AppointmentDateTime BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 48 HOUR)
        AND a.AppointmentDateTime > NOW()
    `;
    
    // Apply filter based on query parameter - ONLY if provided
    if (hasAccount === 'true') {
      query += ` AND pa.PatientAccountID IS NOT NULL`;
    } else if (hasAccount === 'false') {
      query += ` AND pa.PatientAccountID IS NULL`;
    }
    // If hasAccount is undefined, don't apply any filter
    
    query += ` ORDER BY a.AppointmentDateTime ASC`;
    
    const [appointments] = await db.query<RowDataPacket[]>(query);

    res.json(appointments);
  } catch (error) {
    console.error('Get appointments error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch appointments',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

// backend/controllers/receptionistController.ts

// Get patient by IC number for account creation
export const getPatientByICForAccount = async (req: Request, res: Response) => {
  try {
    const { icNumber } = req.params;
    
    if (!icNumber) {
      return res.status(400).json({ error: 'IC number is required' });
    }

    const [patientData] = await db.query<RowDataPacket[]>(`
      SELECT 
        p.PatientID,
        p.Name,
        p.ICNo,
        p.Gender,
        p.DOB,
        p.PhoneNumber,
        p.Email,
        p.Address,
        p.BloodType,
        p.InsuranceProvider,
        CASE WHEN pa.PatientAccountID IS NOT NULL THEN 1 ELSE 0 END as HasAccount,
        pa.PatientAccountID
      FROM patient p
      LEFT JOIN patientaccount pa ON p.PatientID = pa.PatientID
      WHERE p.ICNo = ?
    `, [icNumber]);

    if (!patientData || patientData.length === 0) {
      return res.status(404).json({ 
        error: 'Patient not found',
        suggestion: 'Please register the patient first in the patient registration system'
      });
    }

    const patient = patientData[0];
    
    res.json({
      patient: {
        id: patient.PatientID,
        name: patient.Name,
        icNumber: patient.ICNo,
        gender: patient.Gender,
        dob: patient.DOB,
        phone: patient.PhoneNumber,
        email: patient.Email,
        address: patient.Address,
        bloodType: patient.BloodType,
        insurance: patient.InsuranceProvider,
        hasAccount: patient.HasAccount === 1
      },
      existingAccountId: patient.PatientAccountID
    });

  } catch (error) {
    console.error('Get patient by IC error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch patient information',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

// Create patient account
export const createPatientAccount = async (req: Request, res: Response) => {
  try {
    const { 
      icNumber,
      email,
      phone,
      password,
      receptionistId 
    } = req.body;

    // Validation
    if (!icNumber || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if patient exists
    const [patientData] = await db.query<RowDataPacket[]>(
      'SELECT PatientID, Name, Email, PhoneNumber FROM patient WHERE ICNo = ?',
      [icNumber]
    );

    if (!patientData || patientData.length === 0) {
      return res.status(404).json({ 
        error: 'Patient not found',
        suggestion: 'Please register the patient first in the patient registration system'
      });
    }

    const patient = patientData[0];

    // Check if account already exists
    const [existingAccount] = await db.query<RowDataPacket[]>(
      'SELECT PatientAccountID FROM patientaccount WHERE ICNumber = ? OR Email = ?',
      [icNumber, email]
    );

    if (existingAccount && existingAccount.length > 0) {
      return res.status(400).json({ 
        error: 'Account already exists',
        code: 'ACCOUNT_EXISTS',
        suggestion: 'This IC number or email is already registered for a patient account'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create patient account
    const [accountResult] = await db.query<ResultSetHeader>(`
      INSERT INTO patientaccount (
        PatientID,
        Name,
        Email,
        Phone,
        PasswordHash,
        ICNumber,
        CreatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      patient.PatientID,
      patient.Name,
      email,
      phone,
      hashedPassword,
      icNumber,
      new Date()
    ]);

    const accountId = accountResult.insertId;

    // Create welcome notification
    await db.query<ResultSetHeader>(`
      INSERT INTO notification (
        Title,
        Message,
        Type,
        Status,
        CreatedAt,
        PatientAccountID
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
      'Welcome to Smart CMS!',
      'Your patient account has been created successfully. You can now access your medical records, appointments, and more.',
      'account_created',
      'unread',
      new Date(),
      accountId
    ]);

    res.json({
      success: true,
      accountId: accountId,
      patientName: patient.Name,
      message: 'Patient account created successfully'
    });

  } catch (error) {
    console.error('Create patient account error:', error);
    
    // Handle duplicate entry error
    if ((error as any).errno === 1062) {
      return res.status(400).json({ 
        error: 'Account already exists',
        details: 'This IC number or email is already registered'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to create patient account',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

// Add to your receptionistController.ts

// Check if account already exists
export const checkPatientAccountExists = async (req: Request, res: Response) => {
  try {
    const { icNumber } = req.params;
    
    const [accountData] = await db.query<RowDataPacket[]>(`
      SELECT pa.PatientAccountID, p.Name 
      FROM patientaccount pa
      JOIN patient p ON pa.PatientID = p.PatientID
      WHERE pa.ICNumber = ? OR p.ICNo = ?
    `, [icNumber, icNumber]);

    res.json({
      hasAccount: accountData && accountData.length > 0,
      accountId: accountData[0]?.PatientAccountID || null,
      patientName: accountData[0]?.Name || null
    });
  } catch (error) {
    console.error('Check account error:', error);
    res.status(500).json({ error: 'Failed to check account' });
  }
};

// Find patient by IC number
export const findPatientByIC = async (req: Request, res: Response) => {
  try {
    const { icNumber } = req.params;
    
    const [patientData] = await db.query<RowDataPacket[]>(`
      SELECT 
        PatientID as id,
        Name as name,
        ICNo as icNumber,
        Gender as gender,
        DOB as dob,
        PhoneNumber as phone,
        Email as email,
        Address as address,
        BloodType as bloodType,
        InsuranceProvider as insurance
      FROM patient 
      WHERE ICNo = ?
    `, [icNumber]);

    if (!patientData || patientData.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    const patient = patientData[0];
    
    res.json({
      patient: {
        id: patient.id,
        name: patient.name,
        icNumber: patient.icNumber,
        gender: patient.gender,
        dob: patient.dob,
        phone: patient.phone,
        email: patient.email,
        address: patient.address,
        bloodType: patient.bloodType,
        insurance: patient.insurance,
        hasAccount: false // We'll check this separately
      }
    });
  } catch (error) {
    console.error('Find patient error:', error);
    res.status(500).json({ error: 'Failed to find patient' });
  }
};

// Backend API routes for appointment cancellation/rescheduling


  export const cancelAppointment = async (req: Request, res: Response) => {
  try {
    const { appointmentId, cancellationReason, cancelledByReceptionistId } = req.body;
    
    // Update appointment status to cancelled
    await db.query(
      'UPDATE Appointments SET Status = "cancelled", CancellationReason = ?, CancelledBy = ?, CancelledAt = NOW() WHERE AppointmentID = ?',
      [cancellationReason, cancelledByReceptionistId, appointmentId]
    );
    
    // Get appointment details for notification
    const [appointment] = await db.query(
      `SELECT a.*, p.Name as PatientName, p.Email as PatientEmail, p.PhoneNumber as PatientPhone,
              d.Name as DoctorName
       FROM Appointments a
       JOIN Patients p ON a.PatientID = p.PatientID
       JOIN Doctors d ON a.DoctorID = d.DoctorID
       WHERE a.AppointmentID = ?`,
      [appointmentId]
    );
    
    // Create notification for patient (if they have an account)
    if (appointment[0]?.PatientAccountID) {
      await db.query(
        `INSERT INTO Notifications (AccountID, Title, Message, Type, CreatedAt) 
         VALUES (?, 'Appointment Cancelled', 
         'Your appointment with Dr. ${appointment[0].DoctorName} on ${new Date(appointment[0].AppointmentDateTime).toLocaleDateString()} has been cancelled. Reason: ${cancellationReason}', 
         'appointment', NOW())`,
        [appointment[0].PatientAccountID]
      );
    }
    
    res.json({ 
      success: true, 
      cancellationRef: `CANCEL-${Date.now()}`,
      appointment: appointment[0]
    });
  } catch (error) {
    console.error('Cancel appointment error:', error);
    res.status(500).json({ error: 'Failed to cancel appointment' });
  }
};

  export const rescheduleAppointment = async (req: Request, res: Response) => {
  try {
    const { appointmentId, newDateTime, rescheduledByReceptionistId } = req.body;
    
    // Get original appointment details
    const [originalAppointment] = await db.query(
      `SELECT * FROM Appointments WHERE AppointmentID = ?`,
      [appointmentId]
    );
    
    // Update appointment with new date/time
    await db.query(
      `UPDATE Appointments 
       SET AppointmentDateTime = ?, 
           PreviousAppointmentDateTime = ?,
           RescheduledBy = ?,
           RescheduledAt = NOW(),
           Status = 'rescheduled'
       WHERE AppointmentID = ?`,
      [newDateTime, originalAppointment[0].AppointmentDateTime, rescheduledByReceptionistId, appointmentId]
    );
    
    // Get updated appointment details for notification
    const [appointment] = await db.query(
      `SELECT a.*, p.Name as PatientName, p.Email as PatientEmail, p.PhoneNumber as PatientPhone,
              d.Name as DoctorName
       FROM Appointments a
       JOIN Patients p ON a.PatientID = p.PatientID
       JOIN Doctors d ON a.DoctorID = d.DoctorID
       WHERE a.AppointmentID = ?`,
      [appointmentId]
    );
    
    // Create notification for patient (if they have an account)
    if (appointment[0]?.PatientAccountID) {
      await db.query(
        `INSERT INTO Notifications (AccountID, Title, Message, Type, CreatedAt) 
         VALUES (?, 'Appointment Rescheduled', 
         'Your appointment with Dr. ${appointment[0].DoctorName} has been rescheduled to ${new Date(newDateTime).toLocaleString()}.', 
         'appointment', NOW())`,
        [appointment[0].PatientAccountID]
      );
    }
    
    res.json({ 
      success: true, 
      appointment: appointment[0]
    });
  } catch (error) {
    console.error('Reschedule appointment error:', error);
    res.status(500).json({ error: 'Failed to reschedule appointment' });
  }
};

// routes/receptionist.js (or similar)
export const callPatientToBilling = async (req: Request, res: Response) => {
  const { visitId } = req.body;

  console.log(`📞 Calling patient to billing for VisitID: ${visitId}`);

  try {
    if (!visitId) {
      return res.status(400).json({
        success: false,
        error: "Visit ID is required"
      });
    }

    // Use type assertion or cast the result
    const result: any = await db.query(
      `UPDATE patient_visit 
       SET QueueStatus = 'in-progress', 
           CalledTime = NOW(),
           UpdatedAt = NOW()
       WHERE VisitID = ? AND VisitStatus = 'to-be-billed'`,
      [visitId]
    );

    // Check if any rows were affected
    const affectedRows = result[0]?.affectedRows || result.affectedRows || 0;

    console.log('Affected rows:', affectedRows);

    if (affectedRows === 0) {
      console.log('No visit found or visit not in correct status');
      return res.status(404).json({
        success: false,
        error: "Visit not found or cannot be called"
      });
    }

    console.log(`✅ Patient called successfully for VisitID: ${visitId}`);

    res.json({
      success: true,
      message: "Patient called to billing successfully",
      visitId: visitId,
      calledTime: new Date().toISOString()
    });

  } catch (error: any) {
    console.error("🔥 Error calling patient:", error);
    console.error("Error message:", error.message);
    
    res.status(500).json({
      success: false,
      error: "Server error while calling patient",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Add this function inside your WaitingList component


