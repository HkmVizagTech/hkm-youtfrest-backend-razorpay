const express = require('express');
const { CandidateController } = require('../controllers/Candidate.controller');
const { authenticate } = require('../middlewares/auth.middleware');
const CandidateRouter = express.Router();


CandidateRouter.get("/attendance-list", CandidateController.attendanceList);
CandidateRouter.get("/admin/scanned-list", CandidateController.adminScannedList);
CandidateRouter.get("/eligible-for-certificate", CandidateController.getEligibleCandidatesForCertificate);
CandidateRouter.get("/verify-payment/:id", CandidateController.verifyPaymentId);
CandidateRouter.get("/send", CandidateController.sendTemplate);
// Reminder broadcast — admin-only for the same reason as the slot change:
// it reaches every paid registrant and cannot be recalled.
CandidateRouter.post("/admin/send-event-reminder", authenticate(['admin']), CandidateController.sendEventReminder);
CandidateRouter.get("/admin/reminder-status", authenticate(['admin']), CandidateController.getReminderStatus);

// Flaxxa delivery-status callback. PUBLIC by necessity — Flaxxa posts here and
// cannot send an Authorization header; it is guarded by ?key=WAPI_WEBHOOK_KEY
// instead, and it only ever writes message status, never candidate data.
CandidateRouter.post("/webhooks/wapi", CandidateController.wapiWebhook);
// Catch-up broadcast: re-send the registration confirmation + group link.
CandidateRouter.post("/admin/send-registration-link", authenticate(['admin']), CandidateController.sendRegistrationLink);
CandidateRouter.get("/admin/registration-resend-status", authenticate(['admin']), CandidateController.getRegistrationResendStatus);
CandidateRouter.get("/admin/callback-samples", authenticate(['admin']), CandidateController.getCallbackSamples);
CandidateRouter.get("/admin/template-check", authenticate(['admin']), CandidateController.getTemplateCheck);
CandidateRouter.get("/admin/delivery-report", authenticate(['admin']), CandidateController.getDeliveryReport);

// Slot-change broadcast (Evening merged into Morning). Admin-only — this
// messages hundreds of students and cannot be recalled.
CandidateRouter.post("/admin/send-slot-change", authenticate(['admin']), CandidateController.sendSlotChange);
CandidateRouter.get("/admin/slot-change-status", authenticate(['admin']), CandidateController.getSlotChangeStatus);


CandidateRouter.get("/certificate-statistics", CandidateController.getCertificateStatistics);
CandidateRouter.get("/certificate-system-health", CandidateController.getCertificateSystemHealth);
CandidateRouter.get("/certificate/:documentId", CandidateController.getCertificateByDocumentId);


CandidateRouter.get('/', CandidateController.getAllCandidates);           

CandidateRouter.get("/help-desk/search", authenticate(['admin', 'reception']), CandidateController.helpDeskSearch);
CandidateRouter.post("/help-desk/fix", authenticate(['admin', 'reception']), CandidateController.helpDeskFix);
CandidateRouter.post("/on-spot-register", authenticate(['admin', 'reception']), CandidateController.onSpotRegister);


CandidateRouter.post('/send-certificates', CandidateController.sendCertificates);
CandidateRouter.post('/send-single-certificate', CandidateController.sendSingleCertificate);
CandidateRouter.post('/resend-certificate', CandidateController.resendCertificate); // 🆕 NEW
CandidateRouter.post('/create-order', CandidateController.createOrder);   
CandidateRouter.post('/verify-payment', CandidateController.verifyPayment); 
CandidateRouter.post('/', CandidateController.createCandidate);           
CandidateRouter.post('/webhook', CandidateController.webhook);
CandidateRouter.post("/mark-attendance", CandidateController.markAttendance);
CandidateRouter.post('/admin/attendance-scan', CandidateController.adminAttendanceScan);
CandidateRouter.post('/generate-single-certificate', CandidateController.generateSingleCertificateOnly);


CandidateRouter.put('/:id', authenticate(['admin']), CandidateController.updateCandidate);     
CandidateRouter.delete('/asm', CandidateController.deleteByName);
CandidateRouter.delete('/:id', CandidateController.deleteCandidate);     


CandidateRouter.get('/:id', CandidateController.getCandidateById);   

module.exports = { CandidateRouter };