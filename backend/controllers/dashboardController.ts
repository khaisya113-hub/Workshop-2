import { Request, Response } from "express";
import { db } from "../db";

export const getRecentActivities = async (req: Request, res: Response) => {
  try {
    console.log("📝 Fetching recent activities from multiple sources...");
    
    // Combine activities from multiple sources
    const combinedActivities = [];
    
    // 1. Get recent patient registrations (from last 7 days)
    try {
      const [patientRegistrations] = await db.query(
        `SELECT 
          'New patient registered' as action,
          p.Name as user,
          p.RegistrationDate as time,
          'success' as type
        FROM patient p
        WHERE p.RegistrationDate >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        ORDER BY p.RegistrationDate DESC
        LIMIT 5`
      ) as any[];
      
      if (patientRegistrations && patientRegistrations.length > 0) {
        patientRegistrations.forEach((activity: any) => {
          combinedActivities.push({
            action: activity.action,
            user: activity.user,
            time: formatTimeAgo(activity.time),
            type: activity.type
          });
        });
      }
    } catch (error) {
      console.log("⚠️ Could not fetch patient registrations:", (error as Error).message);
    }
    
    // 2. Get recent appointments (from last 2 days)
    try {
      const [appointments] = await db.query(
        `SELECT 
          CONCAT('Appointment scheduled') as action,
          u.Name as user,
          a.UpdatedAt as time,
          'info' as type
        FROM appointment a
        JOIN useraccount u ON a.CreatedBy = u.UserID
        WHERE a.UpdatedAt >= DATE_SUB(NOW(), INTERVAL 2 DAY)
        ORDER BY a.UpdatedAt DESC
        LIMIT 5`
      ) as any[];
      
      if (appointments && appointments.length > 0) {
        appointments.forEach((activity: any) => {
          combinedActivities.push({
            action: activity.action,
            user: activity.user,
            time: formatTimeAgo(activity.time),
            type: activity.type
          });
        });
      }
    } catch (error) {
      console.log("⚠️ Could not fetch appointments:", (error as Error).message);
    }
    
    // 3. Get recent consultations (from last 3 days)
    try {
      const [consultations] = await db.query(
        `SELECT 
          CONCAT('Consultation completed') as action,
          u.Name as user,
          c.CreatedAt as time,
          'info' as type
        FROM consultation c
        JOIN useraccount u ON c.DoctorID = u.UserID
        WHERE c.CreatedAt >= DATE_SUB(NOW(), INTERVAL 3 DAY)
        ORDER BY c.CreatedAt DESC
        LIMIT 5`
      ) as any[];
      
      if (consultations && consultations.length > 0) {
        consultations.forEach((activity: any) => {
          combinedActivities.push({
            action: activity.action,
            user: activity.user,
            time: formatTimeAgo(activity.time),
            type: activity.type
          });
        });
      }
    } catch (error) {
      console.log("⚠️ Could not fetch consultations:", (error as Error).message);
    }
    
    // 4. Get recent patient visits (from today)
    try {
      const [visits] = await db.query(
        `SELECT 
          CONCAT('Patient checked in') as action,
          p.Name as user,
          pv.CheckInTime as time,
          'success' as type
        FROM patient_visit pv
        JOIN patient p ON pv.PatientID = p.PatientID
        WHERE DATE(pv.CheckInTime) = CURDATE()
        ORDER BY pv.CheckInTime DESC
        LIMIT 5`
      ) as any[];
      
      if (visits && visits.length > 0) {
        visits.forEach((activity: any) => {
          combinedActivities.push({
            action: activity.action,
            user: activity.user,
            time: formatTimeAgo(activity.time),
            type: activity.type
          });
        });
      }
    } catch (error) {
      console.log("⚠️ Could not fetch patient visits:", (error as Error).message);
    }
    
    // Sort all activities by time (newest first)
    combinedActivities.sort((a: any, b: any) => {
      return new Date(b.time).getTime() - new Date(a.time).getTime();
    });
    
    // Take only the 5 most recent activities
    const recentActivities = combinedActivities.slice(0, 5);
    
    // If no activities found, try a fallback query
    if (recentActivities.length === 0) {
      console.log("ℹ️ No recent activities found, trying fallback query");
      
      // Fallback: Get ANY recent activities from the system
      const [fallbackActivities] = await db.query(
        `(SELECT 
          'Patient registered' as action,
          Name as user,
          RegistrationDate as time,
          'success' as type
        FROM patient 
        ORDER BY RegistrationDate DESC 
        LIMIT 3)
        
        UNION ALL
        
        (SELECT 
          CONCAT('Appointment - ', Status) as action,
          (SELECT Name FROM useraccount WHERE UserID = a.CreatedBy) as user,
          UpdatedAt as time,
          'info' as type
        FROM appointment a
        ORDER BY UpdatedAt DESC 
        LIMIT 2)
        
        ORDER BY time DESC
        LIMIT 5`
      ) as any[];
      
      if (fallbackActivities && fallbackActivities.length > 0) {
        const formatted = fallbackActivities.map((activity: any) => ({
          action: activity.action,
          user: activity.user || 'System',
          time: formatTimeAgo(activity.time),
          type: activity.type
        }));
        res.json(formatted);
      } else {
        res.json([]); // Return empty array if no data
      }
    } else {
      console.log(`✅ Found ${recentActivities.length} recent activities`);
      res.json(recentActivities);
    }
    
  } catch (error: any) {
    console.error("❌ Recent activities error:", error);
    res.status(500).json({ 
      error: "Failed to fetch recent activities",
      message: error.message 
    });
  }
};

export const getDashboardStats = async (req: Request, res: Response) => {
  try {
    console.log("📊 Fetching dashboard statistics...");
    
    // Fetch all stats sequentially (simpler approach)
    const [patientsResult]: any[] = await db.query(
      "SELECT COUNT(*) as total FROM patient WHERE IsActive = 1"
    );
    
    const [appointmentsResult]: any[] = await db.query(
      `SELECT COUNT(*) as today FROM appointment 
       WHERE DATE(AppointmentDateTime) = CURDATE() 
       AND Status IN ('scheduled', 'confirmed')`
    );
    
    const [staffResult]: any[] = await db.query(
      `SELECT COUNT(*) as active FROM useraccount 
       WHERE Status = 'Active' 
       AND Role IN ('doctor', 'receptionist', 'admin')`
    );
    
    const [todayVisitsResult]: any[] = await db.query(
      `SELECT COUNT(*) as visits FROM patient_visit 
       WHERE DATE(CheckInTime) = CURDATE()
       AND VisitStatus = 'completed'`
    );
    
    // Try to get revenue, but don't fail if it doesn't work
    let monthlyRevenue = 0;
    try {
      const [revenueResult]: any[] = await db.query(
        `SELECT COALESCE(SUM(s.StandardFee), 0) as revenue
         FROM patient_visit pv
         JOIN consultation c ON pv.VisitID = c.VisitID
         JOIN service s ON s.ServiceName LIKE '%Consultation%'
         WHERE DATE(pv.CheckInTime) = CURDATE()
         AND pv.VisitStatus = 'completed'
         LIMIT 1`
      );
      monthlyRevenue = (revenueResult[0]?.revenue || 0) * 30;
    } catch (error) {
      console.log("⚠️ Could not calculate revenue:", error);
    }
    
    const stats = {
      totalPatients: patientsResult[0]?.total || 0,
      appointmentsToday: appointmentsResult[0]?.today || 0,
      activeStaff: staffResult[0]?.active || 0,
      visitsToday: todayVisitsResult[0]?.visits || 0,
      monthlyRevenue: monthlyRevenue
    };
    
    console.log("✅ Dashboard stats:", stats);
    res.json(stats);
    
  } catch (error: any) {
    console.error("❌ Dashboard stats error:", error);
    res.status(500).json({
      totalPatients: 0,
      appointmentsToday: 0,
      activeStaff: 0,
      visitsToday: 0,
      monthlyRevenue: 0
    });
  }
};

export const getUpcomingAppointments = async (req: Request, res: Response) => {
  try {
    console.log("📅 Fetching upcoming appointments...");
    
    const [appointments] = await db.query(
      `SELECT 
        p.Name as patient,
        u.Name as doctor,
        DATE_FORMAT(a.AppointmentDateTime, '%h:%i %p') as time,
        a.Purpose as department,
        a.Status,
        a.QueueNumber
      FROM appointment a
      JOIN patient p ON a.PatientID = p.PatientID
      JOIN useraccount u ON a.DoctorID = u.UserID
      WHERE DATE(a.AppointmentDateTime) = CURDATE()
        AND a.Status IN ('scheduled', 'confirmed')
      ORDER BY a.AppointmentDateTime ASC
      LIMIT 6`
    ) as any[];
    
    if (appointments && appointments.length > 0) {
      console.log(`✅ Found ${appointments.length} upcoming appointments`);
      res.json(appointments);
    } else {
      console.log("ℹ️ No appointments today");
      res.json([]);
    }
    
  } catch (error: any) {
    console.error("❌ Upcoming appointments error:", error);
    res.status(500).json({ 
      error: "Failed to fetch upcoming appointments",
      message: error.message 
    });
  }
};

export const getPatientStats = async (req: Request, res: Response) => {
  try {
    const [result] = await db.query(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN Gender = 'M' THEN 1 ELSE 0 END) as male,
        SUM(CASE WHEN Gender = 'F' THEN 1 ELSE 0 END) as female,
        AVG(YEAR(CURDATE()) - YEAR(DOB)) as avgAge,
        (SELECT COUNT(*) FROM patient WHERE IsActive = 1 AND RegistrationDate >= DATE_SUB(NOW(), INTERVAL 30 DAY)) as newThisMonth
      FROM patient 
      WHERE IsActive = 1`
    ) as any[];
    
    res.json(result[0] || { 
      total: 0, 
      male: 0, 
      female: 0, 
      avgAge: 0, 
      newThisMonth: 0 
    });
    
  } catch (error: any) {
    console.error("❌ Patient stats error:", error);
    res.status(500).json({ 
      error: "Failed to fetch patient statistics",
      message: error.message 
    });
  }
};

export const getDoctorStats = async (req: Request, res: Response) => {
  try {
    const [result] = await db.query(
      `SELECT 
        u.Name as doctorName,
        d.Specialization,
        d.ClinicRoom,
        COUNT(DISTINCT c.ConsultationID) as consultationsToday,
        COUNT(DISTINCT a.AppointmentID) as appointmentsToday
      FROM useraccount u
      JOIN doctorprofile d ON u.UserID = d.DoctorID
      LEFT JOIN consultation c ON u.UserID = c.DoctorID AND DATE(c.CreatedAt) = CURDATE()
      LEFT JOIN appointment a ON u.UserID = a.DoctorID AND DATE(a.AppointmentDateTime) = CURDATE() AND a.Status IN ('scheduled', 'confirmed')
      WHERE u.Role = 'doctor' AND u.Status = 'Active'
      GROUP BY u.UserID
      ORDER BY consultationsToday DESC`
    ) as any[];
    
    res.json(result);
    
  } catch (error: any) {
    console.error("❌ Doctor stats error:", error);
    res.status(500).json({ 
      error: "Failed to fetch doctor statistics",
      message: error.message 
    });
  }
};

export const getTodayQueue = async (req: Request, res: Response) => {
  try {
    const [queue] = await db.query(
      `SELECT 
        pv.QueueNumber,
        p.Name as patientName,
        u.Name as doctorName,
        pv.VisitStatus,
        pv.QueuePosition,
        pv.ArrivalTime,
        pv.VisitType
      FROM patient_visit pv
      JOIN patient p ON pv.PatientID = p.PatientID
      LEFT JOIN useraccount u ON pv.DoctorID = u.UserID
      WHERE DATE(pv.ArrivalTime) = CURDATE()
        AND pv.VisitStatus IN ('checked-in', 'in-consultation', 'scheduled')
      ORDER BY 
        CASE 
          WHEN pv.VisitStatus = 'in-consultation' THEN 1
          WHEN pv.VisitStatus = 'checked-in' THEN 2
          ELSE 3
        END,
        pv.QueuePosition ASC
      LIMIT 10`
    ) as any[];
    
    res.json(queue);
    
  } catch (error: any) {
    console.error("❌ Today queue error:", error);
    res.status(500).json({ 
      error: "Failed to fetch today's queue",
      message: error.message 
    });
  }
};

export const getSystemStatus = async (req: Request, res: Response) => {
  try {
    // Get counts sequentially
    const [patientCount]: any[] = await db.query(
      "SELECT COUNT(*) as count FROM patient WHERE IsActive = 1"
    );
    
    const [appointmentCount]: any[] = await db.query(
      "SELECT COUNT(*) as count FROM appointment WHERE Status IN ('scheduled', 'confirmed') AND AppointmentDateTime >= CURDATE()"
    );
    
    const [userCount]: any[] = await db.query(
      "SELECT COUNT(*) as count FROM useraccount WHERE Status = 'Active'"
    );
    
    const [drugCount]: any[] = await db.query(
      "SELECT COUNT(*) as count FROM drug WHERE IsActive = 1 AND QuantityInStock > 0"
    );
    
    const [visitCount]: any[] = await db.query(
      "SELECT COUNT(*) as count FROM patient_visit WHERE DATE(ArrivalTime) = CURDATE() AND VisitStatus != 'cancelled'"
    );
    
    // Try to get pending bills, but don't fail if table doesn't exist
    let pendingBills = 0;
    try {
      const [billsResult]: any[] = await db.query(
        "SELECT COUNT(*) as count FROM billing WHERE Status IN ('pending', 'partial')"
      );
      pendingBills = billsResult[0]?.count || 0;
    } catch (error) {
      console.log("⚠️ Could not fetch billing data:", error);
    }
    
    const status = {
      patients: patientCount[0]?.count || 0,
      appointments: appointmentCount[0]?.count || 0,
      users: userCount[0]?.count || 0,
      drugs: drugCount[0]?.count || 0,
      todayVisits: visitCount[0]?.count || 0,
      pendingBills: pendingBills,
      database: 'online',
      lastUpdated: new Date().toISOString(),
      uptime: process.uptime()
    };
    
    res.json(status);
    
  } catch (error: any) {
    console.error("❌ System status error:", error);
    res.status(500).json({ 
      database: 'offline',
      error: error.message,
      lastUpdated: new Date().toISOString()
    });
  }
};

export const getDrugStockAlerts = async (req: Request, res: Response) => {
  try {
    const [lowStock] = await db.query(
      `SELECT 
        DrugID,
        DrugName,
        QuantityInStock,
        MinStockLevel,
        Location,
        CASE 
          WHEN QuantityInStock <= MinStockLevel * 0.2 THEN 'critical'
          WHEN QuantityInStock <= MinStockLevel * 0.5 THEN 'low'
          ELSE 'adequate'
        END as StockStatus
      FROM drug 
      WHERE IsActive = 1 
        AND QuantityInStock <= MinStockLevel * 0.5
      ORDER BY QuantityInStock ASC
      LIMIT 10`
    ) as any[];
    
    res.json(lowStock);
    
  } catch (error: any) {
    console.error("❌ Drug stock alerts error:", error);
    res.status(500).json({ 
      error: "Failed to fetch drug stock alerts",
      message: error.message 
    });
  }
};

export const getMonthlyVisitsChart = async (req: Request, res: Response) => {
  try {
    const [monthlyData] = await db.query(
      `SELECT 
        DATE_FORMAT(ArrivalTime, '%Y-%m') as month,
        COUNT(*) as visitCount,
        COUNT(DISTINCT PatientID) as uniquePatients
      FROM patient_visit 
      WHERE ArrivalTime >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
      GROUP BY DATE_FORMAT(ArrivalTime, '%Y-%m')
      ORDER BY month ASC`
    ) as any[];
    
    res.json(monthlyData);
    
  } catch (error: any) {
    console.error("❌ Monthly visits chart error:", error);
    res.status(500).json({ 
      error: "Failed to fetch monthly visits data",
      message: error.message 
    });
  }
};

// Helper function to format time ago
function formatTimeAgo(dateString: string): string {
  if (!dateString) return 'Recently';
  
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} mins ago`;
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch (error) {
    return 'Recently';
  }
}