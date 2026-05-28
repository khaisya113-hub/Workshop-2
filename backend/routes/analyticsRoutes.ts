// routes/analyticsRoutes.ts
import express from "express";
import {
  getAnalyticsMetrics,
  getMonthlyTrends,
  getWeeklyAppointments,
  getDepartmentDistribution,
  getRevenueTrend
} from "../controllers/analyticsController";

const router = express.Router();

// GET /api/analytics/metrics
router.get("/metrics", getAnalyticsMetrics);

// GET /api/analytics/monthly-trends
router.get("/monthly-trends", getMonthlyTrends);

// GET /api/analytics/weekly-appointments
router.get("/weekly-appointments", getWeeklyAppointments);

// GET /api/analytics/department-distribution
router.get("/department-distribution", getDepartmentDistribution);

// GET /api/analytics/revenue-trend
router.get("/revenue-trend", getRevenueTrend);

export default router;
