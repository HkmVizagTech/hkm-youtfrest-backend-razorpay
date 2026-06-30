const express = require('express');
const { CandidateController } = require('../controllers/Candidate.controller');
const CandidateRouter = express.Router();


CandidateRouter.get("/attendance-list", CandidateController.attendanceList);
CandidateRouter.get("/admin/scanned-list", CandidateController.adminScannedList);
CandidateRouter.get("/eligible-for-certificate", CandidateController.getEligibleCandidatesForCertificate);
CandidateRouter.get("/verify-payment/:id", CandidateController.verifyPaymentId);
CandidateRouter.get("/send", CandidateController.sendTemplate);
CandidateRouter.post("/admin/send-event-reminder", CandidateController.sendEventReminder);


CandidateRouter.get("/certificate-statistics", CandidateController.getCertificateStatistics);
CandidateRouter.get("/certificate-system-health", CandidateController.getCertificateSystemHealth);
CandidateRouter.get("/certificate/:documentId", CandidateController.getCertificateByDocumentId);


CandidateRouter.get('/', CandidateController.getAllCandidates);           


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


CandidateRouter.put('/:id', CandidateController.updateCandidate);     
CandidateRouter.delete('/asm', CandidateController.deleteByName);
CandidateRouter.delete('/:id', CandidateController.deleteCandidate);     


CandidateRouter.get('/:id', CandidateController.getCandidateById);   

module.exports = { CandidateRouter };