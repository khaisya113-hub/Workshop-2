// routes/appointmentRoutes.ts - UPDATED VERSION
import express from 'express';
import {
  getTodayAppointments,
  checkInAppointment,
  markAppointmentLate,
  cancelAppointment,
  rescheduleAppointment,
  // NEW FUNCTIONS
  getDoctorAvailability,
  checkTimeSlotAvailability,
  scheduleAppointment,
  updateAppointment,
  getDoctorDailySchedule,
  checkBulkAvailability,
  getAllAppointments,
  searchAppointments
} from '../controllers/appointmentController';

const router = express.Router();

// Existing appointment management routes
router.get('/today', getTodayAppointments);
router.post('/checkin', checkInAppointment);
router.post('/mark-late', markAppointmentLate);
router.post('/cancel', cancelAppointment);
router.post('/reschedule', rescheduleAppointment);

// NEW ROUTES FOR AVAILABILITY CHECKING
router.get('/doctor-availability', getDoctorAvailability);
router.post('/check-slot-availability', checkTimeSlotAvailability);
router.post('/schedule', scheduleAppointment); // Use this instead of old schedule-appointment
router.get('/doctor-schedule', getDoctorDailySchedule);
router.post('/bulk-availability', checkBulkAvailability);

router.get('/search', searchAppointments);
router.get('/all', getAllAppointments);           // GET /api/appointments/all
router.put('/update/:id', updateAppointment);


export default router;
