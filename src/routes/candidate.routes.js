const express = require('express');
const { CandidateController } = require('../controllers/Candidate.controller');
const CandidateRouter = express.Router();

CandidateRouter.get("/attendance-list", CandidateController.attendanceList);
CandidateRouter.get("/admin/scanned-list", CandidateController.adminScannedList);
CandidateRouter.get("/verify-payment/:id", CandidateController.verifyPaymentId);

CandidateRouter.get('/', CandidateController.getAllCandidates);           
CandidateRouter.get('/:id', CandidateController.getCandidateById);      

CandidateRouter.post('/create-order', CandidateController.createOrder);   
CandidateRouter.post('/verify-payment', CandidateController.verifyPayment); 
CandidateRouter.post('/', CandidateController.createCandidate);           
CandidateRouter.post('/webhook', CandidateController.webhook);
CandidateRouter.post("/mark-attendance", CandidateController.markAttendance);
CandidateRouter.post('/admin/attendance-scan', CandidateController.adminAttendanceScan);

CandidateRouter.put('/:id', CandidateController.updateCandidate);     
CandidateRouter.delete('/:id', CandidateController.deleteCandidate);     
CandidateRouter.delete('/asm', CandidateController.deleteByName);

module.exports = { CandidateRouter };