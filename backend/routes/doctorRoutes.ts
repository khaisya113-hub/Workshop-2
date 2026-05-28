import express from "express";
import {
  getDoctorProfile,
  getTodayAppointments,
  getPatientQueue,
  getPatientDetails,
  saveConsultation,
  visitPatient,
  completeVisit,
  getQueueStats,
  createPrescription,
  getRecentPrescriptions,
  claimPatient,
  scheduleFollowUp,
  getPatientVitals,
  saveVitalSigns,
  getActiveVisit,
  createVisitForVitals,
    getTodayAppointmentsWithVisits,
  getTodayScheduledAppointments,
  getScheduledAppointments,
  getPatientAppointment,
  getEnhancedPatientQueue,
  createConsultation,
  saveConsultationDetails,
  createConsultationForVitals,
  saveConsultationFull,
  getPatientVisits,
  getPatientAllergies,
  saveAllergyFinding,
  getPatientMedicalConditions,
  saveMedicalCondition,
  getPatientForConsultation,
  saveVitalSignsWithConsultation,
  saveComprehensiveConsultation,
  getAllTodayAppointments,
  getConsultationQueue,
  getCalledPatients,
  getActiveConsultation,
  completeConsultation,
  saveConsultationForm,
  savePrescription,
  getPatientPrescriptions,
  createFollowUp,
  getActiveConsultationByPatientDoctor,
updateConsultation,
  getPatientVisitsD,
  getPatientConsultationsD,
  getPatientPrescriptionsD,
  getPatientAllergiesD,
  getPatientConsultations,
  getAllPatients2,
  getDoctorConsultationsCount,
  getDoctorPrescriptionsCount,
  getDoctorPatientsWithAppointmentsCount,
  getPrescriptionsByConsultation

  // Add these to your doctorRoutes.ts

} from "../controllers/doctorController";
import { verifyToken, requireRole } from "../middleware/authMiddleware";

const router = express.Router();

// Apply authentication middleware to ALL doctor routes
router.use(verifyToken);
router.use(requireRole('doctor'));

router.get('/consultations/count', getDoctorConsultationsCount);
router.get('/prescriptions/count', getDoctorPrescriptionsCount);
router.get('/appointments/count', getDoctorPatientsWithAppointmentsCount);
router.get('/patients',getAllPatients2);
router.get('/patient/:patientId/consultations',getPatientConsultations);


router.get('/patient/:patientId/visitsD', getPatientVisitsD);
router.get('/patient/:patientId/consultationsD', getPatientConsultationsD);
router.get('/patient/:patientId/prescriptionsD', getPatientPrescriptionsD);
router.get('/patient/:patientId/allergiesD', getPatientAllergiesD);

router.put('/update-consultation', verifyToken, updateConsultation);
router.get('/consultation/active/:patientId/:doctorId', getActiveConsultationByPatientDoctor);

// In doctorRoutes.ts
router.get('/active-consultation/:doctorId', getActiveConsultation);
router.get("/called-patients/:doctorId", getCalledPatients);
router.get('/patient/:patientId/allergies', getPatientAllergies);
router.post('/save-allergy', saveAllergyFinding);
router.get('/patient/:patientId/medical-conditions', getPatientMedicalConditions);
router.post('/save-medical-condition', saveMedicalCondition);
router.get('/patient/:patientId/visits', getPatientVisits);
router.post('/save-consultation-full', saveConsultationFull);
router.get('/patient/:patientId/active-consultation', getActiveVisit);

router.post('/create-consultation', createConsultation);
router.post('/save-consultation-details', saveConsultationDetails);
router.post('/create-consultation-for-vitals', createConsultationForVitals);
router.post('/save-vital-signs', saveVitalSigns);
router.get('/queue-enhanced/:doctorId', getEnhancedPatientQueue);
router.get('/patient-appointment/:patientId/:doctorId', getPatientAppointment);

router.get('/scheduled-appointments/:doctorId', getScheduledAppointments);
router.get("/appointments-with-visits/:doctorId", getTodayAppointmentsWithVisits);
router.get("/appointments-scheduled/:doctorId", getTodayScheduledAppointments);

// Doctor profile and data
router.get("/profile/:doctorId", getDoctorProfile);
router.get("/appointments/:doctorId", getTodayAppointments);
router.get("/queue/:doctorId", getPatientQueue);  
router.get("/queue-stats/:doctorId", getQueueStats);
router.get("/patient/:patientId", getPatientDetails);

// Patient consultation flow
router.post("/visit-patient", visitPatient);
router.post("/complete-visit", completeVisit);
router.post("/consultation", saveConsultation);

// Follow-up
router.post("/follow-up", scheduleFollowUp);
router.post("/claim-patient", claimPatient);

// Add these to your doctorRoutes.ts

router.get('/patient/:patientId/vitals', getPatientVitals);
router.post('/vital-signs', saveVitalSigns);
router.get('/patient/:patientId/active-visit', getActiveVisit);
router.post('/create-visit', createVisitForVitals);

router.get('/patient-consultation/:patientId', getPatientForConsultation);
router.get('/patient/:patientId/vitals', getPatientVitals);
router.post('/save-vital-signs-consultation', saveVitalSignsWithConsultation);
router.get('/patient/:patientId/allergies', getPatientAllergies);
router.post('/save-allergy', saveAllergyFinding);
router.get('/patient/:patientId/medical-conditions', getPatientMedicalConditions);
router.post('/save-medical-condition', saveMedicalCondition);
router.get('/patient/:patientId/visits', getPatientVisits);

// In your doctor routes file
router.post('/save-consultation-form', saveConsultationForm); // For saving form only
router.post('/complete-consultation', completeConsultation); // For final completion
router.post('/save-consultation-full',saveConsultationFull); // Keep the old one for backward compatibility

// Consultation endpoints
router.post('/save-comprehensive-consultation', saveComprehensiveConsultation);
router.post('/save-consultation-full', saveConsultationFull); // Keep for backward compatibility

// Queue and appointments for consultation tab
router.get('/consultation-queue/:doctorId', getConsultationQueue);
router.get('/all-today-appointments/:doctorId', getAllTodayAppointments);

// Add these routes to doctorRoutes.ts

// Prescription routes
router.post('/prescription/save', savePrescription); // NEW - your frontend calls this
router.get('/patient/:patientId/prescriptions', getPatientPrescriptions); // NEW
router.post('/prescription', createPrescription); // Keep old one for backward compatibility
router.get('/prescriptions/recent', getRecentPrescriptions); // Keep old one
router.get('/prescriptions/consultation/:consultationId',   getPrescriptionsByConsultation);




router.post('/create-follow-up', createFollowUp);

export default router;
