// routes/dashboardRoutes.ts
import express from "express";
import { 
  getDashboardStats, 
  getRecentActivities, 
  getUpcomingAppointments,
  getPatientStats,
  getDoctorStats,
  getTodayQueue,
  getSystemStatus,
  getDrugStockAlerts,
  getMonthlyVisitsChart
} from "../controllers/dashboardController";

const router = express.Router();

// GET /api/dashboard/stats
router.get("/stats", getDashboardStats);

// GET /api/dashboard/recent-activities
router.get("/recent-activities", getRecentActivities);

// GET /api/dashboard/upcoming-appointments
router.get("/upcoming-appointments", getUpcomingAppointments);

router.get('/stats', getDashboardStats);
router.get('/recent-activities', getRecentActivities);
router.get('/upcoming-appointments', getUpcomingAppointments);
router.get('/patient-stats', getPatientStats);
router.get('/doctor-stats', getDoctorStats);
router.get('/today-queue', getTodayQueue);
router.get('/system-status', getSystemStatus);
router.get('/drug-alerts', getDrugStockAlerts);
router.get('/monthly-visits', getMonthlyVisitsChart);

export default router;
