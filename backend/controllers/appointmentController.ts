// controllers/appointmentController.ts - UPDATED VERSION
import { Request, Response } from "express";
import { db } from "../db";

// Time slots for availability checking
const TIME_SLOTS = [
  '08:00', '08:30', '09:00', '09:30', '10:00', '10:30',
  '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
  '14:00', '14:30', '15:00', '15:30', '16:00', '16:30',
  '17:00', '17:30', '18:00'
];

// ============ DOCTOR AVAILABILITY ============

// In your appointmentController.ts - Update the time slot checking logic
export const getDoctorAvailability = async (req: Request, res: Response) => {
  const { doctorId, date } = req.query;
  
  try {
    if (!doctorId || !date) {
      return res.status(400).json({ 
        success: false,
        error: "Missing doctor ID or date" 
      });
    }
    
    console.log('=== Doctor Availability Request ===');
    console.log('Doctor ID:', doctorId, 'Date:', date);
    
    // Get all appointments for this doctor on the selected date
    const [appointments]: any = await db.query(`
      SELECT 
        AppointmentID,
        start_time,
        end_time,
        Status,
        p.Name as patientName,
        Purpose
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      WHERE DoctorID = ? 
        AND DATE(AppointmentDateTime) = ?
        AND Status NOT IN ('cancelled', 'no-show')
      ORDER BY start_time ASC
    `, [doctorId, date]);
    
    console.log(`Found ${appointments.length} appointments:`, appointments);
    
    // Simple approach: Mark any slot that starts during an appointment as unavailable
    const availableSlots = TIME_SLOTS.filter(timeSlot => {
      // For each time slot, check if it falls within any appointment
      const isBooked = appointments.some((apt: any) => {
        if (!apt.start_time || !apt.end_time) return false;
        
        const slotTime = timeSlot; // e.g., "09:00"
        const startTime = apt.start_time; // e.g., "09:00:00" or "09:00"
        const endTime = apt.end_time; // e.g., "09:30:00" or "09:30"
        
        // Normalize times by removing seconds if present
        const normalizedSlot = slotTime.length === 5 ? slotTime : slotTime.substring(0, 5);
        const normalizedStart = startTime.length === 8 ? startTime.substring(0, 5) : startTime;
        const normalizedEnd = endTime.length === 8 ? endTime.substring(0, 5) : endTime;
        
        console.log(`Checking slot ${normalizedSlot} against appointment ${normalizedStart}-${normalizedEnd}`);
        
        // Slot is booked if it's exactly at the start time OR if it's between start and end
        return normalizedSlot >= normalizedStart && normalizedSlot < normalizedEnd;
      });
      
      return !isBooked;
    });
    
    console.log('Available slots:', availableSlots);
    console.log('Total TIME_SLOTS:', TIME_SLOTS.length);
    console.log('Booked appointments:', appointments.length);
    
    // Format booked slots for display
    const bookedSlots = appointments.map((apt: any) => ({
      appointmentId: apt.AppointmentID,
      start: apt.start_time?.substring(0, 5) || apt.start_time, // Format to HH:MM
      end: apt.end_time?.substring(0, 5) || apt.end_time, // Format to HH:MM
      status: apt.Status,
      patientName: apt.patientName,
      purpose: apt.Purpose
    }));
    
    res.json({ 
      success: true,
      doctorId,
      date,
      bookedSlots,
      availableSlots,
      timeSlots: TIME_SLOTS
    });
    
  } catch (error: any) {
    console.error("Get doctor availability error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to get doctor availability"
    });
  }
};

// 2. Check specific time slot availability
export const checkTimeSlotAvailability = async (req: Request, res: Response) => {
  const { doctorId, date, startTime, endTime, appointmentId } = req.body;
  
  try {
    if (!doctorId || !date || !startTime || !endTime) {
      return res.status(400).json({ 
        success: false,
        error: "Missing required fields" 
      });
    }
    
    // Check for scheduling conflicts (excluding the current appointment if editing)
    let query = `
      SELECT 
        a.AppointmentID,
        p.Name as patientName,
        start_time,
        end_time,
        Status
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      WHERE DoctorID = ? 
        AND DATE(AppointmentDateTime) = ?
        AND Status NOT IN ('cancelled', 'no-show')
        AND (
          (start_time < ? AND end_time > ?) OR
          (start_time >= ? AND start_time < ?) OR
          (? >= start_time AND ? < end_time)
        )
    `;
    
    const params: any[] = [
      doctorId,
      date,
      endTime, startTime,
      startTime, endTime,
      startTime, endTime
    ];
    
    if (appointmentId) {
      query += " AND AppointmentID != ?";
      params.push(appointmentId);
    }
    
    query += " LIMIT 1";
    
    const [conflicts]: any = await db.query(query, params);
    
    const isAvailable = conflicts.length === 0;
    
    res.json({ 
      success: true,
      isAvailable,
      conflicts: conflicts.length > 0 ? conflicts[0] : null,
      message: isAvailable ? "Time slot is available" : "Time slot is already booked"
    });
    
  } catch (error: any) {
    console.error("Check time slot availability error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to check time slot availability"
    });
  }
};

// ============ APPOINTMENT SCHEDULING WITH AVAILABILITY CHECK ============

// 3. Schedule new appointment with availability check
export const scheduleAppointment = async (req: Request, res: Response) => {
  const { 
    patientId, 
    doctorId, 
    appointmentDateTime, 
    startTime, 
    endTime, 
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
    
    // Validate time range
    if (!startTime || !endTime) {
      return res.status(400).json({ 
        success: false,
        error: "Start time and end time are required" 
      });
    }
    
    if (startTime >= endTime) {
      return res.status(400).json({ 
        success: false,
        error: "End time must be after start time" 
      });
    }
    
    // Parse the date from appointmentDateTime
    const appointmentDate = new Date(appointmentDateTime).toISOString().split('T')[0];
    
    await db.query("START TRANSACTION");
    
    // Enhanced conflict detection with detailed error message
    const [conflicts]: any = await db.query(`
      SELECT 
        AppointmentID,
        p.Name as patientName,
        start_time,
        end_time,
        Status,
        a.Purpose
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      WHERE DoctorID = ? 
        AND DATE(AppointmentDateTime) = ?
        AND Status NOT IN ('cancelled', 'no-show')
        AND (
          (start_time < ? AND end_time > ?) OR
          (start_time >= ? AND start_time < ?) OR
          (? >= start_time AND ? < end_time)
        )
      LIMIT 1
    `, [
      doctorId,
      appointmentDate,
      endTime, startTime,
      startTime, endTime,
      startTime, endTime
    ]);
    
    if (conflicts.length > 0) {
      const conflict = conflicts[0];
      await db.query("ROLLBACK");
      
      // Calculate overlap details
      const conflictStart = new Date(`1970-01-01T${conflict.start_time}`);
      const conflictEnd = new Date(`1970-01-01T${conflict.end_time}`);
      const requestedStart = new Date(`1970-01-01T${startTime}`);
      const requestedEnd = new Date(`1970-01-01T${endTime}`);
      
      let overlapMessage = "Time slot overlaps with existing appointment";
      
      if (requestedStart >= conflictStart && requestedStart < conflictEnd) {
        overlapMessage = `Starts during ${conflict.patientName}'s appointment (${conflict.start_time} - ${conflict.end_time})`;
      } else if (requestedEnd > conflictStart && requestedEnd <= conflictEnd) {
        overlapMessage = `Ends during ${conflict.patientName}'s appointment (${conflict.start_time} - ${conflict.end_time})`;
      } else if (requestedStart <= conflictStart && requestedEnd >= conflictEnd) {
        overlapMessage = `Completely overlaps ${conflict.patientName}'s appointment (${conflict.start_time} - ${conflict.end_time})`;
      }
      
      return res.status(400).json({ 
        success: false,
        error: "Scheduling conflict detected",
        conflictDetails: {
          appointmentId: conflict.AppointmentID,
          patientName: conflict.patientName,
          bookedTime: `${conflict.start_time} - ${conflict.end_time}`,
          status: conflict.Status,
          purpose: conflict.Purpose,
          overlapMessage
        }
      });
    }
    
    // Check doctor's working hours (optional - you can customize this)
    const startHour = parseInt(startTime.split(':')[0]);
    if (startHour < 8 || startHour > 18) {
      await db.query("ROLLBACK");
      return res.status(400).json({ 
        success: false,
        error: "Appointments can only be scheduled between 08:00 and 18:00"
      });
    }
    
    // Insert the appointment
    const [result]: any = await db.query(`
      INSERT INTO appointment 
      (PatientID, DoctorID, AppointmentDateTime, start_time, end_time, Purpose, Notes, Status, CreatedBy, UpdatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, NOW())
    `, [
      patientId,
      doctorId,
      appointmentDateTime,
      startTime,
      endTime,
      purpose,
      notes || '',
      createdBy
    ]);
    
    await db.query("COMMIT");
    
    // Get the newly created appointment details
    const [newAppointment]: any = await db.query(`
      SELECT 
        a.*,
        p.Name as patientName,
        u.Name as doctorName
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      LEFT JOIN useraccount u ON a.DoctorID = u.UserID
      WHERE a.AppointmentID = ?
    `, [result.insertId]);
    
    res.json({ 
      success: true,
      appointmentId: result.insertId,
      message: "Appointment scheduled successfully",
      appointment: newAppointment[0],
      timeSlot: `${startTime} - ${endTime}`,
      details: {
        patientId,
        doctorId,
        date: appointmentDate,
        startTime,
        endTime
      }
    });
    
  } catch (error: any) {
    await db.query("ROLLBACK");
    console.error("Schedule appointment error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to schedule appointment",
      details: error.message
    });
  }
};



// ============ GET DOCTOR'S DAILY SCHEDULE ============

// 6. Get doctor's full schedule for a day
export const getDoctorDailySchedule = async (req: Request, res: Response) => {
  const { doctorId, date } = req.query;
  
  try {
    if (!doctorId || !date) {
      return res.status(400).json({ 
        success: false,
        error: "Missing doctor ID or date" 
      });
    }
    
    const [schedule]: any = await db.query(`
      SELECT 
        a.AppointmentID,
        a.start_time,
        a.end_time,
        a.duration,
        a.Status,
        a.Purpose,
        p.Name as patientName,
        p.PhoneNumber,
        p.ICNo,
        a.Notes
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      WHERE a.DoctorID = ? 
        AND DATE(a.AppointmentDateTime) = ?
        AND a.Status NOT IN ('cancelled', 'no-show')
      ORDER BY a.start_time ASC
    `, [doctorId, date]);
    
    // Generate time slots for the day
    const timeSlots = TIME_SLOTS.map(time => {
      const slotAppointments = schedule.filter((apt: any) => {
        const aptStart = new Date(`1970-01-01T${apt.start_time}`);
        const aptEnd = new Date(`1970-01-01T${apt.end_time}`);
        const slotTime = new Date(`1970-01-01T${time}`);
        return slotTime >= aptStart && slotTime < aptEnd;
      });
      
      return {
        time,
        available: slotAppointments.length === 0,
        appointments: slotAppointments
      };
    });
    
    res.json({ 
      success: true,
      doctorId,
      date,
      schedule,
      timeSlots,
      totalAppointments: schedule.length,
      availableSlots: timeSlots.filter(slot => slot.available).length
    });
    
  } catch (error: any) {
    console.error("Get doctor daily schedule error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to get doctor's daily schedule"
    });
  }
};

// ============ BULK AVAILABILITY CHECK ============

// 7. Check multiple time slots at once
export const checkBulkAvailability = async (req: Request, res: Response) => {
  const { doctorId, date, timeSlots } = req.body;
  
  try {
    if (!doctorId || !date || !timeSlots || !Array.isArray(timeSlots)) {
      return res.status(400).json({ 
        success: false,
        error: "Missing required fields or invalid timeSlots array" 
      });
    }
    
    // Get all appointments for the day
    const [appointments]: any = await db.query(`
      SELECT start_time, end_time, Status
      FROM appointment 
      WHERE DoctorID = ? 
        AND DATE(AppointmentDateTime) = ?
        AND Status NOT IN ('cancelled', 'no-show')
    `, [doctorId, date]);
    
    // Check each time slot
    const availabilityResults = timeSlots.map((slot: {start: string, end: string}) => {
      const hasConflict = appointments.some((apt: any) => {
        if (!apt.start_time || !apt.end_time) return false;
        
        const aptStart = new Date(`1970-01-01T${apt.start_time}`);
        const aptEnd = new Date(`1970-01-01T${apt.end_time}`);
        const slotStart = new Date(`1970-01-01T${slot.start}`);
        const slotEnd = new Date(`1970-01-01T${slot.end}`);
        
        return (
          (slotStart >= aptStart && slotStart < aptEnd) ||
          (slotEnd > aptStart && slotEnd <= aptEnd) ||
          (slotStart <= aptStart && slotEnd >= aptEnd)
        );
      });
      
      return {
        ...slot,
        available: !hasConflict,
        message: hasConflict ? "Slot is booked" : "Slot is available"
      };
    });
    
    res.json({ 
      success: true,
      doctorId,
      date,
      results: availabilityResults,
      totalChecked: timeSlots.length,
      availableSlots: availabilityResults.filter((slot: any) => slot.available).length
    });
    
  } catch (error: any) {
    console.error("Check bulk availability error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to check bulk availability"
    });
  }
};

// 1. Get today's appointments with visit status - UPDATED
export const getTodayAppointments = async (req: Request, res: Response) => {
  try {
    // First, let's see what the server thinks is today
    const serverNow = new Date();
    console.log('=== BACKEND DATE DEBUG ===');
    console.log('Server Date:', serverNow.toString());
    console.log('Server Local Date:', serverNow.toLocaleDateString());
    console.log('Server UTC Date:', serverNow.toISOString().split('T')[0]);
    console.log('Server Timezone Offset (minutes):', serverNow.getTimezoneOffset());
    
    // Use MySQL's CURDATE() function (database server's local date)
    console.log('Using CURDATE() for query...');
    
    // CORRECT QUERY: Only show appointments (NOT walk-ins)
    const [appointments]: any = await db.query(`
      SELECT 
        a.AppointmentID,
        a.AppointmentDateTime,
        a.start_time,
        a.end_time,
        a.Purpose,
        a.Status as appointmentStatus,
        a.QueueNumber as appointmentQueueNumber,
        a.Notes,
        a.DoctorID,
        p.PatientID,
        p.Name as patientName,
        p.PhoneNumber,
        p.ICNo,
        u.Name as doctorName,
        dp.Specialization,
        v.VisitID,
        v.VisitStatus,
        v.QueueNumber as visitQueueNumber,
        v.QueueStatus,
        v.CheckInTime,
        v.TriagePriority,
        v.CalledTime,
        v.CheckOutTime
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      LEFT JOIN doctorprofile dp ON a.DoctorID = dp.DoctorID
      LEFT JOIN useraccount u ON a.DoctorID = u.UserID
      LEFT JOIN patient_visit v ON a.AppointmentID = v.AppointmentID 
        AND (v.VisitStatus IS NULL OR v.VisitStatus NOT IN ('cancelled', 'no-show'))
      WHERE DATE(a.AppointmentDateTime) = CURDATE()
        AND a.Status NOT IN ('cancelled', 'no-show')
      ORDER BY 
        a.start_time ASC
    `);
    
    console.log(`=== QUERY RESULTS ===`);
    console.log(`Found ${appointments.length} appointments for CURDATE()`);
    
    // Check what CURDATE() returns
    const [dateCheck]: any = await db.query(`SELECT CURDATE() as mysql_today, NOW() as mysql_now`);
    console.log('MySQL CURDATE():', dateCheck[0]?.mysql_today);
    console.log('MySQL NOW():', dateCheck[0]?.mysql_now);
    
    // Format response
    const formatted = appointments.map((apt: any) => {
      const aptDate = apt.AppointmentDateTime ? new Date(apt.AppointmentDateTime) : null;
      return {
        ...apt,
        date: aptDate ? aptDate.toISOString().split('T')[0] : null,
        time: apt.start_time ? formatTime(apt.start_time) : null,
        endTime: apt.end_time ? formatTime(apt.end_time) : null,
        QueueNumber: apt.visitQueueNumber || apt.appointmentQueueNumber,
        status: apt.VisitID ? apt.VisitStatus : apt.appointmentStatus
      };
    });
    
    console.log(`Formatted appointments (${formatted.length}):`, formatted.map((apt: any) => ({
      id: apt.AppointmentID,
      patient: apt.patientName,
      date: apt.date,
      time: apt.time,
      endTime: apt.endTime,
      doctor: apt.doctorName,
      hasVisit: !!apt.VisitID,
      status: apt.status
    })));
    
    res.json({
      success: true,
      appointments: formatted,
      dateInfo: {
        serverDate: serverNow.toISOString().split('T')[0],
        serverLocalDate: serverNow.toLocaleDateString(),
        mysqlDate: dateCheck[0]?.mysql_today,
        appointmentCount: formatted.length
      }
    });
    
  } catch (error: any) {
    console.error("Get today appointments error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to fetch today's appointments" 
    });
  }
};

// Helper function to format time (add this to your file)
function formatTime(timeString: string): string {
  if (!timeString) return '';
  const time = timeString.split(':');
  if (time.length >= 2) {
    return `${time[0]}:${time[1]}`;
  }
  return timeString;
}

// 2. Check-in appointment (creates patient_visit record AND updates appointment queue)
export const checkInAppointment = async (req: Request, res: Response) => {
  const { appointmentId, receptionistId } = req.body;
      const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    
    console.log('=== DATE DEBUG INFO ===');
    console.log('Server current time:', now.toString());
    console.log('Server ISO string:', now.toISOString());
    console.log('Server local date:', now.toLocaleDateString());
    console.log('Today variable for query:', today);
    console.log('Server timezone offset:', now.getTimezoneOffset() / 60, 'hours');
  
  try {
    if (!appointmentId || !receptionistId) {
      return res.status(400).json({ 
        success: false,
        error: "Missing appointment ID or receptionist ID"
      });
    }
    
    await db.query("START TRANSACTION");
    
    // Get appointment details
    const [appointments]: any = await db.query(`
      SELECT 
        a.*, 
        p.Name as patientName,
        p.PatientID,
        u.Name as doctorName,
        a.DoctorID,
        a.Purpose,
        a.QueueNumber as appointmentQueueNumber
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      LEFT JOIN useraccount u ON a.DoctorID = u.UserID
      WHERE a.AppointmentID = ?
        AND a.Status != 'cancelled'
    `, [appointmentId]);
    
    if (appointments.length === 0) {
      await db.query("ROLLBACK");
      return res.status(404).json({ 
        success: false,
        error: "Appointment not found or already cancelled" 
      });
    }
    
    const appointment = appointments[0];
    
    // Check if visit already exists and is active
    const [existingVisits]: any = await db.query(`
      SELECT * FROM patient_visit 
      WHERE AppointmentID = ? 
        AND VisitStatus NOT IN ('cancelled', 'no-show', 'completed')
    `, [appointmentId]);
    
    if (existingVisits.length > 0) {
      await db.query("ROLLBACK");
      return res.status(400).json({ 
        success: false,
        error: "Patient already checked in for this appointment" 
      });
    }
    
    // Generate queue number using YYMMDD format
    const now = new Date();
    const year = now.getFullYear().toString().slice(-2);
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const dateStr = `${year}${month}${day}`;
    
    // Get the MAX queue number for today that matches Q-YYMMDD-XXX pattern
    const [maxQueue]: any = await db.query(`
      SELECT 
        MAX(
          CASE 
            WHEN QueueNumber LIKE 'Q-${dateStr}-%' 
            THEN CAST(SUBSTRING_INDEX(QueueNumber, '-', -1) AS UNSIGNED)
            ELSE 0
          END
        ) as maxNumber
      FROM patient_visit 
      WHERE DATE(ArrivalTime) = CURDATE()
    `, []);
    
    const lastNumber = maxQueue[0].maxNumber || 0;
    const count = lastNumber + 1;
    const queueNumber = `Q-${dateStr}-${count.toString().padStart(3, '0')}`;
    
    // Get next queue position
    const [maxPosition]: any = await db.query(
      'SELECT MAX(QueuePosition) as maxPos FROM patient_visit WHERE DATE(ArrivalTime) = CURDATE()',
      []
    );
    const queuePosition = (maxPosition[0].maxPos || 0) + 1;
    
    // ============ UPDATED: ALSO UPDATE APPOINTMENT TABLE ============
    // Update appointment status to 'confirmed' AND set QueueNumber
    await db.query(`
      UPDATE appointment 
      SET 
        Status = 'confirmed',
        QueueNumber = ?,  -- Add queue number to appointment table
        UpdatedAt = NOW()
      WHERE AppointmentID = ?
    `, [queueNumber, appointmentId]);
    
    // Create patient_visit record
    const [visit]: any = await db.query(`
      INSERT INTO patient_visit 
      (AppointmentID, PatientID, DoctorID, VisitType, ArrivalTime, CheckInTime, 
       VisitStatus, VisitNotes, QueueNumber, QueueStatus, QueuePosition, TriagePriority)
      VALUES (?, ?, ?, 'follow-up', NOW(), NOW(), 'checked-in', ?, ?, 'waiting', ?, 'low')
    `, [
      appointmentId,
      appointment.PatientID,
      appointment.DoctorID || null,
      appointment.Purpose || 'Appointment visit',
      queueNumber,
      queuePosition
    ]);
    
    await db.query("COMMIT");
    
    res.json({ 
      success: true,
      message: "Patient checked in successfully",
      visitId: visit.insertId,
      queueNumber,
      queuePosition,
      patientName: appointment.patientName
    });
    
  } catch (error: any) {
    await db.query("ROLLBACK");
    console.error("Check-in appointment error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to check in patient"
    });
  }
};

// 3. Mark appointment as late/no-show
export const markAppointmentLate = async (req: Request, res: Response) => {
  const { appointmentId, reason } = req.body;
  
  try {
    if (!appointmentId) {
      return res.status(400).json({ 
        success: false,
        error: "Missing appointment ID"
      });
    }
    
    await db.query("START TRANSACTION");
    
    // Update appointment status to 'no-show'
    await db.query(`
      UPDATE appointment 
      SET Status = 'cancelled',
          UpdatedAt = NOW(),
          Notes = CONCAT(COALESCE(Notes, ''), '\nMarked as no-show: ${reason || 'Patient did not arrive'}')
      WHERE AppointmentID = ?
    `, [appointmentId]);
    
    await db.query("COMMIT");
    
    res.json({ 
      success: true,
      message: "Appointment marked as no-show"
    });
    
  } catch (error: any) {
    await db.query("ROLLBACK");
    console.error("Mark appointment late error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to mark appointment as no-show"
    });
  }
};


// 5. Reschedule appointment
export const rescheduleAppointment = async (req: Request, res: Response) => {
  const { appointmentId, newDateTime, reason, rescheduledBy } = req.body;
  
  try {
    if (!appointmentId || !newDateTime) {
      return res.status(400).json({ 
        success: false,
        error: "Missing required fields"
      });
    }
    
    await db.query("START TRANSACTION");
    
    // Update appointment
    await db.query(`
      UPDATE appointment 
      SET AppointmentDateTime = ?,
          Status = 'scheduled',
          UpdatedAt = NOW(),
          Notes = CONCAT(COALESCE(Notes, ''), '\nRescheduled by ${rescheduledBy}: ${reason || ''}')
      WHERE AppointmentID = ?
    `, [newDateTime, appointmentId]);
    
    await db.query("COMMIT");
    
    res.json({ 
      success: true,
      message: "Appointment rescheduled successfully"
    });
    
  } catch (error: any) {
    await db.query("ROLLBACK");
    console.error("Reschedule appointment error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to reschedule appointment"
    });
  }
};

export const searchAppointments = async (req: Request, res: Response) => {
  const { q } = req.query;
  
  try {
    if (!q || q.toString().trim().length < 2) {
      return res.status(400).json({ 
        success: false,
        error: "Search query must be at least 2 characters" 
      });
    }
    
    const searchTerm = `%${q}%`;
    
    console.log('Searching appointments for:', searchTerm);
    
    const [appointments]: any = await db.query(`
      SELECT 
        a.AppointmentID,
        a.AppointmentDateTime,
        a.start_time,
        a.end_time,
        a.Purpose,
        a.Notes,
        a.Status,
        p.PatientID,
        p.Name as PatientName,
        p.ICNo,
        p.PhoneNumber,
        p.Email,
        u.UserID as DoctorID,
        u.Name as DoctorName,
        dp.Specialization as DoctorSpecialization
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      LEFT JOIN useraccount u ON a.DoctorID = u.UserID
      LEFT JOIN doctorprofile dp ON u.UserID = dp.DoctorID
      WHERE (
        p.Name LIKE ? OR
        p.ICNo LIKE ? OR
        p.PhoneNumber LIKE ? OR
        a.AppointmentID LIKE ? OR
        u.Name LIKE ? OR
        a.Purpose LIKE ?
      )
      AND a.Status NOT IN ('cancelled', 'no-show')
      ORDER BY a.AppointmentDateTime DESC
      LIMIT 20
    `, [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm]);
    
    console.log(`Found ${appointments.length} appointments matching search`);
    
    res.json({ 
      success: true,
      appointments: appointments.map((apt: any) => ({
        AppointmentID: apt.AppointmentID,
        AppointmentDateTime: apt.AppointmentDateTime,
        start_time: apt.start_time,
        end_time: apt.end_time,
        Purpose: apt.Purpose,
        Notes: apt.Notes,
        Status: apt.Status,
        PatientID: apt.PatientID,
        PatientName: apt.PatientName,
        ICNo: apt.ICNo,
        PhoneNumber: apt.PhoneNumber,
        Email: apt.Email,
        DoctorID: apt.DoctorID,
        DoctorName: apt.DoctorName,
        DoctorSpecialization: apt.DoctorSpecialization
      }))
    });
    
  } catch (error: any) {
    console.error("Search appointments error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to search appointments"
    });
  }
};

export const getAllAppointments = async (req: Request, res: Response) => {
  try {
    console.log('=== Fetching all appointments ===');
    
    const [appointments]: any = await db.query(`
      SELECT 
        a.AppointmentID,
        a.AppointmentDateTime,
        a.start_time,
        a.end_time,
        a.Purpose,
        a.Notes,
        a.Status,
        p.PatientID,
        p.Name as PatientName,
        p.ICNo,
        p.PhoneNumber,
        p.Email,
        u.UserID as DoctorID,
        u.Name as DoctorName,
        dp.Specialization as DoctorSpecialization,
        v.VisitID,
        v.QueueNumber,
        v.VisitStatus,
        v.CheckInTime
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      LEFT JOIN useraccount u ON a.DoctorID = u.UserID
      LEFT JOIN doctorprofile dp ON u.UserID = dp.DoctorID
      LEFT JOIN patient_visit v ON a.AppointmentID = v.AppointmentID
      WHERE a.Status NOT IN ('cancelled', 'no-show')
      ORDER BY a.AppointmentDateTime DESC
    `);
    
    console.log(`Found ${appointments.length} appointments total`);
    
    res.json({ 
      success: true,
      appointments: appointments.map((apt: any) => ({
        AppointmentID: apt.AppointmentID,
        AppointmentDateTime: apt.AppointmentDateTime,
        start_time: apt.start_time,
        end_time: apt.end_time,
        Purpose: apt.Purpose,
        Notes: apt.Notes,
        Status: apt.Status,
        PatientID: apt.PatientID,
        PatientName: apt.PatientName,
        ICNo: apt.ICNo,
        PhoneNumber: apt.PhoneNumber,
        Email: apt.Email,
        DoctorID: apt.DoctorID,
        DoctorName: apt.DoctorName,
        DoctorSpecialization: apt.DoctorSpecialization,
        VisitID: apt.VisitID,
        QueueNumber: apt.QueueNumber,
        VisitStatus: apt.VisitStatus,
        CheckInTime: apt.CheckInTime
      }))
    });
    
  } catch (error: any) {
    console.error("Get all appointments error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to get appointments"
    });
  }
};

export const updateAppointment = async (req: Request, res: Response) => {
  const { id } = req.params;
  const {
    patientId,
    doctorId,
    appointmentDateTime,
    startTime,
    endTime,
    purpose,
    notes,
    status
  } = req.body;
  
  try {
    if (!id) {
      return res.status(400).json({ 
        success: false,
        error: "Appointment ID is required" 
      });
    }
    
    console.log('=== Updating appointment ===');
    console.log('Appointment ID:', id);
    console.log('Update data:', req.body);
    
    // First, get the original appointment to check if we need to update visits
    const [existingAppointment]: any = await db.query(`
      SELECT * FROM appointment WHERE AppointmentID = ?
    `, [id]);
    
    if (!existingAppointment || existingAppointment.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: "Appointment not found" 
      });
    }
    
    const originalDateTime = existingAppointment[0].AppointmentDateTime;
    
    // Update the appointment
    const [result]: any = await db.query(`
      UPDATE appointment 
      SET 
        PatientID = ?,
        DoctorID = ?,
        AppointmentDateTime = ?,
        start_time = ?,
        end_time = ?,
        Purpose = ?,
        Notes = ?,
        Status = ?,
        UpdatedAt = NOW()
      WHERE AppointmentID = ?
    `, [
      patientId,
      doctorId,
      appointmentDateTime,
      startTime,
      endTime,
      purpose,
      notes,
      status || 'scheduled',
      id
    ]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        success: false,
        error: "Appointment not found or not updated" 
      });
    }
    
    // If appointment date/time changed and there's a visit record, we might need to update it
    if (originalDateTime !== appointmentDateTime) {
      const [visitCheck]: any = await db.query(`
        SELECT * FROM patient_visit WHERE AppointmentID = ?
      `, [id]);
      
      if (visitCheck.length > 0) {
        // Update the visit's arrival time if it exists
        await db.query(`
          UPDATE patient_visit 
          SET ArrivalTime = ?
          WHERE AppointmentID = ?
        `, [appointmentDateTime, id]);
        
        console.log('Updated visit arrival time due to appointment reschedule');
      }
    }
    
    // Get the updated appointment
    const [updatedAppointment]: any = await db.query(`
      SELECT 
        a.*,
        p.Name as PatientName,
        u.Name as DoctorName
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      LEFT JOIN useraccount u ON a.DoctorID = u.UserID
      WHERE a.AppointmentID = ?
    `, [id]);
    
    console.log('Appointment updated successfully');
    
    res.json({ 
      success: true,
      appointment: updatedAppointment[0]
    });
    
  } catch (error: any) {
    console.error("Update appointment error:", error);
    
    // Check if it's a duplicate time slot error
    if (error.code === 'ER_DUP_ENTRY' || error.message?.includes('Duplicate')) {
      return res.status(400).json({ 
        success: false,
        error: "This time slot is already booked. Please choose another time."
      });
    }
    
    res.status(500).json({ 
      success: false,
      error: "Failed to update appointment"
    });
  }
};

export const cancelAppointment = async (req: Request, res: Response) => {
  const {
    appointmentId,
    reason,
    cancelledBy
  } = req.body;
  
  try {
    if (!appointmentId || !reason) {
      return res.status(400).json({ 
        success: false,
        error: "Appointment ID and reason are required" 
      });
    }
    
    console.log('=== Cancelling appointment ===');
    console.log('Appointment ID:', appointmentId);
    console.log('Reason:', reason);
    
    // First, check if appointment exists and get details
    const [appointment]: any = await db.query(`
      SELECT 
        a.*,
        p.Name as PatientName
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      WHERE a.AppointmentID = ?
    `, [appointmentId]);
    
    if (!appointment || appointment.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: "Appointment not found" 
      });
    }
    
    // Update appointment status to cancelled
    const [result]: any = await db.query(`
      UPDATE appointment 
      SET 
        Status = 'cancelled',
        UpdatedAt = NOW(),
        Notes = CONCAT(COALESCE(Notes, ''), '\nCancelled by ${cancelledBy}: ${reason}')
      WHERE AppointmentID = ?
    `, [appointmentId]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        success: false,
        error: "Appointment not found or not cancelled" 
      });
    }
    
    // If there's an associated visit, cancel it too
    const [visitCheck]: any = await db.query(`
      SELECT * FROM patient_visit WHERE AppointmentID = ?
    `, [appointmentId]);
    
    if (visitCheck.length > 0) {
      await db.query(`
        UPDATE patient_visit 
        SET 
          VisitStatus = 'cancelled',
          UpdatedAt = NOW()
        WHERE AppointmentID = ?
      `, [appointmentId]);
      
      console.log('Cancelled associated visit');
    }
    
    // Generate cancellation reference
    const cancellationRef = `CANCEL-${Date.now()}-${appointmentId}`;
    
    console.log('Appointment cancelled successfully');
    
    res.json({ 
      success: true,
      cancellationRef,
      appointmentId,
      message: "Appointment cancelled successfully"
    });
    
  } catch (error: any) {
    console.error("Cancel appointment error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to cancel appointment"
    });
  }
};