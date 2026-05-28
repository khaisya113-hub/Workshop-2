// controllers/waitingListController.ts
import { Request, Response } from "express";
import { db } from "../db";

// Get ALL today's visits including completed and cancelled
export const getTodayAllVisits = async (req: Request, res: Response) => {
  try {
    console.log('Fetching all today\'s visits including completed/cancelled...');
    
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
        pv.CalledTime,
        CASE 
          WHEN pv.VisitType = 'walk-in' THEN 'Walk-in'
          WHEN pv.VisitType = 'first-time' THEN 'First Visit'
          WHEN pv.VisitType = 'follow-up' THEN 'Follow-up'
          ELSE pv.VisitType
        END as visitTypeLabel,
        CASE 
          WHEN pv.QueueStatus IN ('completed', 'cancelled') OR pv.VisitStatus = 'no-show'
          THEN 'completed'
          ELSE 'active'
        END as statusCategory
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      LEFT JOIN useraccount u ON pv.DoctorID = u.UserID
      WHERE DATE(pv.ArrivalTime) = CURDATE()
      ORDER BY 
        CASE 
          WHEN pv.QueueStatus IN ('waiting', 'in-progress') AND pv.VisitStatus IN ('checked-in', 'in-consultation', 'waiting-for-results', 'ready-for-checkout') THEN 1
          ELSE 2
        END,
        CASE 
          WHEN pv.QueueStatus = 'in-progress' THEN 1 
          WHEN pv.QueueStatus = 'waiting' THEN 2 
          WHEN pv.QueueStatus = 'completed' THEN 3
          WHEN pv.QueueStatus = 'cancelled' THEN 4
          ELSE 5
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
    
    console.log(`Found ${visits.length} total visits for today`);
    console.log('Status breakdown:', {
      active: visits.filter((v: any) => v.statusCategory === 'active').length,
      completed: visits.filter((v: any) => v.statusCategory === 'completed').length
    });
    
    res.json({
      success: true,
      visits: visits,
      stats: {
        total: visits.length,
        active: visits.filter((v: any) => v.statusCategory === 'active').length,
        completed: visits.filter((v: any) => v.statusCategory === 'completed').length
      }
    });
    
  } catch (error) {
    console.error("Fetch all today visits error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to fetch today's visits" 
    });
  }
};

// Get only active visits (exclude completed/cancelled)
export const getTodayActiveVisits = async (req: Request, res: Response) => {
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
        pv.CalledTime,
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
        AND pv.QueueStatus NOT IN ('completed', 'cancelled')
        AND pv.VisitStatus != 'no-show'
        AND pv.VisitStatus != 'cancelled'
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
    
    res.json({
      success: true,
      visits: visits
    });
    
  } catch (error) {
    console.error("Fetch active visits error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to fetch active visits" 
    });
  }
};

// Get only completed/cancelled visits
export const getTodayCompletedVisits = async (req: Request, res: Response) => {
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
        pv.CheckOutTime,
        pv.VisitNotes,
        p.Name as patientName,
        p.PhoneNumber,
        u.Name as doctorName,
        pv.DoctorID,
        pv.PatientID,
        pv.VisitType,
        pv.TriagePriority
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      LEFT JOIN useraccount u ON pv.DoctorID = u.UserID
      WHERE DATE(pv.ArrivalTime) = CURDATE()
        AND (pv.QueueStatus IN ('completed', 'cancelled') OR pv.VisitStatus IN ('completed', 'cancelled', 'no-show'))
      ORDER BY pv.CheckOutTime DESC, pv.ArrivalTime DESC
    `);
    
    res.json({
      success: true,
      visits: visits
    });
    
  } catch (error) {
    console.error("Fetch completed visits error:", error);
    res.status(500).json({ 
      success: false,
      error: "Failed to fetch completed visits" 
    });
  }
};