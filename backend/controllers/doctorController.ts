// controllers/doctorController.ts
import { Request, Response } from "express";
import { db } from "../db";
import { autoCreateMedicalHistoryFromConsultation } from './medicalHistoryController';
import { RowDataPacket, OkPacket, ResultSetHeader } from 'mysql2';

// Helper function for auto-billing
const createAutoBill = async (consultationId: number, patientId: number, insuranceProvider: string | null) => {
  try {
    console.log('Creating auto-bill for consultation:', consultationId);
    
    // 1. Get consultation fee (from service table or fixed rate)
    const [serviceFee]: any = await db.query(`
      SELECT ServiceID, StandardFee FROM service 
      WHERE ServiceID = 1 AND IsActive = 1
    `);
    
    const consultationFee = serviceFee.length > 0 ? serviceFee[0].StandardFee : 50.00;
    console.log('Consultation fee:', consultationFee);
    
    // 2. Get prescription medications total
    const [medicationItems]: any = await db.query(`
      SELECT 
        pi.Quantity,
        pi.DrugID,
        d.DrugName,
        d.UnitPrice,
        (pi.Quantity * d.UnitPrice) as TotalPrice
      FROM prescription p
      JOIN prescriptionitem pi ON p.PrescriptionID = pi.PrescriptionID
      JOIN drug d ON pi.DrugID = d.DrugID
      WHERE p.ConsultationID = ?
    `, [consultationId]);
    
    let medicationTotal = 0;
    medicationItems.forEach((item: any) => {
      medicationTotal += parseFloat(item.TotalPrice);
    });
    console.log('Medication total:', medicationTotal);
    
    // 3. Calculate total
    const totalAmount = consultationFee + medicationTotal;
    console.log('Total amount:', totalAmount);
    
    // 4. Calculate insurance coverage (simplified: 80% if has insurance)
    const hasInsurance = insuranceProvider !== null && insuranceProvider.trim() !== '';
    const insuranceCoverage = hasInsurance ? totalAmount * 0.8 : 0;
    const patientResponsibility = totalAmount - insuranceCoverage;
    
    console.log('Insurance:', { hasInsurance, insuranceCoverage, patientResponsibility });
    
    // 5. Create billing record
    const [billingResult]: any = await db.query(`
      INSERT INTO billing (
        PatientID, ConsultationID, AppointmentID,
        TotalAmount, AmountDue, AmountPaid,
        InsuranceCoverage, PatientResponsibility,
        BillingDate, DueDate, Status, HandledBy
      ) VALUES (?, ?, NULL, ?, ?, 0, ?, ?, CURDATE(), 
        DATE_ADD(CURDATE(), INTERVAL 30 DAY), 'pending', NULL)
    `, [
      patientId,
      consultationId,
      totalAmount,
      patientResponsibility,
      insuranceCoverage,
      patientResponsibility
    ]);
    
    const billId = billingResult.insertId;
    console.log('Bill created with ID:', billId);
    
    // 6. Add consultation fee item
    await db.query(`
      INSERT INTO billingitem (
        BillID, ServiceID, Quantity, UnitPrice, TotalAmount, Description
      ) VALUES (?, 1, 1, ?, ?, 'Doctor Consultation Fee')
    `, [billId, consultationFee, consultationFee]);
    console.log('Added consultation fee item');
    
    // 7. Add medication items
    for (const item of medicationItems) {
      await db.query(`
        INSERT INTO billingitem (
          BillID, ServiceID, Quantity, UnitPrice, TotalAmount, Description
        ) VALUES (?, NULL, ?, ?, ?, ?)
      `, [
        billId,
        item.Quantity,
        item.UnitPrice,
        item.TotalPrice,
        `${item.DrugName} - Prescription Medication`
      ]);
    }
    console.log(`Added ${medicationItems.length} medication items`);
    
    return {
      success: true,
      billId,
      totalAmount,
      consultationFee,
      medicationTotal,
      insuranceCoverage,
      patientResponsibility,
      itemsCount: 1 + medicationItems.length
    };
    
  } catch (error: any) {
    console.error("Auto-billing error:", error);
    return { 
      success: false, 
      error: error.message,
      sqlMessage: error.sqlMessage
    };
  }
};

export const getDoctorProfile = async (req: Request, res: Response) => {
  const { doctorId } = req.params;
  
  try {
    const [doctor]: any = await db.query(`
      SELECT u.UserID, u.Name, u.Email, u.PhoneNum, u.Role,
             d.Specialization, d.LicenseNo, d.ClinicRoom
      FROM useraccount u
      LEFT JOIN doctorprofile d ON u.UserID = d.DoctorID
      WHERE u.UserID = ? AND u.Role = 'doctor'
    `, [doctorId]);
    
    if (doctor.length === 0) {
      return res.status(404).json({ error: "Doctor not found" });
    }
    
    res.json(doctor[0]);
  } catch (error) {
    console.error("Doctor profile error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// Get only scheduled appointments (not checked in yet)
export const getScheduledAppointments = async (req: Request, res: Response) => {
  const { doctorId } = req.params;
  
  try {
    const [appointments]: any = await db.query(`
      SELECT 
        a.AppointmentID as id,
        a.PatientID as patientId,
        p.Name as name, 
        DATE_FORMAT(a.AppointmentDateTime, '%h:%i %p') as time,
        a.Purpose as type,
        a.Status as status,
        a.Notes,
        a.AppointmentDateTime,
        'follow-up' as VisitType,
        'scheduled' as VisitStatus,
        'medium' as TriagePriority
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      WHERE a.DoctorID = ? 
        AND DATE(a.AppointmentDateTime) = CURDATE()
        AND a.Status = 'scheduled'
        AND NOT EXISTS (
          SELECT 1 FROM patient_visit pv 
          WHERE pv.PatientID = a.PatientID 
            AND DATE(pv.ArrivalTime) = CURDATE()
            AND pv.VisitStatus = 'checked-in'
        )
      ORDER BY a.AppointmentDateTime ASC
    `, [doctorId]);
    
    console.log('Scheduled appointments (not checked in):', appointments);
    
    res.json(appointments);
  } catch (error) {
    console.error("Scheduled appointments error:", error);
    res.status(500).json({ error: "Failed to fetch scheduled appointments" });
  }
};

// Get appointment info for a specific patient
export const getPatientAppointment = async (req: Request, res: Response) => {
  const { patientId, doctorId } = req.params;
  
  try {
    const [appointment]: any = await db.query(`
      SELECT 
        a.AppointmentID,
        a.AppointmentDateTime,
        a.Status,
        a.Purpose
      FROM appointment a
      WHERE a.PatientID = ? 
        AND a.DoctorID = ?
        AND DATE(a.AppointmentDateTime) = CURDATE()
        AND a.Status IN ('scheduled', 'confirmed', 'checked-in')
      ORDER BY a.AppointmentDateTime DESC
      LIMIT 1
    `, [patientId, doctorId]);
    
    if (appointment.length > 0) {
      res.json(appointment[0]);
    } else {
      res.json(null);
    }
  } catch (error) {
    console.error("Patient appointment error:", error);
    res.json(null);
  }
};

// Enhanced queue endpoint with proper doctor assignment checks
export const getEnhancedPatientQueue = async (req: Request, res: Response) => {
  const { doctorId } = req.params;
  
  try {
    // Get patients assigned to THIS SPECIFIC doctor
    const [assignedPatients]: any = await db.query(`
      SELECT 
        pv.VisitID,
        pv.PatientID,
        p.Name as PatientName,
        pv.QueueNumber,
        pv.QueuePosition,
        pv.QueueStatus,
        pv.VisitStatus,
        pv.VisitType,
        pv.VisitNotes,
        pv.ArrivalTime,
        pv.CalledTime,
        pv.DoctorID,
        pv.TriagePriority,
        'assigned' as queueType,
        u.Name as assignedDoctorName,
        a.AppointmentDateTime
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      LEFT JOIN useraccount u ON pv.DoctorID = u.UserID
      LEFT JOIN appointment a ON pv.AppointmentID = a.AppointmentID
      WHERE pv.DoctorID = ? 
        AND DATE(pv.ArrivalTime) = CURDATE()
        AND pv.VisitStatus IN ('scheduled', 'checked-in', 'in-consultation')
        AND pv.QueueStatus NOT IN ('completed', 'cancelled')
      ORDER BY 
        CASE pv.TriagePriority
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
          ELSE 5
        END,
        pv.QueuePosition ASC
    `, [doctorId]);
    
    // Get unassigned patients (no doctor OR different doctor)
    const [unassignedPatients]: any = await db.query(`
      SELECT 
        pv.VisitID,
        pv.PatientID,
        p.Name as PatientName,
        pv.QueueNumber,
        pv.QueuePosition,
        pv.QueueStatus,
        pv.VisitStatus,
        pv.VisitType,
        pv.VisitNotes,
        pv.ArrivalTime,
        pv.CalledTime,
        pv.DoctorID,
        pv.TriagePriority,
        'unassigned' as queueType,
        u.Name as assignedDoctorName,
        a.AppointmentDateTime
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      LEFT JOIN useraccount u ON pv.DoctorID = u.UserID
      LEFT JOIN appointment a ON pv.AppointmentID = a.AppointmentID
      WHERE (pv.DoctorID IS NULL OR pv.DoctorID != ?)
        AND DATE(pv.ArrivalTime) = CURDATE()
        AND pv.VisitStatus IN ('scheduled', 'checked-in', 'in-consultation')
        AND pv.QueueStatus NOT IN ('completed', 'cancelled')
      ORDER BY 
        CASE pv.TriagePriority
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
          ELSE 5
        END,
        pv.QueuePosition ASC
    `, [doctorId]);
    
    console.log('Enhanced queue debug:', {
      doctorId,
      assignedCount: assignedPatients.length,
      unassignedCount: unassignedPatients.length,
      assignedDoctors: assignedPatients.map((p: any) => ({ 
        id: p.VisitID, 
        doctorId: p.DoctorID, 
        doctorName: p.assignedDoctorName 
      })),
      unassignedDoctors: unassignedPatients.map((p: any) => ({ 
        id: p.VisitID, 
        doctorId: p.DoctorID, 
        doctorName: p.assignedDoctorName 
      }))
    });
    
    res.json({
      success: true,
      assignedPatients,
      unassignedPatients,
      totalAssigned: assignedPatients.length,
      totalUnassigned: unassignedPatients.length
    });
    
  } catch (error) {
    console.error("Enhanced queue error:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error" 
    });
  }
};

/**
 * Get patients currently in consultation with this doctor
 */
export const getCalledPatients = async (req: Request, res: Response) => {
  const { doctorId } = req.params;
  
  try {
    const [calledPatients]: any = await db.query(`
      SELECT 
        pv.VisitID as id,
        pv.PatientID as patientId,
        p.Name as name,
        TIMESTAMPDIFF(YEAR, p.DOB, CURDATE()) as age,
        p.Gender as gender,
        pv.ArrivalTime as time,
        pv.VisitStatus as status,
        pv.VisitType as type,
        pv.QueueNumber,
        c.ChiefComplaint as chiefComplaint,
        pv.DoctorID,
        CASE 
          WHEN pv.AppointmentID IS NOT NULL THEN 'appointment'
          ELSE 'walk-in'
        END as sourceType,
        pv.CalledTime
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      LEFT JOIN consultation c ON pv.VisitID = c.VisitID
      WHERE pv.DoctorID = ?
        AND pv.QueueStatus = 'in-progress'
        AND pv.VisitStatus = 'in-consultation'
        AND DATE(pv.ArrivalTime) = CURDATE()
      ORDER BY pv.CalledTime ASC
    `, [doctorId]);
    
    console.log('Called patients for doctor', doctorId, ':', calledPatients.length);
    
    res.json(calledPatients);
  } catch (error) {
    console.error("Called patients error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// Fix the getTodayAppointments function
export const getTodayAppointments = async (req: Request, res: Response) => {
  const { doctorId } = req.params;
  
  try {
    const [appointments]: any = await db.query(`
      SELECT 
        a.AppointmentID as id,
        a.PatientID as patientId,
        p.Name as name, 
        DATE_FORMAT(a.AppointmentDateTime, '%h:%i %p') as time,
        a.Purpose as type,
        a.Status as status,
        a.Notes,
        'follow-up' as VisitType,  -- Default for appointments
        NULL as QueueNumber,  -- Appointments don't have queue numbers yet
        NULL as QueuePosition,
        'medium' as TriagePriority,  -- Default priority for appointments
        a.AppointmentDateTime
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      WHERE a.DoctorID = ? 
        AND DATE(a.AppointmentDateTime) = CURDATE()
        AND a.Status IN ('scheduled', 'confirmed', 'checked-in')
      ORDER BY a.AppointmentDateTime ASC
    `, [doctorId]);
    
    console.log('Appointments API Response:', appointments);
    
    res.json(appointments);
  } catch (error) {
    console.error("Appointments error:", error);
    res.status(500).json({ error: "Server error" });
  }
};


// Alternative: Get appointments that have corresponding patient_visit entries
export const getTodayAppointmentsWithVisits = async (req: Request, res: Response) => {
  const { doctorId } = req.params;
  
  try {
    const [appointments]: any = await db.query(`
      SELECT 
        pv.VisitID as id,
        pv.PatientID as patientId,
        p.Name as name, 
        DATE_FORMAT(a.AppointmentDateTime, '%h:%i %p') as time,
        a.Purpose as type,
        pv.VisitStatus as status,
        pv.VisitType,
        pv.QueueNumber,
        pv.QueuePosition,
        pv.TriagePriority,
        pv.VisitNotes,
        a.AppointmentDateTime
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      LEFT JOIN patient_visit pv ON a.PatientID = pv.PatientID 
        AND DATE(pv.ArrivalTime) = CURDATE()
        AND pv.DoctorID = a.DoctorID
      WHERE a.DoctorID = ? 
        AND DATE(a.AppointmentDateTime) = CURDATE()
        AND a.Status IN ('scheduled', 'confirmed', 'checked-in')
      ORDER BY a.AppointmentDateTime ASC
    `, [doctorId]);
    
    console.log('Appointments with visits:', appointments);
    
    res.json(appointments);
  } catch (error) {
    console.error("Appointments error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// If you want to show only scheduled appointments that haven't checked in yet:
export const getTodayScheduledAppointments = async (req: Request, res: Response) => {
  const { doctorId } = req.params;
  
  try {
    const [appointments]: any = await db.query(`
      SELECT 
        a.AppointmentID as id,
        a.PatientID as patientId,
        p.Name as name, 
        DATE_FORMAT(a.AppointmentDateTime, '%h:%i %p') as time,
        a.Purpose as type,
        a.Status as status,
        a.Notes,
        'follow-up' as VisitType,
        NULL as QueueNumber,
        NULL as QueuePosition,
        'medium' as TriagePriority,
        a.AppointmentDateTime
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      LEFT JOIN patient_visit pv ON a.PatientID = pv.PatientID 
        AND DATE(pv.ArrivalTime) = CURDATE()
        AND pv.DoctorID = a.DoctorID
        AND pv.VisitStatus NOT IN ('completed', 'cancelled')
      WHERE a.DoctorID = ? 
        AND DATE(a.AppointmentDateTime) = CURDATE()
        AND a.Status IN ('scheduled')  -- Only scheduled appointments
        AND pv.VisitID IS NULL  -- No patient_visit created yet (not checked in)
      ORDER BY a.AppointmentDateTime ASC
    `, [doctorId]);
    
    console.log('Scheduled appointments (not checked in):', appointments);
    
    res.json(appointments);
  } catch (error) {
    console.error("Scheduled appointments error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// Get ALL patients in queue - both assigned to this doctor and unassigned
export const getPatientQueue = async (req: Request, res: Response) => {
  const { doctorId } = req.params;
  
  try {
    // Get patients assigned to this doctor - BROADER QUERY
    const [assignedPatients]: any = await db.query(`
      SELECT 
        pv.VisitID,
        pv.PatientID,
        p.Name as PatientName,
        pv.QueueNumber,
        pv.QueuePosition,
        pv.QueueStatus,
        pv.VisitStatus,
        pv.VisitType,
        pv.VisitNotes,
        pv.ArrivalTime,
        pv.CalledTime,
        pv.DoctorID,
        pv.TriagePriority,
        'assigned' as queueType,
        u.Name as assignedDoctorName
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      LEFT JOIN useraccount u ON pv.DoctorID = u.UserID
      WHERE pv.DoctorID = ? 
        AND DATE(pv.ArrivalTime) = CURDATE()
        AND pv.VisitStatus NOT IN ('completed', 'cancelled', 'no-show')
        AND pv.QueueStatus NOT IN ('completed', 'cancelled')
      ORDER BY pv.QueuePosition ASC
    `, [doctorId]);
    
    // Get unassigned patients - BROADER QUERY
    const [unassignedPatients]: any = await db.query(`
      SELECT 
        pv.VisitID,
        pv.PatientID,
        p.Name as PatientName,
        pv.QueueNumber,
        pv.QueuePosition,
        pv.QueueStatus,
        pv.VisitStatus,
        pv.VisitType,
        pv.VisitNotes,
        pv.ArrivalTime,
        pv.CalledTime,
        pv.DoctorID,
        pv.TriagePriority,
        'unassigned' as queueType,
        u.Name as assignedDoctorName
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      LEFT JOIN useraccount u ON pv.DoctorID = u.UserID
      WHERE (pv.DoctorID IS NULL OR pv.DoctorID != ?)
        AND DATE(pv.ArrivalTime) = CURDATE()
        AND pv.VisitStatus NOT IN ('completed', 'cancelled', 'no-show')
        AND pv.QueueStatus NOT IN ('completed', 'cancelled')
      ORDER BY 
        CASE pv.TriagePriority
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
          ELSE 5
        END,
        pv.QueuePosition ASC
    `, [doctorId]);
    
    console.log('Queue debug:', {
      doctorId,
      assignedCount: assignedPatients.length,
      unassignedCount: unassignedPatients.length,
      assignedSample: assignedPatients.slice(0, 2),
      unassignedSample: unassignedPatients.slice(0, 2)
    });
    
    res.json({
      success: true,
      assignedPatients,
      unassignedPatients,
      totalAssigned: assignedPatients.length,
      totalUnassigned: unassignedPatients.length
    });
    
  } catch (error) {
    console.error("Queue error:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error" 
    });
  }
};

// Add this to your doctorController.ts
export const debugPatientQueue = async (req: Request, res: Response) => {
  const { doctorId } = req.params;
  
  try {
    // Get ALL visits for today regardless of status
    const [allVisits]: any = await db.query(`
      SELECT 
        pv.VisitID,
        pv.PatientID,
        p.Name as PatientName,
        pv.QueueNumber,
        pv.QueuePosition,
        pv.QueueStatus,
        pv.VisitStatus,
        pv.VisitType,
        pv.VisitNotes,
        pv.ArrivalTime,
        pv.CalledTime,
        pv.DoctorID,
        pv.TriagePriority,
        u.Name as assignedDoctorName
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      LEFT JOIN useraccount u ON pv.DoctorID = u.UserID
      WHERE DATE(pv.ArrivalTime) = CURDATE()
      ORDER BY pv.ArrivalTime DESC
    `, []);
    
    res.json({
      success: true,
      allVisits,
      count: allVisits.length,
      currentTime: new Date().toISOString(),
      debugInfo: {
        doctorIdRequested: doctorId,
        statusesFound: allVisits.map((v: any) => ({
          VisitID: v.VisitID,
          QueueStatus: v.QueueStatus,
          VisitStatus: v.VisitStatus,
          DoctorID: v.DoctorID,
          PatientName: v.PatientName
        }))
      }
    });
    
  } catch (error) {
    console.error("Debug error:", error);
    res.status(500).json({ 
      success: false,
      error: "Debug error" 
    });
  }
};

// Get patient queue for doctor dashboard (simpler version)
export const getDoctorDashboardQueue = async (req: Request, res: Response) => {
  const { doctorId } = req.params;
  
  try {
    // Get all patients for this doctor (including those already assigned)
    const [queue]: any = await db.query(`
      SELECT 
        pv.VisitID,
        pv.PatientID,
        p.Name as PatientName,
        pv.QueueNumber,
        pv.QueuePosition,
        pv.QueueStatus,
        pv.VisitStatus,
        pv.VisitType,
        pv.VisitNotes,
        pv.ArrivalTime,
        pv.CalledTime,
        pv.DoctorID,
        pv.TriagePriority,
        CASE 
          WHEN pv.DoctorID = ? THEN 'Your Patient'
          WHEN pv.DoctorID IS NULL THEN 'No Doctor Assigned'
          ELSE 'Assigned to Another Doctor'
        END as assignmentStatus,
        u.Name as assignedDoctorName
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      LEFT JOIN useraccount u ON pv.DoctorID = u.UserID
      WHERE DATE(pv.ArrivalTime) = CURDATE()
        AND pv.VisitStatus IN ('checked-in', 'in-consultation')
        AND pv.QueueStatus IN ('waiting', 'in-progress')
        AND (pv.DoctorID IS NULL OR pv.DoctorID = ?)
      ORDER BY 
        pv.DoctorID DESC, -- Show assigned patients first
        CASE pv.TriagePriority
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
          ELSE 5
        END,
        pv.QueuePosition ASC
    `, [doctorId, doctorId]);
    
    res.json({
      success: true,
      queue
    });
    
  } catch (error) {
    console.error("Dashboard queue error:", error);
    res.status(500).json({ 
      success: false,
      error: "Server error" 
    });
  }
};

export const getPatientDetails = async (req: Request, res: Response) => {
  const { patientId } = req.params;
  
  try {
    console.log('Getting patient details for ID:', patientId);
    
    // Get basic patient info
    const [patient]: any = await db.query(`
      SELECT 
        p.PatientID, 
        p.Name, 
        p.Gender,
        p.DOB,
        p.BloodType,
        p.PhoneNumber,
        p.Email,
        p.Address,
        p.ICNo,
        p.InsuranceProvider,
        p.InsurancePolicyNo,
        TIMESTAMPDIFF(YEAR, p.DOB, CURDATE()) as age
      FROM patient p
      WHERE p.PatientID = ?
    `, [patientId]);
    
    console.log('Patient query result:', patient);
    
    if (patient.length === 0) {
      console.log('Patient not found in database');
      return res.status(404).json({ error: "Patient not found" });
    }
    
    const patientData = {
      ...patient[0]
    };
    
    // Try to get allergies (this might fail if table doesn't exist or has no data)
    try {
      const [allergies]: any = await db.query(`
        SELECT AllergyName as allergy, Severity
        FROM patientallergy 
        WHERE PatientID = ?
      `, [patientId]);
      patientData.allergies = allergies;
    } catch (allergyError) {
      console.warn('Could not fetch allergies:', allergyError);
      patientData.allergies = [];
    }
    
    // Try to get current medications
    try {
      const [medications]: any = await db.query(`
        SELECT MedicationName as name, Dosage as dosage, Frequency as frequency, Status
        FROM patientmedication 
        WHERE PatientID = ? AND Status = 'active'
      `, [patientId]);
      patientData.currentMedications = medications;
    } catch (medError) {
      console.warn('Could not fetch medications:', medError);
      patientData.currentMedications = [];
    }
    
    // Try to get medical conditions
    try {
      const [conditions]: any = await db.query(`
        SELECT ConditionName as condition, DiagnosedDate as diagnosed, Status as status
        FROM medicalcondition 
        WHERE PatientID = ?
      `, [patientId]);
      patientData.medicalHistory = conditions;
    } catch (conditionError) {
      console.warn('Could not fetch conditions:', conditionError);
      patientData.medicalHistory = [];
    }
    
    // Try to get recent visits
    try {
      const [visits]: any = await db.query(`
        SELECT 
          pv.VisitID,
          pv.ArrivalTime as VisitDate,
          pv.VisitType,
          pv.VisitNotes,
          pv.VisitStatus,
          u.Name as doctor_name
        FROM patient_visit pv
        LEFT JOIN useraccount u ON pv.DoctorID = u.UserID
        WHERE pv.PatientID = ?
        ORDER BY pv.ArrivalTime DESC
        LIMIT 5
      `, [patientId]);
      patientData.recentVisits = visits;
    } catch (visitError) {
      console.warn('Could not fetch visits:', visitError);
      patientData.recentVisits = [];
    }
    
    console.log('Final patient data to send:', patientData);
    res.json(patientData);
  } catch (error) {
    console.error("Patient details error:", error);
    
    // More detailed error logging
    if (error instanceof Error) {
      console.error('Error name:', error.name);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    
    res.status(500).json({ 
      error: "Server error",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
};

export const saveConsultation = async (req: Request, res: Response) => {
  const { visitId, doctorId, patientId, symptoms, diagnosis, treatmentPlan, notes, followUpInstructions } = req.body;
  
  try {
    await db.query("START TRANSACTION");
    
    // Check if consultation already exists for this visit
    const [existingConsultation]: any = await db.query(`
      SELECT ConsultationID FROM consultation WHERE VisitID = ?
    `, [visitId]);
    
    let consultationId;
    
    if (existingConsultation.length > 0) {
      // Update existing consultation
      consultationId = existingConsultation[0].ConsultationID;
      await db.query(`
        UPDATE consultation 
        SET 
          ChiefComplaint = ?,
          Diagnosis = ?,
          TreatmentPlan = ?,
          ConsultationNotes = ?,
          FollowUpInstructions = ?,
          UpdatedAt = NOW()
        WHERE VisitID = ?
      `, [symptoms, diagnosis, treatmentPlan, notes, followUpInstructions, visitId]);
    } else {
      // Create new consultation record
      const [consultation]: any = await db.query(`
        INSERT INTO consultation 
        (VisitID, DoctorID, ChiefComplaint, Diagnosis, TreatmentPlan, ConsultationNotes, FollowUpInstructions)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [visitId, doctorId, symptoms, diagnosis, treatmentPlan, notes, followUpInstructions]);
      
      consultationId = consultation.insertId;
    }
    
    // Update patient_visit to mark as completed
    await db.query(`
      UPDATE patient_visit 
      SET 
        QueueStatus = 'completed',
        VisitStatus = 'completed',
        CheckOutTime = NOW()
      WHERE VisitID = ?
    `, [visitId]);
    
    // Update appointment status if exists
    await db.query(`
      UPDATE appointment 
      SET Status = 'completed' 
      WHERE AppointmentID IN (
        SELECT AppointmentID FROM patient_visit WHERE VisitID = ?
      )
    `, [visitId]);
    
    await db.query("COMMIT");
    
    res.json({ 
      message: "Consultation saved successfully",
      consultationId: consultationId 
    });
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Consultation save error:", error);
    res.status(500).json({ error: "Failed to save consultation" });
  }
};

// Doctor calls a patient (assigns them to doctor and starts consultation)
export const visitPatient = async (req: Request, res: Response) => {
  const { visitId, doctorId } = req.body;
  
  console.log('=== VISIT PATIENT ENDPOINT HIT ===');
  console.log('Visit ID:', visitId);
  console.log('Doctor ID:', doctorId);
  
  try {
    await db.query('START TRANSACTION');
    
    // 1. FIRST: Check if doctor already has an active consultation
    const [activeConsultations]: any = await db.query(`
      SELECT VisitID, PatientID, QueueStatus, VisitStatus, CalledTime
      FROM patient_visit 
      WHERE DoctorID = ?
        AND QueueStatus = 'in-progress'
        AND VisitStatus = 'in-consultation'
        AND DATE(CalledTime) = CURDATE()
      LIMIT 1
    `, [doctorId]);
    
    if (activeConsultations.length > 0) {
      const activePatient = activeConsultations[0];
      
      // If trying to call the same patient, just return success
      if (activePatient.VisitID === visitId) {
        await db.query('ROLLBACK');
        return res.json({
          success: true,
          message: "Patient is already in consultation",
          patient: activePatient
        });
      }
      
      // If trying to call a different patient, reject
      await db.query('ROLLBACK');
      return res.status(400).json({ 
        success: false,
        error: `You already have an active consultation. Please complete consultation with patient #${activePatient.PatientID} first.`
      });
    }
    
    // 2. Then check if patient already has a doctor assigned
    const [currentVisit]: any = await db.query(`
      SELECT DoctorID, QueueStatus, VisitStatus 
      FROM patient_visit 
      WHERE VisitID = ?
    `, [visitId]);
    
    if (currentVisit.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ 
        success: false,
        error: "Visit not found" 
      });
    }
    
    const currentDoctorId = currentVisit[0].DoctorID;
    const currentQueueStatus = currentVisit[0].QueueStatus;
    const currentVisitStatus = currentVisit[0].VisitStatus;
    
    // Check if patient is already in consultation with another doctor
    if (currentDoctorId && currentDoctorId !== doctorId && 
        (currentQueueStatus === 'in-progress' || currentVisitStatus === 'in-consultation')) {
      await db.query('ROLLBACK');
      return res.status(400).json({ 
        success: false,
        error: "Patient is already in consultation with another doctor" 
      });
    }
    
    // Update patient_visit to mark as in-consultation and assign to this doctor
    const [updateResult]: any = await db.query(`
      UPDATE patient_visit 
      SET 
        QueueStatus = 'in-progress',
        VisitStatus = 'in-consultation',
        CalledTime = NOW(),
        DoctorID = ?
      WHERE VisitID = ? 
        AND QueueStatus = 'waiting'
        AND VisitStatus = 'checked-in'
    `, [doctorId, visitId]);
    
    if (updateResult.affectedRows === 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ 
        success: false,
        error: "Patient not found or not in waiting status" 
      });
    }
    
    // ============================================
    // NEW: Create consultation record
    // ============================================
    console.log('Creating consultation record...');
    const [consultation]: any = await db.query(`
      INSERT INTO consultation 
      (VisitID, DoctorID, StartTime, CreatedAt, UpdatedAt)
      VALUES (?, ?, NOW(), NOW(), NOW())
    `, [visitId, doctorId]);
    
    const consultationId = consultation.insertId;
    console.log('Created consultation with ID:', consultationId);
    
    // If this is from an appointment, update appointment status
    const [visitData]: any = await db.query(`
      SELECT AppointmentID FROM patient_visit WHERE VisitID = ?
    `, [visitId]);
    
    if (visitData[0]?.AppointmentID) {
      await db.query(`
        UPDATE appointment 
        SET Status = 'confirmed' 
        WHERE AppointmentID = ?
      `, [visitData[0].AppointmentID]);
    }
    
    await db.query('COMMIT');
    
    // Get updated patient data
    const [updatedPatient]: any = await db.query(`
      SELECT 
        pv.VisitID,
        pv.PatientID,
        p.Name as PatientName,
        pv.QueueNumber,
        pv.QueuePosition,
        pv.QueueStatus,
        pv.VisitStatus,
        pv.VisitType,
        pv.VisitNotes,
        pv.ArrivalTime,
        pv.CalledTime,
        pv.DoctorID,
        pv.TriagePriority,
        u.Name as assignedDoctorName
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      LEFT JOIN useraccount u ON pv.DoctorID = u.UserID
      WHERE pv.VisitID = ?
    `, [visitId]);
    
    const responseData = {
      success: true,
      message: "Patient called successfully",
      patient: updatedPatient[0],
      consultationId: consultationId  // NEW: Return the consultation ID
    };
    
    console.log('Response data:', responseData);
    
    res.json(responseData);
    
  } catch (error) {
    await db.query('ROLLBACK');
    console.error("Visit patient error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to call patient" 
    });
  }
};

// Add to your doctorController.ts
export const getActiveConsultation = async (req: Request, res: Response) => {
  const { doctorId } = req.params;
  
  try {
    const [activePatient]: any = await db.query(`
      SELECT 
        pv.VisitID,
        pv.PatientID,
        p.Name as PatientName,
        pv.QueueNumber,
        pv.QueuePosition,
        pv.QueueStatus,
        pv.VisitStatus,
        pv.VisitType,
        pv.VisitNotes,
        pv.ArrivalTime,
        pv.CalledTime,
        pv.DoctorID,
        pv.TriagePriority,
        u.Name as assignedDoctorName
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      LEFT JOIN useraccount u ON pv.DoctorID = u.UserID
      WHERE pv.DoctorID = ?
        AND pv.QueueStatus = 'in-progress'
        AND pv.VisitStatus = 'in-consultation'
        AND DATE(pv.CalledTime) = CURDATE()
      LIMIT 1
    `, [doctorId]);
    
    if (activePatient.length > 0) {
      res.json({
        success: true,
        patient: activePatient[0]
      });
    } else {
      res.json({
        success: false,
        message: 'No active consultation'
      });
    }
  } catch (error) {
    console.error('Error fetching active consultation:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch active consultation' 
    });
  }
};

// Doctor claims an unassigned patient
export const claimPatient = async (req: Request, res: Response) => {
  const { visitId, doctorId } = req.body;
  
  try {
    await db.query('START TRANSACTION');
    
    // Check if patient is unassigned or assigned to another doctor
    const [currentVisit]: any = await db.query(`
      SELECT DoctorID, QueueStatus, VisitStatus 
      FROM patient_visit 
      WHERE VisitID = ?
    `, [visitId]);
    
    if (currentVisit.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ 
        success: false,
        error: "Visit not found" 
      });
    }
    
    const currentDoctorId = currentVisit[0].DoctorID;
    
    // If patient already has this doctor, just call them
    if (currentDoctorId === doctorId) {
      await db.query('ROLLBACK');
      // Call the existing visitPatient function
      return visitPatient(req, res);
    }
    
    // If patient has another doctor, cannot claim
    if (currentDoctorId && currentDoctorId !== doctorId) {
      await db.query('ROLLBACK');
      return res.status(400).json({ 
        success: false,
        error: "Patient is already assigned to another doctor" 
      });
    }
    
    // Assign patient to this doctor (but don't start consultation yet)
    const [updateResult]: any = await db.query(`
      UPDATE patient_visit 
      SET 
        DoctorID = ?
      WHERE VisitID = ? 
        AND DoctorID IS NULL
        AND QueueStatus = 'waiting'
        AND VisitStatus = 'checked-in'
    `, [doctorId, visitId]);
    
    if (updateResult.affectedRows === 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ 
        success: false,
        error: "Cannot claim patient. Patient may already have a doctor or is not in waiting status." 
      });
    }
    
    await db.query('COMMIT');
    
    res.json({
      success: true,
      message: "Patient claimed successfully. You can now call them when ready."
    });
    
  } catch (error) {
    await db.query('ROLLBACK');
    console.error("Claim patient error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to claim patient" 
    });
  }
};

export const completeVisit = async (req: Request, res: Response) => {
  const { visitId, doctorId } = req.body;
  
  try {
    await db.query('START TRANSACTION');
    
    // Update patient_visit to mark as completed
    const [updateResult]: any = await db.query(`
      UPDATE patient_visit 
      SET 
        QueueStatus = 'completed',
        VisitStatus = 'completed',
        CheckOutTime = NOW()
      WHERE VisitID = ? AND DoctorID = ?
    `, [visitId, doctorId]);
    
    if (updateResult.affectedRows === 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ 
        success: false,
        error: "Visit not found or not authorized" 
      });
    }
    
    // Update appointment status if exists
    const [visitData]: any = await db.query(`
      SELECT AppointmentID FROM patient_visit WHERE VisitID = ?
    `, [visitId]);
    
    if (visitData[0]?.AppointmentID) {
      await db.query(`
        UPDATE appointment 
        SET Status = 'completed' 
        WHERE AppointmentID = ?
      `, [visitData[0].AppointmentID]);
    }
    
    await db.query('COMMIT');
    
    res.json({
      success: true,
      message: "Visit completed successfully"
    });
    
  } catch (error) {
    await db.query('ROLLBACK');
    console.error("Complete visit error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to complete visit" 
    });
  }
};

export const getQueueStats = async (req: Request, res: Response) => {
  const { doctorId } = req.params;
  
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Count patients seen today by this doctor
    const [seenTodayResult]: any = await db.query(`
      SELECT COUNT(*) as count
      FROM patient_visit 
      WHERE DoctorID = ? 
        AND DATE(ArrivalTime) = ?
        AND VisitStatus = 'completed'
    `, [doctorId, today]);
    
    // Count patients currently waiting for this doctor
    const [waitingResult]: any = await db.query(`
      SELECT COUNT(*) as count
      FROM patient_visit 
      WHERE DoctorID = ? 
        AND DATE(ArrivalTime) = ?
        AND VisitStatus IN ('checked-in', 'in-consultation')
        AND QueueStatus IN ('waiting', 'in-progress')
    `, [doctorId, today]);
    
    res.json({
      success: true,
      patientsSeenToday: seenTodayResult[0]?.count || 0,
      patientsWaiting: waitingResult[0]?.count || 0
    });
    
  } catch (error) {
    console.error("Get queue stats error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to fetch queue statistics" 
    });
  }
};

export const createPrescription = async (req: Request, res: Response) => {
  const { consultationId, doctorId, patientId, medications, remarks } = req.body;
  
  try {
    await db.query("START TRANSACTION");
    
    // Create prescription
    const [prescription]: any = await db.query(`
      INSERT INTO prescription 
      (PrescribedDate, Remarks, DoctorID, PatientID, ConsultationID)
      VALUES (CURDATE(), ?, ?, ?, ?)
    `, [remarks, doctorId, patientId, consultationId]);
    
    // Add prescription items
    for (const med of medications) {
      await db.query(`
        INSERT INTO prescriptionitem 
        (Dosage, Frequency, Duration, PrescriptionID, DrugID)
        VALUES (?, ?, ?, ?, ?)
      `, [med.dosage, med.frequency, med.duration, prescription.insertId, med.drugId]);
    }
    
    // Set prescription status to pending
    await db.query(`
      INSERT INTO prescriptionstatus 
      (PrescriptionID, Status, UpdatedBy)
      VALUES (?, 'pending', ?)
    `, [prescription.insertId, doctorId]);
    
    await db.query("COMMIT");
    
    res.json({ 
      message: "Prescription created successfully",
      prescriptionId: prescription.insertId 
    });
  } catch (error) {
    await db.query("ROLLBACK");
    console.error("Prescription error:", error);
    res.status(500).json({ error: "Failed to create prescription" });
  }
};

// In doctorController.ts, update getRecentPrescriptions:
export const getRecentPrescriptions = async (req: Request, res: Response) => {
  const doctorId = (req as any).user?.userId || req.params.doctorId;
  
  try {
    const [prescriptions]: any = await db.query(`
      SELECT 
        p.PrescriptionID, 
        pat.Name as patientName, 
        d.DrugName as medication, 
        pi.Dosage, 
        pi.Frequency,
        pi.Duration,
        p.PrescribedDate as date,
        pi.Status as prescriptionStatus,
        pi.Quantity,
        d.UnitPrice,
        (pi.Quantity * d.UnitPrice) as totalPrice
      FROM prescription p
      JOIN patient pat ON p.PatientID = pat.PatientID
      JOIN prescriptionitem pi ON p.PrescriptionID = pi.PrescriptionID
      JOIN drug d ON pi.DrugID = d.DrugID
      WHERE p.DoctorID = ?
      ORDER BY p.PrescribedDate DESC
      LIMIT 10
    `, [doctorId]);
    
    res.json(prescriptions);
  } catch (error) {
    console.error("Prescriptions error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

export const scheduleFollowUp = async (req: Request, res: Response) => {
  const { patientId, doctorId, date, time, type, notes, createdBy } = req.body;
  
  try {
    const appointmentDateTime = `${date} ${time}`;
    
    const [appointment]: any = await db.query(`
      INSERT INTO appointment 
      (AppointmentDateTime, Purpose, Status, PatientID, DoctorID, CreatedBy, Notes)
      VALUES (?, ?, 'scheduled', ?, ?, ?, ?)
    `, [appointmentDateTime, type, patientId, doctorId, createdBy, notes]);
    
    res.json({ 
      message: "Follow-up scheduled successfully",
      appointmentId: appointment.insertId 
    });
  } catch (error) {
    console.error("Follow-up error:", error);
    res.status(500).json({ error: "Failed to schedule follow-up" });
  }
};

// Add these new functions to doctorController.ts

// Get patient vital signs
export const getPatientVitals = async (req: Request, res: Response) => {
  const { patientId } = req.params;
  
  try {
    const [vitals]: any = await db.query(`
      SELECT 
        v.VitalSignID,
        v.ConsultationID,
        v.TakenBy,
        v.TakenAt,
        v.BloodPressureSystolic,
        v.BloodPressureDiastolic,
        v.HeartRate,
        v.RespiratoryRate,
        v.Temperature,
        v.OxygenSaturation,
        v.Height,
        v.Weight,
        v.BMI,
        v.PainLevel,
        v.Notes,
        u.Name as TakenByName
      FROM vital_signs v
      LEFT JOIN useraccount u ON v.TakenBy = u.UserID
      WHERE v.ConsultationID IN (
        SELECT c.ConsultationID 
        FROM consultation c
        JOIN patient_visit pv ON c.VisitID = pv.VisitID
        WHERE pv.PatientID = ?
      )
      ORDER BY v.TakenAt DESC
      LIMIT 10
    `, [patientId]);
    
    res.json(vitals);
  } catch (error) {
    console.error("Vitals fetch error:", error);
    res.status(500).json({ error: "Failed to fetch vital signs" });
  }
};

// Create consultation for a patient
export const createConsultation = async (req: Request, res: Response) => {
  const { patientId, doctorId, visitType = 'consultation', symptoms } = req.body;
  
  try {
    await db.query('START TRANSACTION');
    
    // Create patient_visit
    const [visit]: any = await db.query(`
      INSERT INTO patient_visit 
      (PatientID, DoctorID, VisitType, ArrivalTime, CheckInTime, VisitStatus, QueueStatus, VisitNotes)
      VALUES (?, ?, ?, NOW(), NOW(), 'in-consultation', 'in-progress', ?)
    `, [patientId, doctorId, visitType, symptoms || 'New consultation']);
    
    // Create consultation record
    const [consultation]: any = await db.query(`
      INSERT INTO consultation 
      (VisitID, DoctorID, StartTime, ChiefComplaint)
      VALUES (?, ?, NOW(), ?)
    `, [visit.insertId, doctorId, symptoms || '']);
    
    await db.query('COMMIT');
    
    res.json({ 
      success: true,
      message: "Consultation created successfully",
      consultationId: consultation.insertId,
      visitId: visit.insertId
    });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error("Create consultation error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to create consultation" 
    });
  }
};

// Save consultation details
export const saveConsultationDetails = async (req: Request, res: Response) => {
  const { consultationId, chiefComplaint, diagnosis, treatmentPlan, consultationNotes, doctorId } = req.body;
  
  try {
    // Update consultation record
    const [updateResult]: any = await db.query(`
      UPDATE consultation 
      SET 
        ChiefComplaint = ?,
        Diagnosis = ?,
        TreatmentPlan = ?,
        ConsultationNotes = ?,
        EndTime = NOW(),
        UpdatedAt = NOW()
      WHERE ConsultationID = ? AND DoctorID = ?
    `, [chiefComplaint, diagnosis, treatmentPlan, consultationNotes, consultationId, doctorId]);
    
    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ 
        success: false,
        error: "Consultation not found or not authorized" 
      });
    }
    
    // Update patient_visit status
    const [consultationData]: any = await db.query(`
      SELECT VisitID FROM consultation WHERE ConsultationID = ?
    `, [consultationId]);
    
    if (consultationData[0]?.VisitID) {
      await db.query(`
        UPDATE patient_visit 
        SET 
          VisitStatus = 'completed',
          QueueStatus = 'completed',
          CheckOutTime = NOW()
        WHERE VisitID = ?
      `, [consultationData[0].VisitID]);
    }
    
    res.json({ 
      success: true,
      message: "Consultation details saved successfully"
    });
  } catch (error) {
    console.error("Save consultation details error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to save consultation details" 
    });
  }
};

// Create consultation specifically for vital signs
export const createConsultationForVitals = async (req: Request, res: Response) => {
  const { patientId, doctorId, visitType = 'walk-in', notes = 'Vital signs recording' } = req.body;
  
  try {
    await db.query('START TRANSACTION');
    
    // Create patient_visit
    const [visit]: any = await db.query(`
      INSERT INTO patient_visit 
      (PatientID, DoctorID, VisitType, ArrivalTime, CheckInTime, VisitStatus, QueueStatus, VisitNotes)
      VALUES (?, ?, ?, NOW(), NOW(), 'checked-in', 'waiting', ?)
    `, [patientId, doctorId, visitType, notes]);
    
    // Create consultation record
    const [consultation]: any = await db.query(`
      INSERT INTO consultation 
      (VisitID, DoctorID, StartTime, ChiefComplaint)
      VALUES (?, ?, NOW(), ?)
    `, [visit.insertId, doctorId, 'Vital signs recording']);
    
    await db.query('COMMIT');
    
    res.json({ 
      success: true,
      message: "Consultation created for vital signs",
      consultationId: consultation.insertId,
      visitId: visit.insertId
    });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error("Create consultation for vitals error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to create consultation" 
    });
  }
};

// Save vital signs with proper data mapping
export const saveVitalSigns = async (req: Request, res: Response) => {
  const {
    consultationId,
    takenBy,
    bloodPressureSystolic,
    bloodPressureDiastolic,
    heartRate,
    respiratoryRate,
    temperature,
    oxygenSaturation,
    height,
    weight,
    bmi,
    painLevel,
    notes
  } = req.body;
  
  try {
    // Check if consultation exists
    const [consultationCheck]: any = await db.query(`
      SELECT ConsultationID FROM consultation WHERE ConsultationID = ?
    `, [consultationId]);
    
    if (consultationCheck.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: "Consultation not found" 
      });
    }
    
    // Insert vital signs
    const [result]: any = await db.query(`
      INSERT INTO vital_signs 
      (ConsultationID, TakenBy, TakenAt, BloodPressureSystolic, BloodPressureDiastolic, 
       HeartRate, RespiratoryRate, Temperature, OxygenSaturation, Height, Weight, BMI, PainLevel, Notes)
      VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      consultationId,
      takenBy,
      bloodPressureSystolic,
      bloodPressureDiastolic,
      heartRate,
      respiratoryRate,
      temperature,
      oxygenSaturation,
      height,
      weight,
      bmi,
      painLevel,
      notes
    ]);
    
    res.json({ 
      success: true,
      message: "Vital signs saved successfully",
      vitalSignId: result.insertId
    });
  } catch (error) {
    console.error("Save vital signs error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to save vital signs" 
    });
  }
};

// Get active visit for patient
export const getActiveVisit = async (req: Request, res: Response) => {
  const { patientId } = req.params;
  
  try {
    const [activeVisit]: any = await db.query(`
      SELECT 
        pv.VisitID,
        c.ConsultationID
      FROM patient_visit pv
      LEFT JOIN consultation c ON pv.VisitID = c.VisitID
      WHERE pv.PatientID = ? 
        AND DATE(pv.ArrivalTime) = CURDATE()
        AND pv.VisitStatus NOT IN ('completed', 'cancelled', 'no-show')
      ORDER BY pv.ArrivalTime DESC
      LIMIT 1
    `, [patientId]);
    
    res.json(activeVisit[0] || {});
  } catch (error) {
    console.error("Active visit error:", error);
    res.status(500).json({ error: "Failed to get active visit" });
  }
};

// Create visit for vital signs recording
export const createVisitForVitals = async (req: Request, res: Response) => {
  const { patientId, doctorId, visitType = 'walk-in', visitNotes = 'Vital signs recording' } = req.body;
  
  try {
    await db.query('START TRANSACTION');
    
    // Create patient_visit
    const [visit]: any = await db.query(`
      INSERT INTO patient_visit 
      (PatientID, DoctorID, VisitType, ArrivalTime, CheckInTime, VisitStatus, QueueStatus, VisitNotes)
      VALUES (?, ?, ?, NOW(), NOW(), 'checked-in', 'waiting', ?)
    `, [patientId, doctorId, visitType, visitNotes]);
    
    // Create consultation
    const [consultation]: any = await db.query(`
      INSERT INTO consultation (VisitID, DoctorID)
      VALUES (?, ?)
    `, [visit.insertId, doctorId]);
    
    await db.query('COMMIT');
    
    res.json({ 
      success: true,
      message: "Visit created for vital signs recording",
      visitId: visit.insertId,
      consultationId: consultation.insertId
    });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error("Create visit error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to create visit" 
    });
  }
};

// Get patient allergies
export const getPatientAllergies = async (req: Request, res: Response) => {
  const { patientId } = req.params;
  
  try {
    const [allergies]: any = await db.query(`
      SELECT 
        af.AllergyFindingID,
        af.ConsultationID,
        af.AllergyName,
        af.Reaction,
        af.Severity,
        af.OnsetDate,
        af.Status,
        af.Notes,
        DATE_FORMAT(af.OnsetDate, '%Y-%m-%d') as OnsetDate
      FROM allergy_findings af
      JOIN consultation c ON af.ConsultationID = c.ConsultationID
      WHERE c.VisitID IN (
        SELECT VisitID FROM patient_visit WHERE PatientID = ?
      )
      ORDER BY af.OnsetDate DESC
    `, [patientId]);
    
    res.json(allergies);
  } catch (error) {
    console.error("Allergies fetch error:", error);
    res.status(500).json({ error: "Failed to fetch allergies" });
  }
};

// Save allergy finding
export const saveAllergyFinding = async (req: Request, res: Response) => {
  const { patientId, doctorId, allergyName, reaction, severity, onsetDate, status, notes } = req.body;
  
  try {
    // Get active consultation for this patient
    const [activeConsultation]: any = await db.query(`
      SELECT c.ConsultationID 
      FROM consultation c
      JOIN patient_visit pv ON c.VisitID = pv.VisitID
      WHERE pv.PatientID = ? 
        AND DATE(pv.ArrivalTime) = CURDATE()
        AND pv.VisitStatus NOT IN ('completed', 'cancelled')
      ORDER BY pv.ArrivalTime DESC
      LIMIT 1
    `, [patientId]);
    
    if (activeConsultation.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: "No active consultation found. Please start a consultation first." 
      });
    }
    
    const consultationId = activeConsultation[0].ConsultationID;
    
    // Save allergy finding
    const [result]: any = await db.query(`
      INSERT INTO allergy_findings 
      (ConsultationID, AllergyName, Reaction, Severity, OnsetDate, Status, Notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [consultationId, allergyName, reaction, severity, onsetDate, status, notes]);
    
    res.json({ 
      success: true,
      message: "Allergy finding saved successfully",
      allergyFindingId: result.insertId
    });
  } catch (error) {
    console.error("Save allergy error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to save allergy finding" 
    });
  }
};

// Get patient medical conditions
export const getPatientMedicalConditions = async (req: Request, res: Response) => {
  const { patientId } = req.params;
  
  try {
    const [conditions]: any = await db.query(`
      SELECT 
        mc.ConditionID,
        mc.PatientID,
        mc.ConditionName,
        mc.DiagnosedDate,
        mc.Status,
        mc.Notes,
        DATE_FORMAT(mc.DiagnosedDate, '%Y-%m-%d') as DiagnosedDate
      FROM medicalcondition mc
      WHERE mc.PatientID = ?
      ORDER BY mc.DiagnosedDate DESC
    `, [patientId]);
    
    res.json(conditions);
  } catch (error) {
    console.error("Medical conditions fetch error:", error);
    res.status(500).json({ error: "Failed to fetch medical conditions" });
  }
};

// Save medical condition
export const saveMedicalCondition = async (req: Request, res: Response) => {
  const { patientId, conditionName, diagnosedDate, status, notes } = req.body;
  
  try {
    const [result]: any = await db.query(`
      INSERT INTO medicalcondition 
      (PatientID, ConditionName, DiagnosedDate, Status, Notes)
      VALUES (?, ?, ?, ?, ?)
    `, [patientId, conditionName, diagnosedDate, status, notes]);
    
    res.json({ 
      success: true,
      message: "Medical condition saved successfully",
      conditionId: result.insertId
    });
  } catch (error) {
    console.error("Save medical condition error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to save medical condition" 
    });
  }
};

// Get patient visits history
export const getPatientVisits = async (req: Request, res: Response) => {
  const { patientId } = req.params;
  
  try {
    const [visits]: any = await db.query(`
      SELECT 
        pv.VisitID,
        pv.VisitType,
        pv.ArrivalTime,
        pv.VisitStatus,
        pv.VisitNotes,
        u.Name as DoctorName
      FROM patient_visit pv
      LEFT JOIN useraccount u ON pv.DoctorID = u.UserID
      WHERE pv.PatientID = ?
      ORDER BY pv.ArrivalTime DESC
      LIMIT 20
    `, [patientId]);
    
    res.json(visits);
  } catch (error) {
    console.error("Visits fetch error:", error);
    res.status(500).json({ error: "Failed to fetch patient visits" });
  }
};

// Save full consultation with all fields
export const saveConsultationFull = async (req: Request, res: Response) => {
  const {
    patientId,
    doctorId,
    chiefComplaint,
    historyOfPresentIllness,
    physicalExamFindings,
    diagnosis,
    diagnosisCode,
    treatmentPlan,
    consultationNotes,
    followUpInstructions,
    followUpDate,
    pastMedicalHistory,
    socialHistory,
    reviewOfSystems,
    medicationPlan,
    nonMedicationPlan,
    patientEducation,
    lifestyleAdvice,
    warningSigns,
    disposition,
    referralNeeded,
    referralNotes,
    severity,
    duration,
    severityAssessment,
    differentialDiagnosis,
    familyHistory,
    smoking,
    alcohol,
    occupation
  } = req.body;
  
  // Declare medicalHistoryEntries here so it's accessible in the response
  let medicalHistoryEntries: any[] = [];
  
  try {
    await db.query('START TRANSACTION');
    
    // Get or create patient_visit
    const [activeVisit]: any = await db.query(`
      SELECT VisitID FROM patient_visit 
      WHERE PatientID = ? 
        AND DATE(ArrivalTime) = CURDATE()
        AND VisitStatus NOT IN ('completed', 'cancelled')
      ORDER BY ArrivalTime DESC
      LIMIT 1
    `, [patientId]);
    
    let visitId;
    
    if (activeVisit.length === 0) {
      // Create new visit
      const [visit]: any = await db.query(`
        INSERT INTO patient_visit 
        (PatientID, DoctorID, VisitType, ArrivalTime, CheckInTime, VisitStatus, QueueStatus, VisitNotes)
        VALUES (?, ?, 'consultation', NOW(), NOW(), 'in-consultation', 'in-progress', ?)
      `, [patientId, doctorId, chiefComplaint]);
      
      visitId = visit.insertId;
    } else {
      visitId = activeVisit[0].VisitID;
    }
    
    // Get or create consultation
    const [existingConsultation]: any = await db.query(`
      SELECT ConsultationID FROM consultation WHERE VisitID = ?
    `, [visitId]);
    
    let consultationId;
    
    if (existingConsultation.length === 0) {
      // Create new consultation
      const [consultation]: any = await db.query(`
        INSERT INTO consultation 
        (VisitID, DoctorID, StartTime, ChiefComplaint, HistoryOfPresentIllness, 
         PhysicalExamFindings, Diagnosis, DiagnosisCode, TreatmentPlan, 
         ConsultationNotes, FollowUpInstructions, FollowUpDate)
        VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        visitId, doctorId, chiefComplaint, historyOfPresentIllness,
        physicalExamFindings, diagnosis, diagnosisCode, treatmentPlan,
        consultationNotes, followUpInstructions, followUpDate || null
      ]);
      
      consultationId = consultation.insertId;
    } else {
      // Update existing consultation
      consultationId = existingConsultation[0].ConsultationID;
      await db.query(`
        UPDATE consultation 
        SET 
          ChiefComplaint = ?,
          HistoryOfPresentIllness = ?,
          PhysicalExamFindings = ?,
          Diagnosis = ?,
          DiagnosisCode = ?,
          TreatmentPlan = ?,
          ConsultationNotes = ?,
          FollowUpInstructions = ?,
          FollowUpDate = ?,
          EndTime = NOW(),
          UpdatedAt = NOW()
        WHERE ConsultationID = ?
      `, [
        chiefComplaint, historyOfPresentIllness, physicalExamFindings,
        diagnosis, diagnosisCode, treatmentPlan, consultationNotes,
        followUpInstructions, followUpDate || null, consultationId
      ]);
    }
    
    // ==============================
    // AUTO-CREATE MEDICAL HISTORY ENTRIES
    // ==============================
    try {
      const currentDate = new Date().toISOString().split('T')[0];
      medicalHistoryEntries = []; // Initialize the array

      // 1. DIAGNOSIS/CONDITION
      if (diagnosis?.trim()) {
        medicalHistoryEntries.push({
          PatientID: parseInt(patientId),
          ConsultationID: consultationId,
          VisitID: visitId,
          RecordType: 'condition',
          RecordName: diagnosis,
          Description: `Primary diagnosis: ${diagnosis}\nCode: ${diagnosisCode || 'N/A'}\nSeverity: ${severityAssessment || severity || 'moderate'}`,
          Status: 'active',
          StartDate: currentDate,
          Severity: severityAssessment || severity || 'moderate',
          Notes: consultationNotes,
          CreatedBy: parseInt(doctorId)
        });
      }

      // 2. CHIEF COMPLAINT (as symptom history)
      if (chiefComplaint?.trim()) {
        medicalHistoryEntries.push({
          PatientID: parseInt(patientId),
          ConsultationID: consultationId,
          VisitID: visitId,
          RecordType: 'other',
          RecordName: 'Chief Complaint',
          Description: chiefComplaint,
          Status: 'resolved',
          StartDate: currentDate,
          EndDate: currentDate,
          Severity: severity || 'moderate',
          Notes: `Duration: ${duration || 'N/A'}`,
          CreatedBy: parseInt(doctorId)
        });
      }

      // 3. DIFFERENTIAL DIAGNOSIS
      if (differentialDiagnosis?.trim()) {
        medicalHistoryEntries.push({
          PatientID: parseInt(patientId),
          ConsultationID: consultationId,
          VisitID: visitId,
          RecordType: 'condition',
          RecordName: 'Differential Diagnoses',
          Description: differentialDiagnosis,
          Status: 'resolved',
          Notes: 'Considered during diagnosis',
          CreatedBy: parseInt(doctorId)
        });
      }

      // 4. PAST MEDICAL HISTORY (if documented)
      if (pastMedicalHistory?.trim()) {
        medicalHistoryEntries.push({
          PatientID: parseInt(patientId),
          ConsultationID: consultationId,
          VisitID: visitId,
          RecordType: 'condition',
          RecordName: 'Documented Medical History',
          Description: pastMedicalHistory,
          Status: 'chronic',
          Notes: 'Patient-reported past medical history',
          CreatedBy: parseInt(doctorId)
        });
      }

      // 5. FAMILY HISTORY
      if (familyHistory?.trim()) {
        medicalHistoryEntries.push({
          PatientID: parseInt(patientId),
          ConsultationID: consultationId,
          VisitID: visitId,
          RecordType: 'other',
          RecordName: 'Family History',
          Description: familyHistory,
          Status: 'historical',
          Notes: 'Family medical history',
          CreatedBy: parseInt(doctorId)
        });
      }

      // 6. LIFESTYLE FACTORS
      if (smoking || alcohol || occupation) {
        medicalHistoryEntries.push({
          PatientID: parseInt(patientId),
          ConsultationID: consultationId,
          VisitID: visitId,
          RecordType: 'other',
          RecordName: 'Social/Lifestyle History',
          Description: `Smoking: ${smoking || 'None'}\nAlcohol: ${alcohol || 'None'}\nOccupation: ${occupation || 'Not specified'}`,
          Status: 'active',
          Notes: 'Social and lifestyle factors',
          CreatedBy: parseInt(doctorId)
        });
      }

      // 7. TREATMENT PLAN
      if (treatmentPlan?.trim()) {
        medicalHistoryEntries.push({
          PatientID: parseInt(patientId),
          ConsultationID: consultationId,
          VisitID: visitId,
          RecordType: 'procedure',
          RecordName: 'Treatment Plan',
          Description: treatmentPlan,
          Status: 'active',
          StartDate: currentDate,
          Notes: medicationPlan || nonMedicationPlan || '',
          CreatedBy: parseInt(doctorId)
        });
      }

      // 8. REFERRAL (if needed)
      if (referralNeeded) {
        medicalHistoryEntries.push({
          PatientID: parseInt(patientId),
          ConsultationID: consultationId,
          VisitID: visitId,
          RecordType: 'procedure',
          RecordName: 'Medical Referral',
          Description: referralNotes || 'Patient requires specialist referral',
          Status: 'pending',
          StartDate: currentDate,
          Notes: referralNotes || '',
          CreatedBy: parseInt(doctorId)
        });
      }

      // 9. PATIENT EDUCATION
      if (patientEducation?.trim() || lifestyleAdvice?.trim()) {
        medicalHistoryEntries.push({
          PatientID: parseInt(patientId),
          ConsultationID: consultationId,
          VisitID: visitId,
          RecordType: 'other',
          RecordName: 'Patient Education',
          Description: `${patientEducation || ''}\n${lifestyleAdvice || ''}`,
          Status: 'active',
          Notes: 'Education and advice provided',
          CreatedBy: parseInt(doctorId)
        });
      }

      // 10. DISPOSITION
      if (disposition) {
        medicalHistoryEntries.push({
          PatientID: parseInt(patientId),
          ConsultationID: consultationId,
          VisitID: visitId,
          RecordType: 'procedure',
          RecordName: 'Disposition',
          Description: `Patient disposition: ${disposition}`,
          Status: 'completed',
          StartDate: currentDate,
          Notes: consultationNotes,
          CreatedBy: parseInt(doctorId)
        });
      }

      // Save all medical history entries
      for (const entry of medicalHistoryEntries) {
        await db.query(`
          INSERT INTO medical_history 
          (PatientID, ConsultationID, VisitID, RecordType, RecordName, 
           Description, Status, StartDate, EndDate, Severity, Reaction, 
           Dosage, Frequency, PrescribedBy, Notes, CreatedBy, CreatedAt, UpdatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        `, [
          entry.PatientID,
          entry.ConsultationID,
          entry.VisitID || null,
          entry.RecordType,
          entry.RecordName,
          entry.Description || null,
          entry.Status || 'active',
          entry.StartDate || null,
          entry.EndDate || null,
          entry.Severity || null,
          entry.Reaction || null,
          entry.Dosage || null,
          entry.Frequency || null,
          entry.PrescribedBy || null,
          entry.Notes || null,
          entry.CreatedBy
        ]);
      }

      console.log(`Auto-created ${medicalHistoryEntries.length} medical history entries`);
      
    } catch (historyError) {
      console.error('Error creating medical history entries:', historyError);
      // Don't fail the whole consultation if medical history fails
    }
    // ==============================
    // END MEDICAL HISTORY CREATION
    // ==============================
    
    // Update visit status to completed
    await db.query(`
      UPDATE patient_visit 
      SET 
        VisitStatus = 'completed',
        QueueStatus = 'completed',
        CheckOutTime = NOW()
      WHERE VisitID = ?
    `, [visitId]);
    
    await db.query('COMMIT');
    
    res.json({ 
      success: true,
      message: "Consultation saved successfully",
      consultationId: consultationId,
      visitId: visitId,
      entriesCreated: medicalHistoryEntries.length // Now accessible
    });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error("Save consultation full error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to save consultation" 
    });
  }
};

// Add these to doctorController.ts

// Get detailed patient information for consultation tab
export const getPatientForConsultation = async (req: Request, res: Response) => {
  const { patientId } = req.params;
  
  try {
    console.log('Getting patient for consultation ID:', patientId);
    
    const [patient]: any = await db.query(`
      SELECT 
        p.PatientID,
        p.Name,
        p.ICNo,
        p.Gender,
        p.DOB,
        p.BloodType,
        p.PhoneNumber,
        p.Email,
        p.Address,
        p.InsuranceProvider,
        p.InsurancePolicyNo,
        p.EmergencyContactName,
        p.EmergencyContactPhone,
        TIMESTAMPDIFF(YEAR, p.DOB, CURDATE()) as age
      FROM patient p
      WHERE p.PatientID = ?
    `, [patientId]);
    
    if (patient.length === 0) {
      return res.status(404).json({ error: "Patient not found" });
    }
    
    res.json(patient[0]);
  } catch (error) {
    console.error("Patient for consultation error:", error);
    res.status(500).json({ error: "Failed to fetch patient details" });
  }
};

// Save vital signs with consultation creation if needed
export const saveVitalSignsWithConsultation = async (req: Request, res: Response) => {
  const {
    consultationId,
    takenBy,
    bloodPressureSystolic,
    bloodPressureDiastolic,
    bloodPressure,
    heartRate,
    respiratoryRate,
    temperature,
    oxygenSaturation,
    height,
    weight,
    bmi,
    painLevel,
    notes,
    patientId
  } = req.body;
  
  try {
    await db.query('START TRANSACTION');
    
    let finalConsultationId = consultationId;
    
    // If no consultationId provided, create one
    if (!finalConsultationId && patientId && takenBy) {
      // Check for existing consultation today
      const [existingConsultation]: any = await db.query(`
        SELECT c.ConsultationID 
        FROM consultation c
        JOIN patient_visit pv ON c.VisitID = pv.VisitID
        WHERE pv.PatientID = ? 
          AND DATE(pv.ArrivalTime) = CURDATE()
          AND pv.VisitStatus NOT IN ('completed', 'cancelled')
        ORDER BY pv.ArrivalTime DESC
        LIMIT 1
      `, [patientId]);
      
      if (existingConsultation.length === 0) {
        // Create new visit and consultation
        const [visit]: any = await db.query(`
          INSERT INTO patient_visit 
          (PatientID, DoctorID, VisitType, ArrivalTime, CheckInTime, VisitStatus, QueueStatus, VisitNotes)
          VALUES (?, ?, 'walk-in', NOW(), NOW(), 'checked-in', 'waiting', 'Vital signs recording')
        `, [patientId, takenBy]);
        
        const [consultation]: any = await db.query(`
          INSERT INTO consultation (VisitID, DoctorID, StartTime)
          VALUES (?, ?, NOW())
        `, [visit.insertId, takenBy]);
        
        finalConsultationId = consultation.insertId;
      } else {
        finalConsultationId = existingConsultation[0].ConsultationID;
      }
    }
    
    // Parse blood pressure if provided as string "120/80"
    let bpSystolic = bloodPressureSystolic;
    let bpDiastolic = bloodPressureDiastolic;
    
    if (bloodPressure && bloodPressure.includes('/')) {
      const parts = bloodPressure.split('/');
      bpSystolic = parts[0]?.trim();
      bpDiastolic = parts[1]?.trim();
    }
    
    // Save vital signs
    const [result]: any = await db.query(`
      INSERT INTO vital_signs 
      (ConsultationID, TakenBy, TakenAt, BloodPressureSystolic, BloodPressureDiastolic, 
       HeartRate, RespiratoryRate, Temperature, OxygenSaturation, Height, Weight, BMI, PainLevel, Notes)
      VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      finalConsultationId,
      takenBy,
      bpSystolic,
      bpDiastolic,
      heartRate,
      respiratoryRate,
      temperature,
      oxygenSaturation,
      height,
      weight,
      bmi,
      painLevel,
      notes
    ]);
    
    await db.query('COMMIT');
    
    res.json({ 
      success: true,
      message: "Vital signs saved successfully",
      vitalSignId: result.insertId,
      consultationId: finalConsultationId
    });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error("Save vital signs with consultation error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to save vital signs" 
    });
  }
};

// Save comprehensive consultation (matches frontend form)
export const saveComprehensiveConsultation = async (req: Request, res: Response) => {
  const {
    patientId,
    doctorId,
    chiefComplaint,
    historyOfPresentIllness,
    pastMedicalHistory,
    socialHistory,
    reviewOfSystems,
    physicalExamFindings,
    diagnosis,
    differentialDiagnosis,
    diagnosisCode,
    treatmentPlan,
    medicationPlan,
    nonMedicationPlan,
    patientEducation,
    lifestyleAdvice,
    warningSigns,
    consultationNotes,
    followUpInstructions,
    followUpDate,
    disposition,
    referralNeeded,
    referralNotes,
    severity
  } = req.body;
  
  try {
    await db.query('START TRANSACTION');
    
    // Get or create patient visit
    const [activeVisit]: any = await db.query(`
      SELECT VisitID FROM patient_visit 
      WHERE PatientID = ? 
        AND DATE(ArrivalTime) = CURDATE()
        AND VisitStatus NOT IN ('completed', 'cancelled')
      ORDER BY ArrivalTime DESC
      LIMIT 1
    `, [patientId]);
    
    let visitId;
    
    if (activeVisit.length === 0) {
      // Create new visit
      const [visit]: any = await db.query(`
        INSERT INTO patient_visit 
        (PatientID, DoctorID, VisitType, ArrivalTime, CheckInTime, VisitStatus, QueueStatus, VisitNotes)
        VALUES (?, ?, 'consultation', NOW(), NOW(), 'in-consultation', 'in-progress', ?)
      `, [patientId, doctorId, chiefComplaint || 'New consultation']);
      
      visitId = visit.insertId;
    } else {
      visitId = activeVisit[0].VisitID;
    }
    
    // Parse JSON fields if they are strings
    let socialHistoryParsed = socialHistory;
    let reviewOfSystemsParsed = reviewOfSystems;
    let physicalExamFindingsParsed = physicalExamFindings;
    
    try {
      if (typeof socialHistory === 'string') socialHistoryParsed = JSON.parse(socialHistory);
      if (typeof reviewOfSystems === 'string') reviewOfSystemsParsed = JSON.parse(reviewOfSystems);
      if (typeof physicalExamFindings === 'string') physicalExamFindingsParsed = JSON.parse(physicalExamFindings);
    } catch (parseError) {
      console.warn('Failed to parse JSON fields, storing as-is');
    }
    
    // Get or create consultation
    const [existingConsultation]: any = await db.query(`
      SELECT ConsultationID FROM consultation WHERE VisitID = ?
    `, [visitId]);
    
    let consultationId;
    
    if (existingConsultation.length === 0) {
      // Create new comprehensive consultation
      const [consultation]: any = await db.query(`
        INSERT INTO consultation 
        (VisitID, DoctorID, StartTime, ChiefComplaint, HistoryOfPresentIllness, 
         PhysicalExamFindings, Diagnosis, DiagnosisCode, TreatmentPlan, 
         ConsultationNotes, FollowUpInstructions, FollowUpDate)
        VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        visitId, 
        doctorId, 
        chiefComplaint,
        historyOfPresentIllness,
        JSON.stringify(physicalExamFindingsParsed),
        diagnosis,
        diagnosisCode,
        treatmentPlan,
        consultationNotes,
        followUpInstructions,
        followUpDate || null
      ]);
      
      consultationId = consultation.insertId;
    } else {
      // Update existing consultation
      consultationId = existingConsultation[0].ConsultationID;
      await db.query(`
        UPDATE consultation 
        SET 
          ChiefComplaint = ?,
          HistoryOfPresentIllness = ?,
          PhysicalExamFindings = ?,
          Diagnosis = ?,
          DiagnosisCode = ?,
          TreatmentPlan = ?,
          ConsultationNotes = ?,
          FollowUpInstructions = ?,
          FollowUpDate = ?,
          EndTime = NOW(),
          UpdatedAt = NOW()
        WHERE ConsultationID = ?
      `, [
        chiefComplaint,
        historyOfPresentIllness,
        JSON.stringify(physicalExamFindingsParsed),
        diagnosis,
        diagnosisCode,
        treatmentPlan,
        consultationNotes,
        followUpInstructions,
        followUpDate || null,
        consultationId
      ]);
    }
    
    // Save additional data to medical_history table
    if (pastMedicalHistory) {
      await db.query(`
        INSERT INTO medical_history 
        (PatientID, ConsultationID, RecordType, RecordName, Description, Status, CreatedBy)
        VALUES (?, ?, 'condition', 'Past Medical History', ?, 'historical', ?)
      `, [patientId, consultationId, pastMedicalHistory, doctorId]);
    }
    
    if (medicationPlan) {
      await db.query(`
        INSERT INTO medical_history 
        (PatientID, ConsultationID, RecordType, RecordName, Description, Status, CreatedBy)
        VALUES (?, ?, 'medication', 'Medication Plan', ?, 'active', ?)
      `, [patientId, consultationId, medicationPlan, doctorId]);
    }
    
    if (patientEducation) {
      await db.query(`
        INSERT INTO medical_history 
        (PatientID, ConsultationID, RecordType, RecordName, Description, Status, CreatedBy)
        VALUES (?, ?, 'other', 'Patient Education', ?, 'active', ?)
      `, [patientId, consultationId, patientEducation, doctorId]);
    }
    
    // Update visit status
    await db.query(`
      UPDATE patient_visit 
      SET 
        VisitStatus = 'completed',
        QueueStatus = 'completed',
        CheckOutTime = NOW()
      WHERE VisitID = ?
    `, [visitId]);
    
    // Update appointment status if exists
    await db.query(`
      UPDATE appointment 
      SET Status = 'completed' 
      WHERE AppointmentID IN (
        SELECT AppointmentID FROM patient_visit WHERE VisitID = ?
      )
    `, [visitId]);
    
    await db.query('COMMIT');
    
    res.json({ 
      success: true,
      message: "Consultation saved successfully",
      consultationId: consultationId,
      visitId: visitId
    });
  } catch (error) {
    await db.query('ROLLBACK');
    console.error("Save comprehensive consultation error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to save consultation" 
    });
  }
};

// Add this new API endpoint
export const createFollowUp = async (req: Request, res: Response) => {
  try {
    const {
      patientId,
      doctorId,
      consultationId,
      followUpDate,
      purpose,
      notes
    } = req.body;

    if (!patientId || !doctorId || !followUpDate) {
      return res.status(400).json({
        success: false,
        error: 'Patient ID, Doctor ID, and Follow-up Date are required'
      });
    }

    // Generate queue number
    const queuePrefix = `Q-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}`;
    const [lastAppointment]: any = await db.query(`
      SELECT QueueNumber FROM appointment 
      WHERE QueueNumber LIKE '${queuePrefix}%'
      ORDER BY AppointmentID DESC LIMIT 1
    `);

    let queueNumber = `${queuePrefix}-001`;
    if (lastAppointment.length > 0) {
      const lastNumber = parseInt(lastAppointment[0].QueueNumber.split('-').pop());
      queueNumber = `${queuePrefix}-${String(lastNumber + 1).padStart(3, '0')}`;
    }

    // Create appointment
    const [appointment]: any = await db.query(`
      INSERT INTO appointment 
      (AppointmentDateTime, Purpose, Status, PatientID, DoctorID, 
       CreatedBy, QueueNumber, Notes, start_time, end_time, UpdatedAt)
      VALUES (?, ?, 'scheduled', ?, ?, ?, ?, ?, '09:00:00', '09:30:00', NOW())
    `, [
      `${followUpDate} 09:00:00`,
      purpose || 'Follow-up consultation',
      parseInt(patientId),
      parseInt(doctorId),
      parseInt(doctorId), // CreatedBy same as doctor
      queueNumber,
      notes || ''
    ]);

    // Update consultation with follow-up info
    if (consultationId) {
      await db.query(`
        UPDATE consultation 
        SET FollowUpDate = ?, UpdatedAt = NOW()
        WHERE ConsultationID = ?
      `, [followUpDate, consultationId]);
    }

    res.json({
      success: true,
      message: "Follow-up appointment created successfully",
      appointmentId: appointment.insertId,
      queueNumber: queueNumber
    });

  } catch (error: any) {
    console.error('Create follow-up error:', error);
    res.status(500).json({
      success: false,
      error: "Failed to create follow-up appointment",
      message: error.message
    });
  }
};

// In your doctor controller file - ADD THIS NEW FUNCTION
export const saveConsultationForm = async (req: Request, res: Response) => {
  console.log('=== SAVE CONSULTATION FORM ENDPOINT HIT ===');
  console.log('Request method:', req.method);
  console.log('Request URL:', req.originalUrl);
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  
  try {
    const {
      patientId,
      doctorId,
      chiefComplaint,
      historyOfPresentIllness,
      diagnosis,
      diagnosisCode,
      treatmentPlan,
      consultationNotes,
      followUpInstructions,
      followUpDate,
      physicalExamFindings,
      labTestsOrdered = false,
      referralGiven = false,
      // Additional fields
      severityAssessment,
      differentialDiagnosis,
      medicationPlan,
      nonMedicationPlan,
      patientEducation,
      lifestyleAdvice,
      warningSigns,
      disposition,
      referralNotes,
      pastMedicalHistory,
      familyHistory,
      needsFollowUp,
      followUpTime,
      followUpPurpose,
      referralNeeded
    } = req.body;
    
    console.log('Parsed patientId:', patientId);
    console.log('Parsed doctorId:', doctorId);
    
    // Validate required fields
    if (!patientId || !doctorId) {
      console.error('Missing required fields: patientId or doctorId');
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: patientId and doctorId are required'
      });
    }

    const patientIdNum = parseInt(patientId);
    const doctorIdNum = parseInt(doctorId);
    
    console.log('Starting transaction...');
    await db.query('START TRANSACTION');

    // ======================
    // 1. FIND OR CREATE CONSULTATION
    // ======================
    console.log('1. Finding or creating consultation...');
    
    let consultationId;
    let visitId;
    
    // First, try to find existing active consultation for today
    const [consultationCheck]: any = await db.query(`
      SELECT c.ConsultationID, c.VisitID, pv.VisitID, pv.VisitStatus
      FROM consultation c
      JOIN patient_visit pv ON c.VisitID = pv.VisitID
      WHERE pv.PatientID = ?
        AND c.DoctorID = ?
        AND DATE(c.CreatedAt) = CURDATE()
        AND (pv.VisitStatus = 'in-consultation' OR pv.VisitStatus = 'checked-in')
      ORDER BY c.CreatedAt DESC
      LIMIT 1
    `, [patientIdNum, doctorIdNum]);
    
    console.log('Consultation check result:', consultationCheck);
    
    if (consultationCheck.length > 0) {
      // Use existing consultation
      consultationId = consultationCheck[0].ConsultationID;
      visitId = consultationCheck[0].VisitID;
      console.log('Found existing consultation ID:', consultationId, 'Visit ID:', visitId);
    } else {
      console.log('No existing consultation found, looking for active visit...');
      
      // Find active visit for this patient/doctor
      const [activeVisit]: any = await db.query(`
        SELECT VisitID FROM patient_visit 
        WHERE PatientID = ?
          AND DoctorID = ?
          AND (VisitStatus = 'in-consultation' OR VisitStatus = 'checked-in')
          AND DATE(ArrivalTime) = CURDATE()
        ORDER BY ArrivalTime DESC
        LIMIT 1
      `, [patientIdNum, doctorIdNum]);
      
      if (activeVisit.length === 0) {
        console.error('No active visit found for patient/doctor');
        await db.query('ROLLBACK');
        return res.status(404).json({ 
          success: false,
          error: "No active consultation found. Please call the patient first." 
        });
      }
      
      visitId = activeVisit[0].VisitID;
      console.log('Found active visit ID:', visitId);
      
      // Create consultation
      const [newConsultation]: any = await db.query(`
        INSERT INTO consultation 
        (VisitID, DoctorID, StartTime, CreatedAt, UpdatedAt)
        VALUES (?, ?, NOW(), NOW(), NOW())
      `, [visitId, doctorIdNum]);
      
      consultationId = newConsultation.insertId;
      console.log('Created new consultation ID:', consultationId);
    }
    
    // ======================
    // 2. PARSE PHYSICAL EXAM FINDINGS
    // ======================
    let parsedPhysicalExamFindings = {};
    try {
      if (physicalExamFindings) {
        console.log('Physical exam findings raw:', physicalExamFindings);
        if (typeof physicalExamFindings === 'string') {
          parsedPhysicalExamFindings = JSON.parse(physicalExamFindings);
        } else if (typeof physicalExamFindings === 'object') {
          parsedPhysicalExamFindings = physicalExamFindings;
        }
        console.log('Parsed physical exam findings:', parsedPhysicalExamFindings);
      } else {
        console.log('No physical exam findings provided');
      }
    } catch (parseError) {
      console.warn('Could not parse physicalExamFindings:', parseError);
      parsedPhysicalExamFindings = {
        generalAppearance: "",
        cardiovascular: "",
        respiratory: "",
        abdominal: "",
        neurological: ""
      };
    }

    // ======================
    // 3. UPDATE CONSULTATION
    // ======================
    console.log('3. Updating consultation...');
    
    const updateQuery = `
      UPDATE consultation 
      SET 
        ChiefComplaint = COALESCE(?, ChiefComplaint),
        HistoryOfPresentIllness = COALESCE(?, HistoryOfPresentIllness),
        PhysicalExamFindings = COALESCE(?, PhysicalExamFindings),
        Diagnosis = COALESCE(?, Diagnosis),
        DiagnosisCode = COALESCE(?, DiagnosisCode),
        TreatmentPlan = COALESCE(?, TreatmentPlan),
        LabTestsOrdered = COALESCE(?, LabTestsOrdered),
        ReferralGiven = COALESCE(?, ReferralGiven),
        FollowUpDate = COALESCE(?, FollowUpDate),
        FollowUpInstructions = COALESCE(?, FollowUpInstructions),
        ConsultationNotes = COALESCE(?, ConsultationNotes),
        SeverityAssessment = COALESCE(?, SeverityAssessment),
        MedicationPlan = COALESCE(?, MedicationPlan),
        NonMedicationPlan = COALESCE(?, NonMedicationPlan),
        PatientEducation = COALESCE(?, PatientEducation),
        LifestyleAdvice = COALESCE(?, LifestyleAdvice),
        WarningSigns = COALESCE(?, WarningSigns),
        Disposition = COALESCE(?, Disposition),
        ReferralNotes = COALESCE(?, ReferralNotes),
        PastMedicalHistory = COALESCE(?, PastMedicalHistory),
        FamilyHistory = COALESCE(?, FamilyHistory),
        DifferentialDiagnosis = COALESCE(?, DifferentialDiagnosis),
        NeedsFollowUp = COALESCE(?, NeedsFollowUp),
        FollowUpTime = COALESCE(?, FollowUpTime),
        FollowUpPurpose = COALESCE(?, FollowUpPurpose),
        UpdatedAt = NOW()
      WHERE ConsultationID = ?
    `;
    
    const updateParams = [
      chiefComplaint || null,
      historyOfPresentIllness || null,
      JSON.stringify(parsedPhysicalExamFindings) || null,
      diagnosis || null,
      diagnosisCode || null,
      treatmentPlan || null,
      labTestsOrdered ? 1 : 0,
      referralGiven ? 1 : 0,
      followUpDate || null,
      followUpInstructions || null,
      consultationNotes || null,
      severityAssessment || null,
      medicationPlan || null,
      nonMedicationPlan || null,
      patientEducation || null,
      lifestyleAdvice || null,
      warningSigns || null,
      disposition || null,
      referralNotes || null,
      pastMedicalHistory || null,
      familyHistory || null,
      differentialDiagnosis || null,
      needsFollowUp ? 1 : 0,
      followUpTime || null,
      followUpPurpose || null,
      consultationId
    ];
    
    console.log('Update query:', updateQuery);
    console.log('Update params:', updateParams);
    
    const [updateResult]: any = await db.query(updateQuery, updateParams);
    
    console.log('Update result:', updateResult);
    console.log('Rows affected:', updateResult.affectedRows);

    // ======================
    // 4. CREATE/UPDATE MEDICAL HISTORY ENTRY FOR DIAGNOSIS
    // ======================
    if (diagnosis && diagnosis.trim()) {
      console.log('4. Creating/updating medical history for diagnosis:', diagnosis);
      const currentDate = new Date().toISOString().split('T')[0];
      
      // Check if this diagnosis is already in medical history for this consultation
      const [existingHistory]: any = await db.query(`
        SELECT HistoryID FROM medical_history 
        WHERE PatientID = ? 
          AND ConsultationID = ?
          AND RecordName = ? 
          AND Status = 'active'
      `, [patientIdNum, consultationId, diagnosis]);

      console.log('Existing medical history found:', existingHistory.length);
      
      if (existingHistory.length === 0) {
        // Create new medical history entry
        console.log('Creating new medical history entry');
        await db.query(`
          INSERT INTO medical_history 
          (PatientID, ConsultationID, VisitID, RecordType, RecordName, 
           Description, Status, StartDate, Severity, Notes, CreatedBy, CreatedAt)
          VALUES (?, ?, ?, 'condition', ?, ?, 'active', ?, ?, ?, ?, NOW())
        `, [
          patientIdNum,
          consultationId,
          visitId,
          diagnosis,
          `Primary diagnosis: ${diagnosis}\nCode: ${diagnosisCode || 'N/A'}`,
          currentDate,
          severityAssessment || 'moderate',
          consultationNotes || null,
          doctorIdNum
        ]);
        console.log('Medical history entry created');
      } else {
        // Update existing medical history entry
        console.log('Updating existing medical history entry');
        await db.query(`
          UPDATE medical_history 
          SET 
            Description = ?,
            Severity = COALESCE(?, Severity),
            Notes = COALESCE(?, Notes),
            UpdatedAt = NOW()
          WHERE HistoryID = ?
        `, [
          `Primary diagnosis: ${diagnosis}\nCode: ${diagnosisCode || 'N/A'}`,
          severityAssessment || null,
          consultationNotes || null,
          existingHistory[0].HistoryID
        ]);
        console.log('Medical history entry updated');
      }
    } else {
      console.log('No diagnosis provided, skipping medical history');
    }

    // ======================
    // 5. CREATE REFERRAL IF NEEDED
    // ======================
    if (referralGiven && referralNotes) {
      console.log('5. Creating/updating referral');
      // Check if referral already exists for this consultation
      const [existingReferral]: any = await db.query(`
        SELECT ReferralID FROM referral 
        WHERE ConsultationID = ?
      `, [consultationId]);
      
      if (existingReferral.length === 0) {
        // Create new referral
        console.log('Creating new referral');
        await db.query(`
          INSERT INTO referral 
          (DoctorID, PatientID, ConsultationID, Reason, Urgency, 
           ReferralDate, Status, Specialty)
          VALUES (?, ?, ?, ?, 'routine', NOW(), 'pending', 'General')
        `, [doctorIdNum, patientIdNum, consultationId, referralNotes]);
        console.log('Referral record created');
      } else {
        // Update existing referral
        console.log('Updating existing referral');
        await db.query(`
          UPDATE referral 
          SET 
            Reason = ?,
            UpdatedAt = NOW()
          WHERE ReferralID = ?
        `, [referralNotes, existingReferral[0].ReferralID]);
        console.log('Referral record updated');
      }
    } else {
      console.log('No referral needed or no referral notes');
    }

    // ======================
    // 6. COMMIT TRANSACTION
    // ======================
    await db.query('COMMIT');
    console.log('Transaction committed successfully');

    // ======================
    // 7. FETCH UPDATED CONSULTATION DETAILS
    // ======================
    console.log('7. Fetching updated consultation details');
    const [updatedConsultation]: any = await db.query(`
      SELECT 
        c.*,
        pv.VisitID,
        pv.VisitStatus,
        pv.QueueStatus
      FROM consultation c
      JOIN patient_visit pv ON c.VisitID = pv.VisitID
      WHERE c.ConsultationID = ?
    `, [consultationId]);
    
    console.log('Updated consultation:', updatedConsultation[0]);
    
    const responseData = { 
      success: true,
      message: "Consultation form saved successfully",
      consultationId: consultationId,
      visitId: visitId,
      consultation: updatedConsultation[0] || null
    };
    
    console.log('Sending response:', responseData);
    
    res.json(responseData);
    
    console.log('=== SAVE CONSULTATION FORM SUCCESS ===');
    
  } catch (error: any) {
    console.error('SAVE CONSULTATION FORM ERROR:', error);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('SQL error:', error.sqlMessage);
    
    try {
      await db.query('ROLLBACK');
      console.log('Transaction rolled back');
    } catch (rollbackError) {
      console.error('Rollback error:', rollbackError);
    }

    res.status(500).json({ 
      success: false,
      error: "Failed to save consultation form",
      message: error.message,
      sqlMessage: error.sqlMessage || 'No SQL error'
    });
  }
};

// KEEP THE OLD FUNCTION BUT RENAME IT for completing consultation later
// receptionistController.ts or consultationController.ts
export const completeConsultation = async (req: Request, res: Response) => {
  const { consultationId, patientId, doctorId } = req.body;
  
  try {
    console.log('=== COMPLETE CONSULTATION START ===');
    console.log('Params:', { consultationId, patientId, doctorId });
    
    // Start transaction
    await db.query('START TRANSACTION');
    
    // ============================================
    // 1. GET CONSULTATION DETAILS
    // ============================================
    console.log('1. Getting consultation details...');
    const [consultationDetails]: any = await db.query(`
      SELECT 
        c.*,
        pv.VisitID,
        pv.VisitStatus,
        pv.QueueNumber,
        p.Name AS PatientName,
        p.InsuranceProvider,
        u.Name AS DoctorName,
        d.Specialization
      FROM consultation c
      JOIN patient_visit pv ON c.VisitID = pv.VisitID
      JOIN patient p ON pv.PatientID = p.PatientID
      JOIN useraccount u ON c.DoctorID = u.UserID
      LEFT JOIN doctorprofile d ON c.DoctorID = d.DoctorID
      WHERE c.ConsultationID = ? 
        AND c.DoctorID = ? 
        AND pv.PatientID = ?
    `, [consultationId, doctorId, patientId]);
    
    if (consultationDetails.length === 0) {
      await db.query('ROLLBACK');
      console.error('Consultation not found');
      return res.status(404).json({ 
        success: false,
        error: "Consultation not found" 
      });
    }
    
    const consultation = consultationDetails[0];
    console.log('Consultation found:', consultation);
    
    // ============================================
    // 2. CHECK IF ALREADY COMPLETED
    // ============================================
    if (consultation.EndTime) {
      await db.query('ROLLBACK');
      return res.status(400).json({ 
        success: false,
        error: "Consultation already completed",
        completedAt: consultation.EndTime
      });
    }
    
    // ============================================
    // 3. UPDATE CONSULTATION END TIME
    // ============================================
    console.log('3. Setting consultation end time...');
    await db.query(`
      UPDATE consultation 
      SET EndTime = NOW(), UpdatedAt = NOW()
      WHERE ConsultationID = ?
    `, [consultationId]);
    
    // ============================================
    // 4. CHECK FOR PRESCRIPTION
    // ============================================
    console.log('4. Checking for prescription...');
    const [prescriptionDetails]: any = await db.query(`
      SELECT p.PrescriptionID, COUNT(pi.ItemID) as ItemCount
      FROM prescription p
      LEFT JOIN prescriptionitem pi ON p.PrescriptionID = pi.PrescriptionID
      WHERE p.ConsultationID = ?
      GROUP BY p.PrescriptionID
    `, [consultationId]);
    
    const hasPrescription = prescriptionDetails.length > 0;
    console.log('Has prescription:', hasPrescription);
    
    // ============================================
    // 5. DETERMINE NEXT STEPS
    // ============================================
    let nextVisitStatus = 'to-be-billed';
    let nextDestination = 'Billing Counter';
    let pharmacyQueueNumber = null;
    
    if (hasPrescription) {
      nextVisitStatus = 'waiting-prescription';
      nextDestination = 'Pharmacy';
      
      // Generate pharmacy queue number
      const today = new Date();
      const dateStr = today.getFullYear().toString().slice(-2) + 
                     String(today.getMonth() + 1).padStart(2, '0') + 
                     String(today.getDate()).padStart(2, '0');
      
      const [pharmacyQueue]: any = await db.query(`
        SELECT COUNT(*) as count FROM prescription 
        WHERE DATE(PrescribedDate) = CURDATE()
      `);
      
      pharmacyQueueNumber = `P-${dateStr}-${String(pharmacyQueue[0].count + 1).padStart(3, '0')}`;
      console.log('Pharmacy queue:', pharmacyQueueNumber);
    }
    
    // ============================================
    // 6. UPDATE PATIENT VISIT
    // ============================================
    console.log('6. Updating patient visit...');
    await db.query(`
      UPDATE patient_visit 
      SET 
        VisitStatus = ?,
        QueueStatus = 'waiting',
        QueueNumber = COALESCE(?, QueueNumber),
        CheckOutTime = NOW(),
        UpdatedAt = NOW()
      WHERE VisitID = ?
    `, [nextVisitStatus, pharmacyQueueNumber, consultation.VisitID]);
    
    // ============================================
    // 7. UPDATE PRESCRIPTION WITH QUEUE (IF ANY)
    // ============================================
    if (hasPrescription && pharmacyQueueNumber) {
      console.log('7. Updating prescription with queue info...');
      await db.query(`
        UPDATE prescription 
        SET Remarks = CONCAT(
          IFNULL(Remarks, ''),
          '\nPharmacy Queue: ', ?,
          '\nTime: ', DATE_FORMAT(NOW(), '%r')
        )
        WHERE ConsultationID = ?
      `, [pharmacyQueueNumber, consultationId]);
    }
    
    // ============================================
    // 8. AUTO-CREATE BILL (NEW!)
    // ============================================
    console.log('8. Creating auto-bill...');
    const billingResult = await createAutoBill(consultationId, patientId, consultation.InsuranceProvider);
    console.log('Billing result:', billingResult);
    
    // ============================================
    // 9. ADD TO MEDICAL HISTORY
    // ============================================
    if (consultation.Diagnosis && consultation.Diagnosis.trim() !== '') {
      console.log('9. Adding to medical history...');
      await db.query(`
        INSERT INTO medical_history (
          PatientID, ConsultationID, VisitID, RecordType, 
          RecordName, Description, Status, StartDate,
          Severity, CreatedBy, CreatedAt, UpdatedAt
        ) VALUES (?, ?, ?, 'condition', ?, ?, 'active', 
          CURDATE(), ?, ?, NOW(), NOW())
      `, [
        patientId,
        consultationId,
        consultation.VisitID,
        consultation.Diagnosis,
        `Primary diagnosis: ${consultation.Diagnosis}\nCode: ${consultation.DiagnosisCode || 'N/A'}`,
        consultation.SeverityAssessment || 'mild',
        doctorId
      ]);
    }
    
    // ============================================
    // 10. COMMIT TRANSACTION
    // ============================================
    await db.query('COMMIT');
    
    console.log('=== CONSULTATION COMPLETED SUCCESSFULLY ===');
    
    // Response
    res.json({
      success: true,
      message: `Consultation completed. Patient needs to visit ${nextDestination}.`,
      consultationId,
      visitId: consultation.VisitID,
      nextStatus: nextVisitStatus,
      nextDestination,
      hasPrescription,
      pharmacyQueueNumber: pharmacyQueueNumber,
      billing: {
        created: billingResult.success,
        billId: billingResult.billId,
        totalAmount: billingResult.totalAmount,
        patientResponsibility: billingResult.patientResponsibility
      },
      instructions: hasPrescription 
        ? `1. Go to Pharmacy (Queue: ${pharmacyQueueNumber})\n2. Then go to Billing Counter`
        : `Go directly to Billing Counter`
    });
    
  } catch (error: any) {
    await db.query('ROLLBACK');
    console.error("Complete consultation error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to complete consultation",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get all appointments including those with visits (for consultation tab)
export const getAllTodayAppointments = async (req: Request, res: Response) => {
  const { doctorId } = req.params;
  
  try {
    const [appointments]: any = await db.query(`
      SELECT 
        a.AppointmentID as id,
        a.PatientID as patientId,
        p.Name as name,
        p.Gender as gender,
        TIMESTAMPDIFF(YEAR, p.DOB, CURDATE()) as age,
        DATE_FORMAT(a.AppointmentDateTime, '%h:%i %p') as time,
        a.Purpose as type,
        COALESCE(pv.VisitStatus, a.Status) as status,
        pv.VisitNotes as chiefComplaint,
        COALESCE(pv.VisitType, a.Purpose) as VisitType,
        pv.QueueNumber,
        pv.QueuePosition,
        pv.TriagePriority,
        a.AppointmentDateTime,
        a.Notes
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      LEFT JOIN patient_visit pv ON a.PatientID = pv.PatientID 
        AND DATE(pv.ArrivalTime) = CURDATE()
        AND pv.DoctorID = a.DoctorID
      WHERE a.DoctorID = ? 
        AND DATE(a.AppointmentDateTime) = CURDATE()
        AND a.Status IN ('scheduled', 'confirmed')
      ORDER BY a.AppointmentDateTime ASC
    `, [doctorId]);
    
    // Add walk-in patients
    const [walkIns]: any = await db.query(`
      SELECT 
        pv.VisitID as id,
        pv.PatientID as patientId,
        p.Name as name,
        p.Gender as gender,
        TIMESTAMPDIFF(YEAR, p.DOB, CURDATE()) as age,
        DATE_FORMAT(pv.ArrivalTime, '%h:%i %p') as time,
        'walk-in' as type,
        pv.VisitStatus as status,
        pv.VisitNotes as chiefComplaint,
        pv.VisitType,
        pv.QueueNumber,
        pv.QueuePosition,
        pv.TriagePriority,
        pv.ArrivalTime as AppointmentDateTime,
        NULL as Notes
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      WHERE pv.DoctorID = ? 
        AND DATE(pv.ArrivalTime) = CURDATE()
        AND pv.VisitType = 'walk-in'
        AND pv.VisitStatus NOT IN ('completed', 'cancelled')
      ORDER BY pv.ArrivalTime ASC
    `, [doctorId]);
    
    const allPatients = [...appointments, ...walkIns];
    
    // Sort by time
    allPatients.sort((a, b) => 
      new Date(a.AppointmentDateTime).getTime() - new Date(b.AppointmentDateTime).getTime()
    );
    
    res.json(allPatients);
  } catch (error) {
    console.error("All appointments error:", error);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
};

// Get appointment queue for consultation tab
export const getConsultationQueue = async (req: Request, res: Response) => {
  const { doctorId } = req.params;
  
  try {
    const [queue]: any = await db.query(`
      SELECT 
        pv.VisitID as id,
        pv.PatientID as patientId,
        p.Name as name,
        p.Gender as gender,
        TIMESTAMPDIFF(YEAR, p.DOB, CURDATE()) as age,
        DATE_FORMAT(pv.ArrivalTime, '%h:%i %p') as time,
        pv.VisitType as type,
        pv.VisitStatus as status,
        pv.VisitNotes as chiefComplaint,
        pv.QueueNumber,
        pv.QueuePosition,
        pv.TriagePriority,
        pv.ArrivalTime as AppointmentDateTime,
        'walk-in' as source
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      WHERE pv.DoctorID = ? 
        AND DATE(pv.ArrivalTime) = CURDATE()
        AND pv.VisitStatus IN ('checked-in', 'in-consultation')
        AND pv.QueueStatus IN ('waiting', 'in-progress')
      UNION
      SELECT 
        a.AppointmentID as id,
        a.PatientID as patientId,
        p.Name as name,
        p.Gender as gender,
        TIMESTAMPDIFF(YEAR, p.DOB, CURDATE()) as age,
        DATE_FORMAT(a.AppointmentDateTime, '%h:%i %p') as time,
        a.Purpose as type,
        a.Status as status,
        a.Notes as chiefComplaint,
        NULL as QueueNumber,
        NULL as QueuePosition,
        'medium' as TriagePriority,
        a.AppointmentDateTime,
        'appointment' as source
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      WHERE a.DoctorID = ? 
        AND DATE(a.AppointmentDateTime) = CURDATE()
        AND a.Status IN ('scheduled', 'confirmed')
        AND NOT EXISTS (
          SELECT 1 FROM patient_visit pv 
          WHERE pv.PatientID = a.PatientID 
            AND DATE(pv.ArrivalTime) = CURDATE()
            AND pv.DoctorID = a.DoctorID
        )
      ORDER BY AppointmentDateTime ASC
    `, [doctorId, doctorId]);
    
    res.json(queue);
  } catch (error) {
    console.error("Consultation queue error:", error);
    res.status(500).json({ error: "Failed to fetch consultation queue" });
  }
};

// Add this to your doctorController.ts
export const savePrescription = async (req: Request, res: Response) => {
  try {
    console.log('=== SAVE PRESCRIPTION START ===');
    console.log('Request body:', req.body);
    console.log('Authenticated user:', (req as any).user);
    
    const {
      patientId,
      consultationId,
      items,
      remarks = ''
    } = req.body;

    // Get doctorId from authenticated user (from token)
    const doctorId = (req as any).user?.userId;
    
    console.log('Doctor ID from token:', doctorId);
    console.log('Patient ID from request:', patientId);
    console.log('Consultation ID from request:', consultationId);
    
    if (!doctorId) {
      console.error('ERROR: Doctor ID not found in authentication token');
      return res.status(400).json({ 
        error: "Doctor ID not found. Please log in again." 
      });
    }

    if (!patientId || !consultationId || !items || !Array.isArray(items)) {
      console.error('ERROR: Missing required fields');
      return res.status(400).json({ 
        error: "Missing required fields: patientId, consultationId, and items array" 
      });
    }

    console.log('Starting transaction...');

    // Start transaction
    await db.query("START TRANSACTION");

    // ============================================
    // 1. VERIFY CONSULTATION EXISTS AND DOCTOR HAS PERMISSION
    // ============================================
    console.log('1. Verifying consultation access...');
    
    const [consultationCheck]: any = await db.query(`
      SELECT 
        c.ConsultationID, 
        c.DoctorID, 
        c.VisitID, 
        pv.PatientID,
        c.StartTime
      FROM consultation c
      JOIN patient_visit pv ON c.VisitID = pv.VisitID
      WHERE c.ConsultationID = ?
        AND pv.PatientID = ?
        AND c.DoctorID = ?
    `, [consultationId, patientId, doctorId]);
    
    console.log('Consultation check result:', consultationCheck);
    
    if (consultationCheck.length === 0) {
      console.error('Consultation not found or doctor does not have permission');
      await db.query("ROLLBACK");
      return res.status(404).json({ 
        error: "Consultation not found or you don't have permission to prescribe for this patient." 
      });
    }

    const consultationData = consultationCheck[0];
    console.log('Consultation verified:', consultationData);
    console.log('Visit ID:', consultationData.VisitID);

    // ============================================
    // 2. CREATE PRESCRIPTION HEADER
    // ============================================
    console.log('2. Creating prescription header...');
    
    const [prescriptionResult]: any = await db.query(`
      INSERT INTO prescription 
      (PrescribedDate, Remarks, DoctorID, PatientID, ConsultationID, VisitID)
      VALUES (CURDATE(), ?, ?, ?, ?, ?)
    `, [
      remarks, 
      doctorId, 
      patientId, 
      consultationId, 
      consultationData.VisitID
    ]);

    const prescriptionId = prescriptionResult.insertId;
    console.log('Created prescription ID:', prescriptionId);

    // ============================================
    // 3. INSERT PRESCRIPTION ITEMS
    // ============================================
    console.log('3. Inserting prescription items...');
    
    for (const item of items) {
      console.log('Processing item:', item);
      
      // Check if drug exists (but don't check stock - pharmacist handles that)
      const [drugCheck]: any = await db.query(
        'SELECT DrugID, DrugName, QuantityInStock FROM drug WHERE DrugID = ?',
        [item.DrugID]
      );

      if (drugCheck.length === 0) {
        await db.query("ROLLBACK");
        console.error('Drug not found:', item.DrugID);
        return res.status(400).json({ 
          error: `Drug with ID ${item.DrugID} not found` 
        });
      }

      const drug = drugCheck[0];
      console.log(`Drug found: ${drug.DrugName}, Stock: ${drug.QuantityInStock}`);
      
      // Check if drug is in stock (optional warning, not error)
      if (drug.QuantityInStock <= 0) {
        console.warn(`Warning: Drug ${drug.DrugName} is out of stock`);
      } else if (drug.QuantityInStock < (item.Quantity || 1)) {
        console.warn(`Warning: Insufficient stock for ${drug.DrugName}. Requested: ${item.Quantity}, Available: ${drug.QuantityInStock}`);
      }

      // Insert prescription item with status 'pending'
      const [itemResult]: any = await db.query(`
        INSERT INTO prescriptionitem 
        (PrescriptionID, DrugID, Dosage, Frequency, Duration, Quantity, Status, StatusUpdatedAt, StatusUpdatedBy)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW(), ?)
      `, [
        prescriptionId,
        item.DrugID,
        item.Dosage || '1',
        item.Frequency || 'once daily',
        item.Duration || '7 days',
        item.Quantity || 1,
        doctorId
      ]);

      console.log('Inserted prescription item ID:', itemResult.insertId);
      
      // NO inventory updates here - pharmacist handles dispensing
      // NO inventory log here - pharmacist handles when dispensing
    }

    // ============================================
    // 4. UPDATE CONSULTATION WITH PRESCRIPTION INFO (OPTIONAL)
    // ============================================
    console.log('4. Updating consultation with prescription info...');
    
    try {
      await db.query(`
        UPDATE consultation 
        SET 
          TreatmentPlan = CONCAT(
            IFNULL(TreatmentPlan, ''),
            '\n\n## Prescription Created\n',
            '- Prescription ID: ', ?, '\n',
            '- Date: ', CURDATE(), '\n',
            '- Items: ', ?
          ),
          UpdatedAt = NOW()
        WHERE ConsultationID = ?
      `, [
        prescriptionId,
        items.map(item => item.DrugName || `Drug ID ${item.DrugID}`).join(', '),
        consultationId
      ]);
      
      console.log('Consultation updated with prescription info');
    } catch (updateError) {
      console.warn('Could not update consultation:', updateError);
      // Continue anyway - this is not critical
    }

    // ============================================
    // 5. UPDATE PATIENT VISIT STATUS (OPTIONAL)
    // ============================================

    // ============================================
    // 6. COMMIT TRANSACTION
    // ============================================
    await db.query("COMMIT");

    console.log('=== SAVE PRESCRIPTION SUCCESS ===');
    console.log('Prescription ID:', prescriptionId);
    console.log('Number of items:', items.length);
    
    // ============================================
    // 7. GENERATE PHARMACY QUEUE NUMBER
    // ============================================
    console.log('7. Generating pharmacy queue number...');
    
    // Generate queue number for pharmacy (P-YYYYMMDD-XXX)
    const today = new Date();
    const dateString = today.getFullYear().toString().slice(-2) + 
                      String(today.getMonth() + 1).padStart(2, '0') + 
                      String(today.getDate()).padStart(2, '0');
    
    // Get today's prescription count for queue number
    const [prescriptionCount]: any = await db.query(`
      SELECT COUNT(*) as count 
      FROM prescription 
      WHERE DATE(PrescribedDate) = CURDATE()
    `);
    
    const queueNumber = `P-${dateString}-${String(prescriptionCount[0].count + 1).padStart(3, '0')}`;
    console.log('Pharmacy queue number:', queueNumber);
    
    // Store queue number in prescription
    await db.query(`
      UPDATE prescription 
      SET Remarks = CONCAT(IFNULL(Remarks, ''), '\nPharmacy Queue: ', ?, '\nTime: ', DATE_FORMAT(NOW(), '%r'))
      WHERE PrescriptionID = ?
    `, [queueNumber, prescriptionId]);

    res.status(201).json({
      success: true,
      message: "Prescription saved successfully",
      prescriptionId: prescriptionId,
      pharmacyQueue: queueNumber,
      itemsCount: items.length,
      consultationId: consultationId,
      visitId: consultationData.VisitID
    });

  } catch (error: any) {
    await db.query("ROLLBACK");
    console.error("=== SAVE PRESCRIPTION ERROR ===");
    console.error("Error:", error);
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);
    
    res.status(500).json({ 
      error: "Failed to save prescription",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      sqlMessage: error.sqlMessage
    });
  }
};

// Get prescription items for a patient
export const getPatientPrescriptions = async (req: Request, res: Response) => {
  try {
    const { patientId } = req.params;
    
    const [prescriptions]: any = await db.query(`
      SELECT 
        p.PrescriptionID,
        p.PrescribedDate,
        p.Remarks,
        u.Name as DoctorName,
        d.DrugName,
        pi.Dosage,
        pi.Frequency,
        pi.Duration,
        pi.Quantity,
        pi.Status,
        pi.StatusUpdatedAt,
        d.UnitPrice,
        (pi.Quantity * d.UnitPrice) as TotalAmount
      FROM prescription p
      JOIN prescriptionitem pi ON p.PrescriptionID = pi.PrescriptionID
      JOIN drug d ON pi.DrugID = d.DrugID
      JOIN useraccount u ON p.DoctorID = u.UserID
      WHERE p.PatientID = ?
      ORDER BY p.PrescribedDate DESC, p.PrescriptionID DESC
    `, [patientId]);

    res.json(prescriptions);
  } catch (error) {
    console.error("Error fetching prescriptions:", error);
    res.status(500).json({ error: "Failed to fetch prescriptions" });
  }
};

// Add this new function to doctorController.ts
export const getActiveConsultationByPatientDoctor = async (req: Request, res: Response) => {
  try {
    const { patientId, doctorId } = req.params;
    
    const [consultation]: any = await db.query(`
      SELECT c.*, pv.VisitID, pv.VisitStatus
      FROM consultation c
      JOIN patient_visit pv ON c.VisitID = pv.VisitID
      WHERE pv.PatientID = ?
        AND c.DoctorID = ?
        AND DATE(c.CreatedAt) = CURDATE()
      ORDER BY c.CreatedAt DESC
      LIMIT 1
    `, [patientId, doctorId]);
    
    if (consultation.length > 0) {
      res.json({
        success: true,
        consultation: consultation[0]
      });
    } else {
      res.json({
        success: false,
        message: "No active consultation found"
      });
    }
  } catch (error) {
    console.error("Get consultation error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to get consultation" 
    });
  }
};

// Add this function to your doctorController.ts
export const updateConsultation = async (req: Request, res: Response) => {
  console.log('=== UPDATE CONSULTATION ENDPOINT HIT ===');
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  
  try {
    const {
      consultationId,
      patientId,
      doctorId,
      chiefComplaint,
      historyOfPresentIllness,
      diagnosis,
      diagnosisCode,
      treatmentPlan,
      consultationNotes,
      followUpInstructions,
      followUpDate,
      physicalExamFindings,
      labTestsOrdered = false,
      referralGiven = false,
      severityAssessment,
      differentialDiagnosis,
      medicationPlan,
      nonMedicationPlan,
      patientEducation,
      lifestyleAdvice,
      warningSigns,
      disposition,
      referralNotes,
      pastMedicalHistory,
      familyHistory,
      needsFollowUp,
      followUpTime,
      followUpPurpose,
      referralNeeded
    } = req.body;
    
    console.log('Parsed consultationId:', consultationId);
    
    // Validate required fields
    if (!consultationId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: consultationId'
      });
    }

    const consultationIdNum = parseInt(consultationId);
    
    console.log('Starting transaction...');
    await db.query('START TRANSACTION');

    // ======================
    // 1. VERIFY CONSULTATION EXISTS AND BELONGS TO DOCTOR
    // ======================
    console.log('1. Verifying consultation exists...');
    
console.log('1. Verifying consultation exists...');

const [consultationCheck]: any = await db.query(`
  SELECT 
    c.ConsultationID, 
    c.DoctorID, 
    c.VisitID,
    pv.PatientID
  FROM consultation c
  JOIN patient_visit pv ON c.VisitID = pv.VisitID
  WHERE c.ConsultationID = ?
`, [consultationIdNum]);
    
    console.log('Consultation check result:', consultationCheck);
    
    if (consultationCheck.length === 0) {
      console.error('Consultation not found');
      await db.query('ROLLBACK');
      return res.status(404).json({ 
        success: false,
        error: "Consultation not found" 
      });
    }
    
    const existingConsultation = consultationCheck[0];
    
    // Verify doctor has permission to update this consultation
    if (doctorId && existingConsultation.DoctorID !== parseInt(doctorId)) {
      console.error('Doctor does not have permission to update this consultation');
      await db.query('ROLLBACK');
      return res.status(403).json({ 
        success: false,
        error: "You do not have permission to update this consultation" 
      });
    }
    
    console.log('Consultation verified, belongs to doctor:', existingConsultation.DoctorID);

    // ======================
    // 2. PARSE PHYSICAL EXAM FINDINGS
    // ======================
    let parsedPhysicalExamFindings = {};
    try {
      if (physicalExamFindings) {
        console.log('Physical exam findings raw:', physicalExamFindings);
        if (typeof physicalExamFindings === 'string') {
          parsedPhysicalExamFindings = JSON.parse(physicalExamFindings);
        } else if (typeof physicalExamFindings === 'object') {
          parsedPhysicalExamFindings = physicalExamFindings;
        }
        console.log('Parsed physical exam findings:', parsedPhysicalExamFindings);
      } else {
        console.log('No physical exam findings provided');
      }
    } catch (parseError) {
      console.warn('Could not parse physicalExamFindings:', parseError);
      parsedPhysicalExamFindings = {};
    }

    // ======================
    // 3. UPDATE CONSULTATION
    // ======================
    console.log('3. Updating consultation...');
    
    const updateQuery = `
      UPDATE consultation 
      SET 
        ChiefComplaint = COALESCE(?, ChiefComplaint),
        HistoryOfPresentIllness = COALESCE(?, HistoryOfPresentIllness),
        PhysicalExamFindings = COALESCE(?, PhysicalExamFindings),
        Diagnosis = COALESCE(?, Diagnosis),
        DiagnosisCode = COALESCE(?, DiagnosisCode),
        TreatmentPlan = COALESCE(?, TreatmentPlan),
        LabTestsOrdered = COALESCE(?, LabTestsOrdered),
        ReferralGiven = COALESCE(?, ReferralGiven),
        FollowUpDate = COALESCE(?, FollowUpDate),
        FollowUpInstructions = COALESCE(?, FollowUpInstructions),
        ConsultationNotes = COALESCE(?, ConsultationNotes),
        SeverityAssessment = COALESCE(?, SeverityAssessment),
        MedicationPlan = COALESCE(?, MedicationPlan),
        NonMedicationPlan = COALESCE(?, NonMedicationPlan),
        PatientEducation = COALESCE(?, PatientEducation),
        LifestyleAdvice = COALESCE(?, LifestyleAdvice),
        WarningSigns = COALESCE(?, WarningSigns),
        Disposition = COALESCE(?, Disposition),
        ReferralNotes = COALESCE(?, ReferralNotes),
        PastMedicalHistory = COALESCE(?, PastMedicalHistory),
        FamilyHistory = COALESCE(?, FamilyHistory),
        DifferentialDiagnosis = COALESCE(?, DifferentialDiagnosis),
        NeedsFollowUp = COALESCE(?, NeedsFollowUp),
        FollowUpTime = COALESCE(?, FollowUpTime),
        FollowUpPurpose = COALESCE(?, FollowUpPurpose),
        ReferralNeeded = COALESCE(?, ReferralNeeded),
        UpdatedAt = NOW()
      WHERE ConsultationID = ?
    `;
    
    const updateParams = [
      chiefComplaint || null,
      historyOfPresentIllness || null,
      JSON.stringify(parsedPhysicalExamFindings) || null,
      diagnosis || null,
      diagnosisCode || null,
      treatmentPlan || null,
      labTestsOrdered ? 1 : 0,
      referralGiven ? 1 : 0,
      followUpDate || null,
      followUpInstructions || null,
      consultationNotes || null,
      severityAssessment || null,
      medicationPlan || null,
      nonMedicationPlan || null,
      patientEducation || null,
      lifestyleAdvice || null,
      warningSigns || null,
      disposition || null,
      referralNotes || null,
      pastMedicalHistory || null,
      familyHistory || null,
      differentialDiagnosis || null,
      needsFollowUp ? 1 : 0,
      followUpTime || null,
      followUpPurpose || null,
      referralNeeded ? 1 : 0,
      consultationIdNum
    ];
    
    console.log('Update query:', updateQuery);
    console.log('Update params:', updateParams);
    
    const [updateResult]: any = await db.query(updateQuery, updateParams);
    
    console.log('Update result:', updateResult);
    console.log('Rows affected:', updateResult.affectedRows);

    // ======================
    // 4. UPDATE MEDICAL HISTORY ENTRY FOR DIAGNOSIS
    // ======================
    if (diagnosis && diagnosis.trim()) {
      console.log('4. Updating medical history for diagnosis:', diagnosis);
      const currentDate = new Date().toISOString().split('T')[0];
      
      // Check if this diagnosis is already in medical history for this consultation
      const [existingHistory]: any = await db.query(`
        SELECT HistoryID FROM medical_history 
        WHERE PatientID = ? 
          AND ConsultationID = ?
          AND RecordType = 'condition'
          AND RecordName = ?
      `, [existingConsultation.PatientID, consultationIdNum, diagnosis]);

      console.log('Existing medical history found:', existingHistory.length);
      
      if (existingHistory.length > 0) {
        // Update existing medical history entry
        console.log('Updating existing medical history entry');
        await db.query(`
          UPDATE medical_history 
          SET 
            RecordName = ?,
            Description = ?,
            Severity = COALESCE(?, Severity),
            Notes = COALESCE(?, Notes),
            UpdatedAt = NOW()
          WHERE HistoryID = ?
        `, [
          diagnosis,
          `Primary diagnosis: ${diagnosis}\nCode: ${diagnosisCode || 'N/A'}`,
          severityAssessment || null,
          consultationNotes || null,
          existingHistory[0].HistoryID
        ]);
        console.log('Medical history entry updated');
      } else {
        // Create new medical history entry if diagnosis changed
        console.log('Creating new medical history entry for updated diagnosis');
        await db.query(`
          INSERT INTO medical_history 
          (PatientID, ConsultationID, VisitID, RecordType, RecordName, 
           Description, Status, StartDate, Severity, Notes, CreatedBy, CreatedAt)
          VALUES (?, ?, ?, 'condition', ?, ?, 'active', ?, ?, ?, ?, NOW())
        `, [
          existingConsultation.PatientID,
          consultationIdNum,
          existingConsultation.VisitID,
          diagnosis,
          `Primary diagnosis: ${diagnosis}\nCode: ${diagnosisCode || 'N/A'}`,
          currentDate,
          severityAssessment || 'moderate',
          consultationNotes || null,
          existingConsultation.DoctorID
        ]);
        console.log('New medical history entry created');
      }
    }

    // ======================
    // 5. UPDATE/CREATE REFERRAL IF NEEDED
    // ======================
    if (referralGiven && referralNotes) {
      console.log('5. Creating/updating referral');
      // Check if referral already exists for this consultation
      const [existingReferral]: any = await db.query(`
        SELECT ReferralID FROM referral 
        WHERE ConsultationID = ?
      `, [consultationIdNum]);
      
      if (existingReferral.length === 0) {
        // Create new referral
        console.log('Creating new referral');
        await db.query(`
          INSERT INTO referral 
          (DoctorID, PatientID, ConsultationID, Reason, Urgency, 
           ReferralDate, Status, Specialty)
          VALUES (?, ?, ?, ?, 'routine', NOW(), 'pending', 'General')
        `, [existingConsultation.DoctorID, existingConsultation.PatientID, consultationIdNum, referralNotes]);
        console.log('Referral record created');
      } else {
        // Update existing referral
        console.log('Updating existing referral');
        await db.query(`
          UPDATE referral 
          SET 
            Reason = ?,
            UpdatedAt = NOW()
          WHERE ReferralID = ?
        `, [referralNotes, existingReferral[0].ReferralID]);
        console.log('Referral record updated');
      }
    }

    // ======================
    // 6. COMMIT TRANSACTION
    // ======================
    await db.query('COMMIT');
    console.log('Transaction committed successfully');

    // ======================
    // 7. FETCH UPDATED CONSULTATION DETAILS
    // ======================
    console.log('7. Fetching updated consultation details');
    const [updatedConsultation]: any = await db.query(`
      SELECT 
        c.*,
        pv.VisitID,
        pv.VisitStatus,
        pv.QueueStatus
      FROM consultation c
      JOIN patient_visit pv ON c.VisitID = pv.VisitID
      WHERE c.ConsultationID = ?
    `, [consultationIdNum]);
    
    console.log('Updated consultation:', updatedConsultation[0]);
    
    const responseData = { 
      success: true,
      message: "Consultation updated successfully",
      consultationId: consultationIdNum,
      consultation: updatedConsultation[0] || null
    };
    
    console.log('Sending response:', responseData);
    
    res.json(responseData);
    
    console.log('=== UPDATE CONSULTATION SUCCESS ===');
    
  } catch (error: any) {
    console.error('UPDATE CONSULTATION ERROR:', error);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('SQL error:', error.sqlMessage);
    
    try {
      await db.query('ROLLBACK');
      console.log('Transaction rolled back');
    } catch (rollbackError) {
      console.error('Rollback error:', rollbackError);
    }

    res.status(500).json({ 
      success: false,
      error: "Failed to update consultation",
      message: error.message,
      sqlMessage: error.sqlMessage || 'No SQL error'
    });
  }
};

// In your backend (e.g., doctor.routes.js)

// Add these functions to your doctorController.ts file

// Get patient visits with doctor name
export const getPatientVisitsD = async (req: Request, res: Response) => {
  try {
    const { patientId } = req.params;
    
    const visits = await db.query(`
      SELECT 
        pv.VisitID,
        pv.AppointmentID,
        pv.PatientID,
        pv.DoctorID,
        pv.VisitType,
        pv.ArrivalTime,
        pv.CheckInTime,
        pv.CheckOutTime,
        pv.VisitStatus,
        pv.VisitNotes,
        pv.QueueNumber,
        pv.TriagePriority,
        u.Name AS DoctorName,
        c.ConsultationID,
        a.Purpose
      FROM patient_visit pv
      LEFT JOIN useraccount u ON pv.DoctorID = u.UserID
      LEFT JOIN consultation c ON pv.VisitID = c.VisitID
      LEFT JOIN appointment a ON pv.AppointmentID = a.AppointmentID
      WHERE pv.PatientID = ?
      ORDER BY pv.ArrivalTime DESC
    `, [patientId]);
    
    res.json(visits);
  } catch (error) {
    console.error('Error fetching visits:', error);
    res.status(500).json({ error: 'Failed to fetch visits' });
  }
};

// Get patient consultations with all details
// Get patient consultations with all details - FIXED VERSION
export const getPatientConsultationsD = async (req: Request, res: Response) => {
  try {
    const { patientId } = req.params;
    
    const consultations = await db.query(`
      SELECT 
        c.ConsultationID,
        c.VisitID,
        c.DoctorID,
        c.StartTime,
        c.EndTime,
        c.ChiefComplaint,
        c.HistoryOfPresentIllness,
        c.PhysicalExamFindings,
        c.Diagnosis,
        c.DiagnosisCode,
        c.TreatmentPlan,
        c.ConsultationNotes,
        c.SeverityAssessment,
        c.FollowUpDate,
        c.FollowUpInstructions,
        c.MedicationPlan,
        c.NonMedicationPlan,
        c.PatientEducation,
        c.LifestyleAdvice,
        c.WarningSigns,
        c.Disposition,
        c.ReferralNotes,
        c.PastMedicalHistory,
        c.FamilyHistory,
        c.DifferentialDiagnosis,
        c.NeedsFollowUp,
        c.FollowUpTime,
        c.FollowUpPurpose,
        c.ReferralNeeded,
        c.CreatedAt,
        c.UpdatedAt,
        -- Doctor information
        u.Name AS DoctorName,
        dp.Specialization AS DoctorSpecialization,
        -- Visit information
        pv.VisitID,
        pv.VisitType,
        pv.VisitStatus,
        pv.ArrivalTime AS VisitDate,
        -- Vital signs data
        vs.VitalSignID,
        vs.Temperature,
        vs.BloodPressureSystolic,
        vs.BloodPressureDiastolic,
        vs.HeartRate,
        vs.RespiratoryRate,
        vs.OxygenSaturation,
        vs.Height,
        vs.Weight,
        vs.BMI,
        vs.PainLevel,
        vs.TakenAt AS VitalSignsTakenAt,
        vs.TakenBy AS VitalSignsTakenBy,
        -- Prescription count
        (SELECT COUNT(*) FROM prescription pr WHERE pr.ConsultationID = c.ConsultationID) AS PrescriptionCount,
        -- Allergy count
        (SELECT COUNT(*) FROM allergy_findings af WHERE af.ConsultationID = c.ConsultationID) AS AllergyCount
      FROM consultation c
      -- Join with doctor information
      LEFT JOIN useraccount u ON c.DoctorID = u.UserID
      LEFT JOIN doctorprofile dp ON c.DoctorID = dp.DoctorID
      -- Join with patient_visit to get patient context
      LEFT JOIN patient_visit pv ON c.VisitID = pv.VisitID
      -- Join with vital signs
      LEFT JOIN vital_signs vs ON c.ConsultationID = vs.ConsultationID
      WHERE pv.PatientID = ? OR c.ConsultationID IN (
        SELECT DISTINCT c2.ConsultationID 
        FROM consultation c2
        JOIN patient_visit pv2 ON c2.VisitID = pv2.VisitID
        WHERE pv2.PatientID = ?
      )
      ORDER BY COALESCE(c.StartTime, c.CreatedAt) DESC
    `, [patientId, patientId]);
    
    // Process the results to handle multiple vital signs entries
    const consultationMap = new Map();
    
    consultations.forEach((consultation: any) => {
      const consultId = consultation.ConsultationID;
      
      if (!consultationMap.has(consultId)) {
        // First time seeing this consultation
        consultationMap.set(consultId, {
          ...consultation,
          vitalSigns: consultation.Temperature ? [{
            Temperature: consultation.Temperature,
            BloodPressureSystolic: consultation.BloodPressureSystolic,
            BloodPressureDiastolic: consultation.BloodPressureDiastolic,
            HeartRate: consultation.HeartRate,
            RespiratoryRate: consultation.RespiratoryRate,
            OxygenSaturation: consultation.OxygenSaturation,
            Height: consultation.Height,
            Weight: consultation.Weight,
            BMI: consultation.BMI,
            PainLevel: consultation.PainLevel,
            TakenAt: consultation.VitalSignsTakenAt
          }] : []
        });
      } else if (consultation.Temperature) {
        // Add additional vital signs entry
        const existing = consultationMap.get(consultId);
        existing.vitalSigns.push({
          Temperature: consultation.Temperature,
          BloodPressureSystolic: consultation.BloodPressureSystolic,
          BloodPressureDiastolic: consultation.BloodPressureDiastolic,
          HeartRate: consultation.HeartRate,
          RespiratoryRate: consultation.RespiratoryRate,
          OxygenSaturation: consultation.OxygenSaturation,
          Height: consultation.Height,
          Weight: consultation.Weight,
          BMI: consultation.BMI,
          PainLevel: consultation.PainLevel,
          TakenAt: consultation.VitalSignsTakenAt
        });
      }
    });
    
    // Convert map back to array and remove duplicate vital signs fields
    const processedConsultations = Array.from(consultationMap.values()).map((consult: any) => {
      const { 
        VitalSignID, Temperature, BloodPressureSystolic, BloodPressureDiastolic, 
        HeartRate, RespiratoryRate, OxygenSaturation, Height, Weight, BMI, 
        PainLevel, VitalSignsTakenAt, VitalSignsTakenBy, ...rest 
      } = consult;
      
      return {
        ...rest,
        // If there are multiple vital signs, use the most recent one for display
        Temperature: consult.vitalSigns.length > 0 ? consult.vitalSigns[0].Temperature : null,
        BloodPressureSystolic: consult.vitalSigns.length > 0 ? consult.vitalSigns[0].BloodPressureSystolic : null,
        BloodPressureDiastolic: consult.vitalSigns.length > 0 ? consult.vitalSigns[0].BloodPressureDiastolic : null,
        HeartRate: consult.vitalSigns.length > 0 ? consult.vitalSigns[0].HeartRate : null,
        RespiratoryRate: consult.vitalSigns.length > 0 ? consult.vitalSigns[0].RespiratoryRate : null,
        OxygenSaturation: consult.vitalSigns.length > 0 ? consult.vitalSigns[0].OxygenSaturation : null,
        Height: consult.vitalSigns.length > 0 ? consult.vitalSigns[0].Height : null,
        Weight: consult.vitalSigns.length > 0 ? consult.vitalSigns[0].Weight : null,
        BMI: consult.vitalSigns.length > 0 ? consult.vitalSigns[0].BMI : null,
        PainLevel: consult.vitalSigns.length > 0 ? consult.vitalSigns[0].PainLevel : null,
        VitalSignsTakenAt: consult.vitalSigns.length > 0 ? consult.vitalSigns[0].TakenAt : null,
        allVitalSigns: consult.vitalSigns // Keep all vital signs for detailed view
      };
    });
    
    res.json(processedConsultations);
  } catch (error) {
    console.error('Error fetching consultations:', error);
    res.status(500).json({ error: 'Failed to fetch consultations' });
  }
};

export const getPatientPrescriptionsD = async (req: Request, res: Response) => {
  try {
    const { patientId } = req.params;
    
    console.log(`Fetching prescriptions for patient ID: ${patientId}`);
    
    // Get prescriptions with detailed information
    const prescriptionsQuery = `
      SELECT 
        p.PrescriptionID,
        p.PrescribedDate,
        p.Remarks,
        p.Status,
        u.Name AS DoctorName,
        c.ConsultationID,
        c.Diagnosis,
        p.PatientID,
        p.DoctorID
      FROM prescription p
      LEFT JOIN useraccount u ON p.DoctorID = u.UserID
      LEFT JOIN consultation c ON p.ConsultationID = c.ConsultationID
      WHERE p.PatientID = ?
      ORDER BY p.PrescribedDate DESC
    `;
    
    // Assuming db.query returns [rows, fields] structure
    const [prescriptionsResult] = await db.query(prescriptionsQuery, [patientId]) as any;
    
    // Type cast to array of prescriptions
    const prescriptionsArray = prescriptionsResult as Array<{
      PrescriptionID: number;
      PrescribedDate: string;
      Remarks: string;
      Status: string;
      DoctorName: string;
      ConsultationID: number;
      Diagnosis: string;
      PatientID: number;
      DoctorID: number;
    }>;
    
    console.log(`Found ${prescriptionsArray.length} prescriptions for patient ${patientId}`);
    
    // Get items for all prescriptions in one query (more efficient)
    const prescriptionIds = prescriptionsArray.map(p => p.PrescriptionID);
    
    let itemsArray: Array<{
      ItemID: number;
      PrescriptionID: number;
      Dosage: string;
      Frequency: string;
      Duration: string;
      Quantity: number;
      Status: string;
      DrugID: number;
      DrugName: string;
      Category: string;
    }> = [];
    
    if (prescriptionIds.length > 0) {
      const placeholders = prescriptionIds.map(() => '?').join(',');
      const itemsQuery = `
        SELECT 
          pi.ItemID,
          pi.PrescriptionID,
          pi.Dosage,
          pi.Frequency,
          pi.Duration,
          pi.Quantity,
          pi.Status,
          d.DrugID,
          d.DrugName,
          d.Category
        FROM prescriptionitem pi
        LEFT JOIN drug d ON pi.DrugID = d.DrugID
        WHERE pi.PrescriptionID IN (${placeholders})
        ORDER BY pi.PrescriptionID, pi.ItemID
      `;
      
      const [itemsResult] = await db.query(itemsQuery, prescriptionIds) as any;
      itemsArray = itemsResult as Array<{
        ItemID: number;
        PrescriptionID: number;
        Dosage: string;
        Frequency: string;
        Duration: string;
        Quantity: number;
        Status: string;
        DrugID: number;
        DrugName: string;
        Category: string;
      }>;
    }
    
    console.log(`Found ${itemsArray.length} prescription items total`);
    
    // Group items by prescription ID
    const itemsByPrescription: Record<number, Array<any>> = {};
    itemsArray.forEach(item => {
      if (!itemsByPrescription[item.PrescriptionID]) {
        itemsByPrescription[item.PrescriptionID] = [];
      }
      itemsByPrescription[item.PrescriptionID].push({
        ItemID: item.ItemID,
        DrugID: item.DrugID,
        DrugName: item.DrugName,
        Category: item.Category,
        Dosage: item.Dosage,
        Frequency: item.Frequency,
        Duration: item.Duration,
        Quantity: item.Quantity,
        Status: item.Status
      });
    });
    
    // Combine prescriptions with their items
    const prescriptions = prescriptionsArray.map(prescription => {
      const items = itemsByPrescription[prescription.PrescriptionID] || [];
      
      console.log(`Prescription ${prescription.PrescriptionID} has ${items.length} items`);
      if (items.length > 0) {
        console.log(`Items for prescription ${prescription.PrescriptionID}:`, items);
      }
      
      return {
        PrescriptionID: prescription.PrescriptionID,
        PrescribedDate: prescription.PrescribedDate,
        Remarks: prescription.Remarks,
        Status: prescription.Status,
        DoctorName: prescription.DoctorName,
        ConsultationID: prescription.ConsultationID,
        Diagnosis: prescription.Diagnosis,
        PatientID: prescription.PatientID,
        items: items
      };
    });
    
    // Debug: Log the final structure
    console.log(`Final prescription count: ${prescriptions.length}`);
    prescriptions.forEach((p, idx) => {
      console.log(`Prescription ${idx} (ID: ${p.PrescriptionID}): ${p.items?.length || 0} items`);
    });
    
    res.json(prescriptions);
  } catch (error) {
    console.error('Error fetching prescriptions:', error);
    res.status(500).json({ 
      error: 'Failed to fetch prescriptions',
      details: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
  }
};

// Get patient allergies
// Get patient allergies
export const getPatientAllergiesD = async (req: Request, res: Response) => {
  try {
    const { patientId } = req.params;
    
    console.log(`Fetching allergies for patient ID: ${patientId}`);
    
    // Extract rows properly from the query result
    const [allergiesResult] = await db.query(`
      SELECT 
        af.AllergyFindingID,
        af.AllergyName,
        af.Reaction,
        af.Severity,
        af.OnsetDate,
        af.Status,
        af.Notes,
        af.ConsultationID
      FROM allergy_findings af
      INNER JOIN consultation c ON af.ConsultationID = c.ConsultationID
      INNER JOIN patient_visit pv ON c.VisitID = pv.VisitID
      WHERE pv.PatientID = ?
      ORDER BY 
        CASE 
          WHEN af.Severity = 'life-threatening' THEN 1
          WHEN af.Severity = 'severe' THEN 2
          WHEN af.Severity = 'moderate' THEN 3
          WHEN af.Severity = 'mild' THEN 4
          ELSE 5
        END,
        af.OnsetDate DESC
    `, [patientId]) as any;
    
    // Cast to the proper type
    const allergies = allergiesResult as Array<{
      AllergyFindingID: number;
      AllergyName: string;
      Reaction: string;
      Severity: 'mild' | 'moderate' | 'severe' | 'life-threatening';
      OnsetDate: string;
      Status: 'active' | 'resolved' | 'unknown';
      Notes: string;
      ConsultationID: number;
    }>;
    
    console.log(`Found ${allergies.length} allergies for patient ${patientId}`);
    
    res.json(allergies);
  } catch (error) {
    console.error('Error fetching allergies:', error);
    res.status(500).json({ 
      error: 'Failed to fetch allergies',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

// Get all patients
export const getAllPatients2 = async (req: Request, res: Response) => {
  try {
    const [patients] = await db.query(`
      SELECT 
        p.PatientID,
        p.Name,
        p.ICNo,
        p.Gender,
        p.DOB,
        p.PhoneNumber,
        p.Email,
        p.BloodType,
        p.ChronicDisease,
        p.Allergy,
        p.InsuranceProvider,
        p.InsurancePolicyNo,
        MAX(pv.CheckInTime) AS LastVisit
      FROM patient p
      LEFT JOIN patient_visit pv ON p.PatientID = pv.PatientID
      GROUP BY p.PatientID
      ORDER BY p.Name
    `) as any;

    res.json(patients);
  } catch (error) {
    console.error('Error fetching patients:', error);
    res.status(500).json({ error: 'Failed to fetch patients' });
  }
};

// Get patient consultations
export const getPatientConsultations = async (req: Request, res: Response) => {
  try {
    const { patientId } = req.params;
    
    const [consultations] = await db.query(`
      SELECT 
        c.ConsultationID,
        c.VisitID,
        c.StartTime,
        c.ChiefComplaint,
        c.Diagnosis,
        c.DiagnosisCode,
        c.SeverityAssessment,
        u.Name AS DoctorName,
        pv.VisitType
      FROM consultation c
      LEFT JOIN useraccount u ON c.DoctorID = u.UserID
      LEFT JOIN patient_visit pv ON c.VisitID = pv.VisitID
      WHERE pv.PatientID = ?
      ORDER BY c.StartTime DESC
      LIMIT 10
    `, [patientId]) as any;

    res.json(consultations);
  } catch (error) {
    console.error('Error fetching consultations:', error);
    res.status(500).json({ error: 'Failed to fetch consultations' });
  }
};

// Get total consultations count for the doctor
export const getDoctorConsultationsCount = async (req: Request, res: Response) => {
  try {
    const doctorId = (req as any).user.userId;
    
    const [result] = await db.query(`
      SELECT COUNT(*) as total
      FROM consultation c
      WHERE c.DoctorID = ?
    `, [doctorId]) as any;
    
    res.json({ total: result[0]?.total || 0 });
  } catch (error) {
    console.error('Error fetching consultations count:', error);
    res.status(500).json({ error: 'Failed to fetch consultations count' });
  }
};

// Get total prescriptions count for the doctor
export const getDoctorPrescriptionsCount = async (req: Request, res: Response) => {
  try {
    const doctorId = (req as any).user.userId;
    
    const [result] = await db.query(`
      SELECT COUNT(*) as total
      FROM prescription p
      WHERE p.DoctorID = ?
    `, [doctorId]) as any;
    
    res.json({ total: result[0]?.total || 0 });
  } catch (error) {
    console.error('Error fetching prescriptions count:', error);
    res.status(500).json({ error: 'Failed to fetch prescriptions count' });
  }
};

// Get patients with appointments count
export const getDoctorPatientsWithAppointmentsCount = async (req: Request, res: Response) => {
  try {
    const doctorId = (req as any).user.userId;
    
    const [result] = await db.query(`
      SELECT COUNT(DISTINCT a.PatientID) as total
      FROM appointment a
      WHERE a.DoctorID = ? 
        AND a.Status IN ('scheduled', 'confirmed')
        AND a.AppointmentDateTime >= CURDATE()
    `, [doctorId]) as any;
    
    res.json({ total: result[0]?.total || 0 });
  } catch (error) {
    console.error('Error fetching patients with appointments count:', error);
    res.status(500).json({ error: 'Failed to fetch patients with appointments count' });
  }
};

// Add this function to your doctor controller
// In your backend prescription controller
export const getPrescriptionsByConsultation = async (req: Request, res: Response) => {
  try {
    const consultationId = req.params.consultationId;
    
    console.log('=== DEBUG: Fetching prescriptions for consultation:', consultationId);
    
    // Check if consultationId is valid
    if (!consultationId || isNaN(Number(consultationId))) {
      console.error('Invalid consultation ID:', consultationId);
      return res.status(400).json({ error: "Invalid consultation ID" });
    }
    
    // First, let's check what's in the database
    console.log('=== DEBUG: Checking prescription table structure');
    
    // Simple test query first
    const [testResult] = await db.query<RowDataPacket[]>(`
      SELECT 
        p.PrescriptionID,
        p.ConsultationID,
        p.PrescribedDate,
        p.Status
      FROM prescription p
      WHERE p.ConsultationID = ?
      LIMIT 1
    `, [consultationId]);
    
    console.log('=== DEBUG: Test query result:', testResult);
    
    // If no prescriptions found, return empty array
    if (!testResult || testResult.length === 0) {
      console.log('=== DEBUG: No prescriptions found for consultation:', consultationId);
      return res.json([]);
    }
    
    // Now run the full query
    console.log('=== DEBUG: Running full prescription query');
    
    const [prescriptions] = await db.query<RowDataPacket[]>(`
      SELECT 
        p.PrescriptionID,
        p.PrescribedDate,
        p.Status,
        pi.ItemID,
        pi.DrugID,
        d.DrugName,
        d.BarcodeID as DrugCode,
        pi.Dosage,
        pi.Frequency,
        pi.Duration,
        pi.Quantity,
        d.UnitPrice,
        (pi.Quantity * d.UnitPrice) as TotalPrice
      FROM prescription p
      LEFT JOIN prescriptionitem pi ON p.PrescriptionID = pi.PrescriptionID
      LEFT JOIN drug d ON pi.DrugID = d.DrugID
      WHERE p.ConsultationID = ?
      ORDER BY p.PrescribedDate DESC, pi.ItemID ASC
    `, [consultationId]);
    
    console.log('=== DEBUG: Raw query result count:', prescriptions.length);
    console.log('=== DEBUG: First item:', prescriptions[0]);
    
    // Group by prescription
    const groupedPrescriptions: Record<number, any> = {};
    
    prescriptions.forEach((item: any) => {
      const key = item.PrescriptionID;
      
      if (!groupedPrescriptions[key]) {
        groupedPrescriptions[key] = {
          PrescriptionID: item.PrescriptionID,
          PrescribedDate: item.PrescribedDate,
          Status: item.Status,
          items: []
        };
      }
      
      if (item.ItemID) { // Only add if there are items
        groupedPrescriptions[key].items.push({
          ItemID: item.ItemID,
          DrugID: item.DrugID,
          DrugName: item.DrugName,
          DrugCode: item.DrugCode,
          Dosage: item.Dosage,
          Frequency: item.Frequency,
          Duration: item.Duration,
          Quantity: item.Quantity,
          UnitPrice: item.UnitPrice,
          TotalPrice: item.TotalPrice
        });
      }
    });
    
    const result = Object.values(groupedPrescriptions);
    console.log('=== DEBUG: Final result count:', result.length);
    
    res.json(result);
    
  } catch (error: any) {
    console.error("=== ERROR: Failed to fetch prescriptions:", error);
    console.error("SQL Error code:", error.code);
    console.error("SQL Error message:", error.sqlMessage);
    console.error("Full error stack:", error.stack);
    
    res.status(500).json({ 
      error: "Failed to fetch prescriptions",
      message: error.message,
      code: error.code,
      sqlMessage: error.sqlMessage
    });
  }
};