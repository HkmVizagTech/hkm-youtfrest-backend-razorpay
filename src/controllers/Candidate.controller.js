const Candidate = require('../models/Candidate.model');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const sendWhatsapp = require('../utils/sendWhatsappGupshup'); // ← swap to Flaxxa when API contract is available
const {
  sendCertificateWithCloudinary,
  generateDocumentId,
  generateCertificatePDF,
} = require('../utils/sendCertificateWithTemplate');
require('dotenv').config();

// ── Temp dir for certificate generation ──────────────────────────────────────
const tempDir = path.join(__dirname, '../temp/certificates');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

// ── Razorpay ─────────────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const normalizePhone = (number) => {
  const digits = (number || '').replace(/\D/g, '');
  if (/^\d{10}$/.test(digits)) return '91' + digits;
  if (/^91\d{10}$/.test(digits)) return digits;
  return null;
};

const CandidateController = {
  // ── Public: create Razorpay order + save pending candidate ─────────────────
  createOrder: async (req, res) => {
    const { amount, formData } = req.body;
    const receipt = `receipt_${Date.now()}`;
    try {
      const order = await razorpay.orders.create({ amount, currency: 'INR', receipt });
      const candidate = new Candidate({
        serialNo: formData.serialNo,
        name: formData.name.trim(),
        gender: formData.gender,
        college: formData.college,
        course: formData.course,
        year: formData.year,
        dob: new Date(formData.dob),
        registrationDate: new Date(),
        collegeOrWorking: formData.collegeOrWorking,
        companyName: formData.companyName,
        whatsappNumber: '91' + formData.whatsappNumber,
        slot: formData.slot,
        paymentStatus: 'Pending',
        orderId: order.id,
        paymentAmount: parseFloat(amount) / 100,
        receipt,
        email: formData.email,
      });
      await candidate.save();
      res.json(order);
    } catch (err) {
      console.error('createOrder error:', err.message);
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Public: verify payment signature → mark Paid → send WhatsApp ───────────
  verifyPayment: async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, formData } = req.body;

    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      return res.status(400).json({ status: 'fail', message: 'Payment verification failed' });
    }

    try {
      const candidate = await Candidate.findOne({ orderId: razorpay_order_id });
      if (!candidate) return res.status(404).json({ status: 'fail', message: 'Candidate not found' });
      if (candidate.paymentStatus === 'Paid') return res.json({ message: 'Already Registered', candidate });

      candidate.paymentId = razorpay_payment_id;
      candidate.paymentDate = new Date();
      candidate.paymentStatus = 'Paid';
      candidate.paymentMethod = 'Online';
      candidate.paymentUpdatedBy = 'manual';
      await candidate.save();

      if (candidate.whatsappNumber) {
        await sendWhatsapp(candidate).catch(err =>
          console.error('WhatsApp send failed (non-fatal):', err.message)
        );
      }

      res.json({ message: 'success', candidate });
    } catch (err) {
      console.error('verifyPayment error:', err.message);
      res.status(500).json({ status: 'error', message: 'Registration failed' });
    }
  },

  // ── Public: ThankYou page lookup by Razorpay payment ID ────────────────────
  verifyPaymentId: async (req, res) => {
    try {
      const candidate = await Candidate.findOne({ paymentId: req.params.id });
      if (!candidate) return res.status(404).json({ success: false, message: 'Not found' });
      res.json({ success: true, candidate });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // ── Razorpay webhook ────────────────────────────────────────────────────────
  webhook: async (req, res) => {
    const sig = req.headers['x-razorpay-signature'];
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest('hex');

    if (expected !== sig) return res.status(400).send('Invalid signature');

    const { event, payload } = req.body;
    if (event === 'payment.captured') {
      const payment = payload.payment.entity;
      try {
        const candidate = await Candidate.findOne({ orderId: payment.order_id });
        if (candidate && candidate.paymentStatus !== 'Paid') {
          candidate.paymentStatus = 'Paid';
          candidate.paymentId = payment.id;
          candidate.paymentDate = new Date();
          candidate.paymentMethod = payment.method || 'Online';
          candidate.razorpayPaymentData = payment;
          candidate.paymentUpdatedBy = 'webhook';
          await candidate.save();

          if (candidate.whatsappNumber) {
            await sendWhatsapp(candidate).catch(err =>
              console.error('Webhook WhatsApp send failed (non-fatal):', err.message)
            );
          }
        }
      } catch (err) {
        console.error('Webhook processing error:', err.message);
        return res.status(500).send('error');
      }
    }
    res.json({ status: 'ok' });
  },

  // ── Admin: get all candidates ───────────────────────────────────────────────
  getAllCandidates: async (req, res) => {
    try {
      const { page = 1, limit = 50, paymentStatus } = req.query;
      const query = paymentStatus ? { paymentStatus } : {};
      const candidates = await Candidate.find(query)
        .limit(limit * 1)
        .skip((page - 1) * limit)
        .sort({ registrationDate: -1 });
      const total = await Candidate.countDocuments(query);
      res.json({
        status: 'success',
        candidates,
        pagination: {
          currentPage: +page,
          totalPages: Math.ceil(total / limit),
          totalCandidates: total,
        },
      });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  getCandidateById: async (req, res) => {
    try {
      const candidate = await Candidate.findById(req.params.id);
      if (!candidate) return res.status(404).json({ status: 'error', message: 'Not found' });
      res.json({ status: 'success', candidate });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  updateCandidate: async (req, res) => {
    try {
      const candidate = await Candidate.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
      if (!candidate) return res.status(404).json({ status: 'error', message: 'Not found' });
      res.json({ status: 'success', candidate });
    } catch (err) {
      res.status(400).json({ status: 'error', message: err.message });
    }
  },

  deleteCandidate: async (req, res) => {
    try {
      const candidate = await Candidate.findByIdAndDelete(req.params.id);
      if (!candidate) return res.status(404).json({ status: 'error', message: 'Not found' });
      res.json({ status: 'success', message: 'Deleted successfully' });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  deleteByName: async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ status: 'error', message: 'Name is required' });
      const result = await Candidate.deleteMany({ name: { $regex: new RegExp(name, 'i') } });
      res.json({ status: 'success', deletedCount: result.deletedCount });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Public: attendee marks own attendance by phone ─────────────────────────
  markAttendance: async (req, res) => {
    try {
      const { whatsappNumber } = req.body;
      const normalized = normalizePhone(whatsappNumber);
      if (!normalized) return res.status(400).json({ message: 'Invalid WhatsApp number format' });

      const candidate = await Candidate.findOne({ whatsappNumber: normalized, paymentStatus: 'Paid' }).sort({ createdAt: -1 });
      if (!candidate) {
        const exists = await Candidate.findOne({ whatsappNumber: normalized });
        return res.status(exists ? 403 : 404).json({
          message: exists ? 'Payment not completed. Attendance cannot be marked.' : 'Candidate not found',
        });
      }

      if (!candidate.attendanceToken) {
        candidate.attendanceToken = candidate._id.toString();
        await candidate.save();
      }

      const alreadyMarked = candidate.attendance === true;
      if (!alreadyMarked) {
        candidate.attendance = true;
        candidate.attendanceDate = new Date();
        await candidate.save();
        await sendWhatsapp(candidate, [candidate.name], '88021e4e-88ae-4cba-bdba-f9b1be3b4948').catch(err =>
          console.error('Attendance WhatsApp failed (non-fatal):', err.message)
        );
      }

      res.json({
        status: alreadyMarked ? 'already-marked' : 'success',
        message: alreadyMarked ? 'Attendance already taken' : undefined,
        attendanceToken: candidate.attendanceToken,
        attendanceDate: candidate.attendanceDate,
        name: candidate.name,
        email: candidate.email,
        college: candidate.college,
      });
    } catch (err) {
      console.error('markAttendance error:', err.message);
      res.status(500).json({ message: 'Server error' });
    }
  },

  // ── Admin: QR scan marks admin attendance ──────────────────────────────────
  adminAttendanceScan: async (req, res) => {
    try {
      const { token } = req.body;
      const candidate = await Candidate.findOne({ attendanceToken: token });
      if (!candidate) return res.status(404).json({ message: 'Candidate not found' });
      if (!candidate.attendance) return res.status(400).json({ message: 'Candidate did not mark attendance' });

      const payload = {
        status: candidate.adminAttendance ? 'already-marked' : 'success',
        message: candidate.adminAttendance ? 'Admin already marked attendance' : 'Admin attendance marked successfully',
        name: candidate.name,
        email: candidate.email,
        gender: candidate.gender,
        college: candidate.college,
        branch: candidate.branch,
        phone: candidate.whatsappNumber,
      };

      if (!candidate.adminAttendance) {
        candidate.adminAttendance = true;
        candidate.adminAttendanceDate = new Date();
        await candidate.save();
      }

      res.json(payload);
    } catch (err) {
      console.error('adminAttendanceScan error:', err.message);
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Admin: attendance list ─────────────────────────────────────────────────
  attendanceList: async (req, res) => {
    try {
      const candidates = await Candidate.find({ attendance: true })
        .select('name email whatsappNumber college branch gender slot course attendance attendanceDate registrationDate')
        .sort({ attendanceDate: -1 });
      res.json(candidates);
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Admin: scanned (admin-marked) list ────────────────────────────────────
  adminScannedList: async (req, res) => {
    try {
      const candidates = await Candidate.find({ adminAttendance: true })
        .select('name email whatsappNumber college branch gender slot adminAttendanceDate')
        .sort({ adminAttendanceDate: -1 });
      res.json(candidates);
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Certificate: eligible candidates ──────────────────────────────────────
  getEligibleCandidatesForCertificate: async (req, res) => {
    try {
      const candidates = await Candidate.find(
        { attendance: true, paymentStatus: 'Paid' },
        { _id: 1, name: 1, email: 1, whatsappNumber: 1, college: 1, course: 1, gender: 1,
          attendanceDate: 1, certificateSent: 1, certificateSentDate: 1,
          certificateDocumentId: 1, certificateDriveViewLink: 1 }
      ).sort({ attendanceDate: -1 });

      res.json({
        status: 'success',
        summary: {
          total: candidates.length,
          sent: candidates.filter(c => c.certificateSent).length,
          pending: candidates.filter(c => !c.certificateSent).length,
        },
        candidates,
      });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Certificate: send bulk ─────────────────────────────────────────────────
  sendCertificates: async (req, res) => {
    try {
      const { candidateIds } = req.body;
      const query = { attendance: true, paymentStatus: 'Paid' };
      if (candidateIds?.length) query._id = { $in: candidateIds };

      const candidates = await Candidate.find(query);
      if (!candidates.length) return res.status(404).json({ status: 'error', message: 'No eligible candidates' });

      let success = 0, failed = 0, alreadySent = 0, results = [];

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (c.certificateSent) { alreadySent++; results.push({ name: c.name, status: 'already-sent' }); continue; }

        try {
          const result = await sendCertificateWithCloudinary(c, tempDir);
          if (!result.success) throw new Error(result.error);

          await Candidate.findByIdAndUpdate(c._id, {
            certificateSent: true, certificateSentDate: new Date(),
            certificateDocumentId: result.documentId,
            certificateDriveFileId: result.cloudinary?.publicId,
            certificateDriveViewLink: result.cloudinary?.url,
            certificateFileName: `${result.documentId}.pdf`,
          });
          success++;
          results.push({ name: c.name, status: 'success', documentId: result.documentId });
        } catch (err) {
          failed++;
          results.push({ name: c.name, status: 'failed', error: err.message });
        }

        if (i < candidates.length - 1) await new Promise(r => setTimeout(r, 3000));
      }

      res.json({ status: 'completed', summary: { total: candidates.length, success, failed, alreadySent }, results });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Certificate: send single ───────────────────────────────────────────────
  sendSingleCertificate: async (req, res) => {
    try {
      const { candidateId } = req.body;
      const c = await Candidate.findById(candidateId);
      if (!c) return res.status(404).json({ status: 'error', message: 'Candidate not found' });
      if (!c.attendance || c.paymentStatus !== 'Paid')
        return res.status(400).json({ status: 'error', message: 'Candidate not eligible' });
      if (c.certificateSent)
        return res.json({ status: 'already-sent', message: `Certificate already sent to ${c.name}`, sentDate: c.certificateSentDate });

      const result = await sendCertificateWithCloudinary(c, tempDir);
      if (!result.success) return res.status(500).json({ status: 'error', message: result.error });

      await Candidate.findByIdAndUpdate(candidateId, {
        certificateSent: true, certificateSentDate: new Date(),
        certificateDocumentId: result.documentId,
        certificateDriveFileId: result.cloudinary?.publicId,
        certificateDriveViewLink: result.cloudinary?.url,
        certificateFileName: `${result.documentId}.pdf`,
      });

      res.json({ status: 'success', message: `Certificate sent to ${c.name}`, documentId: result.documentId });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Certificate: resend ────────────────────────────────────────────────────
  resendCertificate: async (req, res) => {
    try {
      const { candidateId } = req.body;
      const c = await Candidate.findById(candidateId);
      if (!c) return res.status(404).json({ status: 'error', message: 'Candidate not found' });
      if (!c.attendance || c.paymentStatus !== 'Paid')
        return res.status(400).json({ status: 'error', message: 'Candidate not eligible' });

      const result = await sendCertificateWithCloudinary(c, tempDir);
      if (!result.success) return res.status(500).json({ status: 'error', message: result.error });

      await Candidate.findByIdAndUpdate(candidateId, {
        certificateSent: true, certificateSentDate: new Date(),
        certificateDocumentId: result.documentId,
        certificateDriveFileId: result.cloudinary?.publicId,
        certificateDriveViewLink: result.cloudinary?.url,
      });

      res.json({ status: 'success', message: `Certificate resent to ${c.name}`, documentId: result.documentId });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Certificate: stats ─────────────────────────────────────────────────────
  getCertificateStatistics: async (req, res) => {
    try {
      const total = await Candidate.countDocuments({ attendance: true, paymentStatus: 'Paid' });
      const sent = await Candidate.countDocuments({ attendance: true, paymentStatus: 'Paid', certificateSent: true });
      res.json({ status: 'success', statistics: { total, sent, pending: total - sent } });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Certificate: system health ─────────────────────────────────────────────
  getCertificateSystemHealth: async (req, res) => {
    try {
      const tempOk = fs.existsSync(tempDir);
      const cloudinaryOk = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
      const whatsappOk = !!(process.env.GUPSHUP_API_KEY || process.env.FLAXXA_WAPI_TOKEN);
      res.json({
        status: 'success',
        health: {
          overall: cloudinaryOk && tempOk ? 'healthy' : 'degraded',
          cloudinary: cloudinaryOk ? 'configured' : 'missing-config',
          whatsapp: whatsappOk ? 'configured' : 'missing-config',
          tempDirectory: tempOk ? 'healthy' : 'unhealthy',
        },
      });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Certificate: fetch by document ID ──────────────────────────────────────
  getCertificateByDocumentId: async (req, res) => {
    try {
      const candidate = await Candidate.findOne({ certificateDocumentId: req.params.documentId });
      if (!candidate) return res.status(404).json({ status: 'error', message: 'Certificate not found' });
      res.json({
        status: 'success',
        certificate: {
          documentId: req.params.documentId,
          name: candidate.name,
          email: candidate.email,
          college: candidate.college,
          sentDate: candidate.certificateSentDate,
          viewLink: candidate.certificateDriveViewLink,
          fileName: candidate.certificateFileName,
        },
      });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Certificate: generate only (no send) ───────────────────────────────────
  generateSingleCertificateOnly: async (req, res) => {
    try {
      const { candidateId } = req.body;
      const candidate = await Candidate.findById(candidateId);
      if (!candidate) return res.status(404).json({ status: 'error', message: 'Candidate not found' });
      if (!candidate.attendance || candidate.paymentStatus !== 'Paid')
        return res.status(400).json({ status: 'error', message: 'Candidate not eligible' });

      const documentId = generateDocumentId(candidate.name);
      const outputPath = path.join(tempDir, `${documentId}.pdf`);
      const certData = await generateCertificatePDF(candidate.name, outputPath, documentId);

      res.json({ status: 'success', documentId, path: certData.outputPath, name: candidate.name });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Admin: manually create a candidate ─────────────────────────────────────
  createCandidate: async (req, res) => {
    try {
      const candidate = new Candidate({ ...req.body, registrationDate: new Date() });
      await candidate.save();
      res.status(201).json({ status: 'success', message: 'Candidate created successfully', candidate });
    } catch (err) {
      res.status(400).json({ status: 'error', message: err.message });
    }
  },

  // ── Bulk WhatsApp template send ────────────────────────────────────────────
  sendTemplate: async (req, res) => {
    try {
      const { slot, templateParams } = req.body;
      const query = { paymentStatus: 'Paid' };
      if (slot) query.slot = slot;

      const users = await Candidate.find(query);
      const valid = users.filter(u => normalizePhone(u.whatsappNumber));
      const results = [];

      for (const user of valid) {
        try {
          // TODO: replace with Flaxxa WAPI template call when API contract is available
          await sendWhatsapp(user, templateParams, process.env.GUPSHUP_TEMPLATE_ID);
          results.push({ name: user.name, status: 'sent' });
        } catch (err) {
          results.push({ name: user.name, status: 'failed', error: err.message });
        }
      }

      res.json({ total: users.length, valid: valid.length, results });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },
};

module.exports = { CandidateController };
