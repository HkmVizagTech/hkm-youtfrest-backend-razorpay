const Candidate = require('../models/Candidate.model');
const MessageLog = require('../models/MessageLog.model');
const whatsapp = require('../utils/whatsapp');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const sendWhatsapp = require('../utils/sendWhatsappFlaxxa');
const { e164 } = sendWhatsapp;
const {
  sendCertificateWithCloudinary,
  generateDocumentId,
  generateCertificatePDF,
  uploadToCloudinary,
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
// ── Closed slots ─────────────────────────────────────────────────────────────
// The Evening slot was merged into the Morning one on 4 Sep 2026. The dropdown
// is gone from both registration forms, but a student sitting on a cached JS
// bundle — or already midway through Razorpay checkout — can still post
// slot:"Evening". Rejecting them would fail a payment that may already have
// been charged, so coerce instead: they are saved as Morning, which is where
// they are actually expected, and the event reminders reach them correctly.
// Set CLOSED_SLOTS="" on Railway to reopen without a deploy.
const CLOSED_SLOTS = (process.env.CLOSED_SLOTS ?? 'Evening')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SLOT_FALLBACK = process.env.SLOT_FALLBACK || 'Morning';

const resolveSlot = (slot, who = '') => {
  if (slot && CLOSED_SLOTS.includes(String(slot).trim().toLowerCase())) {
    console.warn(`⚠️ "${slot}" slot is closed — saving ${who || 'registration'} as ${SLOT_FALLBACK}`);
    return SLOT_FALLBACK;
  }
  return slot;
};

// Record every accepted send so a delivery callback has something to update.
// `accepted` is deliberately not the same word as `delivered` — see
// MessageLog.model.js for why that distinction cost us 165 messages.
const logSend = (candidate, kind, template, result) =>
  MessageLog.create({
    provider: result?.provider || 'flaxxa',
    wamid: result?.message_wamid,
    messageId: String(result?.message_id ?? ''),
    candidateId: candidate._id,
    name: candidate.name,
    phone: candidate.whatsappNumber,
    kind,
    template,
    status: 'accepted',
    sentAt: new Date(),
  }).catch(err => console.warn('[msglog] could not record send:', err.message));

// Registration confirmations fire continuously as students pay, from three
// different entry points (verifyPayment, the Razorpay webhook, and on-spot
// walk-in registration). Route them all through one place so the provider,
// the gender→group choice and the delivery record stay consistent.
const sendRegistrationConfirmation = (candidate, where) =>
  whatsapp.sendRegistration(candidate)
    .then(r => {
      if (r?.skipped) return;
      const group = String(candidate.gender || '').trim().toLowerCase() === 'female' ? 'girls' : 'boys';
      return logSend(candidate, 'registration', `${r?.provider || 'flaxxa'}:${group}`, r);
    })
    .catch(err =>
      console.error(`Registration WhatsApp failed for ${candidate.name} (${where}):`, err.message)
    );

const normalizePhone = (number) => {
  const digits = (number || '').replace(/\D/g, '');
  if (/^\d{10}$/.test(digits)) return '91' + digits;
  if (/^91\d{10}$/.test(digits)) return digits;
  return null;
};

// Razorpay's SDK throws errors shaped like { error: { description, code } }
// rather than a normal Error with a .message — without this, failures were
// logged (and shown to the student) as a bare "undefined".
const describeError = (err) =>
  err?.error?.description || err?.message || 'Something went wrong';

// The Razorpay SDK exposes no timeout option and uses axios with no default
// timeout internally — a slow/hanging response from Razorpay's API would
// otherwise hang this call (and the student's browser) indefinitely. Race it
// against a hard deadline so it always fails fast and predictably instead.
const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);

// In-memory progress for the slot-change broadcast. Deliberately not the source
// of truth — that is slotChangeNotifiedAt on each candidate, so a restart
// mid-broadcast loses the counter but never re-messages anyone already done.
let slotChangeRun = {
  running: false, total: 0, sent: 0, failed: 0,
  startedAt: null, finishedAt: null, failures: [],
};

// kp_slot_change on the Gupshup WABA — same body as the Flaxxa template,
// verified end-to-end (submitted AND actually received) on 4 Sep 2026, after
// the Flaxxa number was rate-limited by Meta.
const GUPSHUP_SLOTCHANGE_ID = 'd7c6e193-b649-483c-8e11-afc969d84eb0';

// Reminder broadcast progress. Same deal — the durable record is the
// remindersSent.<type> flag on each candidate, not this counter.
let registrationResendRun = {
  running: false, total: 0, sent: 0, failed: 0,
  startedAt: null, finishedAt: null, failures: [],
};

const REMINDER_TYPES = ['threeDay', 'twoDay', 'oneDay', 'eventDay', 'twoHour'];
let reminderRun = {
  running: false, type: null, total: 0, sent: 0, failed: 0,
  startedAt: null, finishedAt: null, failures: [],
};

const CandidateController = {
  // ── Public: create Razorpay order + save pending candidate ─────────────────
  createOrder: async (req, res) => {
    const { amount, formData } = req.body;
    const receipt = `receipt_${Date.now()}`;

    // Validate before touching Razorpay — avoids creating orphaned orders on
    // Razorpay's side when the request is malformed.
    if (!formData || !formData.name || !formData.name.trim()) {
      return res.status(400).json({ status: 'error', message: 'Name is required' });
    }
    if (!formData.whatsappNumber || !/^\d{10}$/.test(String(formData.whatsappNumber).replace(/\D/g, ''))) {
      return res.status(400).json({ status: 'error', message: 'A valid 10-digit WhatsApp number is required' });
    }
    if (!formData.dob || isNaN(new Date(formData.dob).getTime())) {
      return res.status(400).json({ status: 'error', message: 'A valid date of birth is required' });
    }
    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({ status: 'error', message: 'A valid amount is required' });
    }

    try {
      const order = await withTimeout(
        razorpay.orders.create({ amount: numericAmount, currency: 'INR', receipt }),
        15000,
        'Razorpay order creation'
      );
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
        accommodationType: formData.accommodationType,
        companyName: formData.companyName,
        whatsappNumber: normalizePhone(formData.whatsappNumber),
        slot: resolveSlot(formData.slot, formData.name),
        paymentStatus: 'Pending',
        orderId: order.id,
        paymentAmount: numericAmount / 100,
        receipt,
        email: formData.email,
        utmSource: formData.utmSource,
        utmMedium: formData.utmMedium,
        utmCampaign: formData.utmCampaign,
        utmTerm: formData.utmTerm,
        utmContent: formData.utmContent,
      });
      await candidate.save();
      res.json(order);
    } catch (err) {
      const message = describeError(err);
      console.error('createOrder error:', message);
      res.status(500).json({ status: 'error', message });
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
      let candidate = await Candidate.findOne({ orderId: razorpay_order_id });

      if (!candidate) {
        // The signature is valid — Razorpay genuinely charged this payment —
        // but we have no matching "Pending" record (e.g. it was never saved
        // due to a transient DB hiccup during createOrder). Rather than
        // losing a paid registration behind a 404, reconstruct it from the
        // formData the client already has.
        console.warn(`verifyPayment: no candidate found for order ${razorpay_order_id} — reconstructing from formData`);
        if (!formData || !formData.whatsappNumber) {
          return res.status(404).json({
            status: 'fail',
            message: 'We could not locate your registration, but your payment ID has been logged. Please contact support with this payment ID.',
            paymentId: razorpay_payment_id,
          });
        }
        candidate = new Candidate({
          serialNo: formData.serialNo,
          name: (formData.name || '').trim(),
          gender: formData.gender,
          college: formData.college,
          course: formData.course,
          year: formData.year,
          dob: formData.dob ? new Date(formData.dob) : undefined,
          registrationDate: new Date(),
          collegeOrWorking: formData.collegeOrWorking,
          accommodationType: formData.accommodationType,
          companyName: formData.companyName,
          whatsappNumber: normalizePhone(formData.whatsappNumber) || String(formData.whatsappNumber),
          slot: resolveSlot(formData.slot, formData.name),
          orderId: razorpay_order_id,
          paymentAmount: formData.paymentAmount || 49,
          email: formData.email,
        });
      }

      if (candidate.paymentStatus === 'Paid') return res.json({ message: 'Already Registered', candidate });

      candidate.paymentId = razorpay_payment_id;
      candidate.paymentDate = new Date();
      candidate.paymentStatus = 'Paid';
      candidate.paymentMethod = 'Online';
      candidate.paymentUpdatedBy = 'manual';
      // Assign every paid candidate their own attendance token right away —
      // not lazily when they check in. This guarantees each registration
      // (even ones sharing a WhatsApp number with someone else, e.g. a
      // parent registering multiple kids) always has its own valid QR pass.
      if (!candidate.attendanceToken) {
        candidate.attendanceToken = candidate._id.toString();
      }
      await candidate.save();

      // Respond to the student immediately — their payment is confirmed and
      // saved. WhatsApp is sent in the background (fire-and-forget) so a
      // slow message provider never delays their confirmation screen.
      res.json({ message: 'success', candidate });

      if (candidate.whatsappNumber) {
        sendRegistrationConfirmation(candidate, 'verifyPayment').catch(err =>
          console.error('WhatsApp send failed (non-fatal):', err.message)
        );
      }
    } catch (err) {
      console.error('verifyPayment error:', describeError(err));
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
        if (candidate) {
          candidate.paymentStatus = 'Paid';
          candidate.paymentId = payment.id;
          candidate.paymentDate = new Date();
          candidate.paymentMethod = payment.method || 'Online';
          candidate.razorpayPaymentData = payment;
          candidate.paymentUpdatedBy = 'webhook';
          if (!candidate.rrn) {
            candidate.rrn = (payment.acquirer_data && payment.acquirer_data.rrn) || payment.rrn || null;
          }
          if (!candidate.attendanceToken) {
            candidate.attendanceToken = candidate._id.toString();
          }
          await candidate.save();

          if (candidate.whatsappNumber) {
            sendRegistrationConfirmation(candidate, 'webhook').catch(err =>
              console.error('Webhook WhatsApp send failed (non-fatal):', err.message)
            );
          }
        }
      } catch (err) {
        console.error('Webhook processing error:', describeError(err));
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

      // `limit=all` (or no limit/page requested at all) returns every
      // matching candidate — the admin "All Candidates" view does its own
      // filtering/search/export client-side on the full list, so it needs
      // everything in one response rather than a 50-per-page slice.
      const wantsAll = limit === 'all' || (!req.query.limit && !req.query.page);

      let candidatesQuery = Candidate.find(query).sort({ registrationDate: -1 });
      if (!wantsAll) {
        candidatesQuery = candidatesQuery.limit(limit * 1).skip((page - 1) * limit);
      }

      const candidates = await candidatesQuery;
      const total = await Candidate.countDocuments(query);
      res.json({
        status: 'success',
        candidates,
        pagination: wantsAll
          ? { currentPage: 1, totalPages: 1, totalCandidates: total }
          : { currentPage: +page, totalPages: Math.ceil(total / limit), totalCandidates: total },
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
      const updates = { ...req.body };
      if (updates.whatsappNumber) {
        const normalized = normalizePhone(updates.whatsappNumber);
        if (!normalized) {
          return res.status(400).json({ status: 'error', message: 'Enter a valid 10-digit WhatsApp number' });
        }
        updates.whatsappNumber = normalized;
      }
      const candidate = await Candidate.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
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
      const { whatsappNumber, candidateId } = req.body;
      const normalized = normalizePhone(whatsappNumber);
      if (!normalized) return res.status(400).json({ message: 'Invalid WhatsApp number format' });

      const paidMatches = await Candidate.find({ whatsappNumber: normalized, paymentStatus: 'Paid' }).sort({ createdAt: 1 });

      if (paidMatches.length === 0) {
        const exists = await Candidate.findOne({ whatsappNumber: normalized });
        return res.status(exists ? 403 : 404).json({
          message: exists ? 'Payment not completed. Attendance cannot be marked.' : 'Candidate not found',
        });
      }

      // Multiple paid registrations share this number (e.g. a parent
      // registered several kids under one number). Without a specific
      // choice, we don't know who's actually checking in — ask instead of
      // guessing, which used to silently pick the most recent one and made
      // earlier registrations impossible to check in.
      if (paidMatches.length > 1 && !candidateId) {
        return res.json({
          status: 'multiple',
          message: `We found ${paidMatches.length} registrations under this number. Please select who's checking in.`,
          candidates: paidMatches.map(c => ({ id: c._id, name: c.name, attendance: !!c.attendance })),
        });
      }

      const candidate = candidateId
        ? paidMatches.find(c => c._id.toString() === candidateId)
        : paidMatches[0];

      if (!candidate) return res.status(404).json({ message: 'Candidate not found' });

      if (!candidate.attendanceToken) {
        candidate.attendanceToken = candidate._id.toString();
        await candidate.save();
      }

      const alreadyMarked = candidate.attendance === true;
      if (!alreadyMarked) {
        candidate.attendance = true;
        candidate.attendanceDate = new Date();
        await candidate.save();
        sendWhatsapp.sendAttendanceConfirmed(candidate).catch(err =>
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
        .select('name email whatsappNumber college branch gender slot course rrn attendance attendanceDate registrationDate')
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
        .select('name email whatsappNumber college branch gender slot rrn utr adminAttendanceDate paymentMethod')
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
          const documentId = generateDocumentId(c.name);
          const outputPath = path.join(tempDir, `${documentId}.pdf`);
          await generateCertificatePDF(c.name, outputPath, documentId);

          const cloudinaryResult = await uploadToCloudinary(outputPath, documentId);
          if (!cloudinaryResult.success) throw new Error(`Cloudinary upload failed: ${cloudinaryResult.error}`);

          // Send via Flaxxa WhatsApp BEFORE marking it sent — otherwise a failed
          // delivery still flips certificateSent and nobody ever retries.
          // sendCertificate throws when Flaxxa or Meta reject the message.
          const waResult = await sendWhatsapp.sendCertificate(c, cloudinaryResult.url, documentId);
          if (waResult && waResult.skipped) {
            throw new Error('WAPI_TMPL_CERTIFICATE is not set — WhatsApp delivery skipped');
          }

          await Candidate.findByIdAndUpdate(c._id, {
            certificateSent: true, certificateSentDate: new Date(),
            certificateDocumentId: documentId,
            certificateDriveFileId: cloudinaryResult.publicId,
            certificateDriveViewLink: cloudinaryResult.url,
            certificateFileName: `${documentId}.pdf`,
          });

          // Clean up temp file
          try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}

          success++;
          results.push({ name: c.name, status: 'success', documentId, wamid: waResult?.message_wamid });
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

      const documentId = generateDocumentId(c.name);
      const outputPath = path.join(tempDir, `${documentId}.pdf`);
      await generateCertificatePDF(c.name, outputPath, documentId);

      const cloudinaryResult = await uploadToCloudinary(outputPath, documentId);
      if (!cloudinaryResult.success) {
        return res.status(500).json({ status: 'error', message: `Cloudinary upload failed: ${cloudinaryResult.error}` });
      }

      // Send on WhatsApp first — only mark it sent once Meta has accepted it.
      let waResult;
      try {
        waResult = await sendWhatsapp.sendCertificate(c, cloudinaryResult.url, documentId);
        if (waResult && waResult.skipped) {
          throw new Error('WAPI_TMPL_CERTIFICATE is not set — WhatsApp delivery skipped');
        }
      } catch (waErr) {
        console.error(`Certificate WhatsApp failed for ${c.name}:`, waErr.message);
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
        return res.status(502).json({
          status: 'error',
          message: `Certificate generated but WhatsApp delivery failed: ${waErr.message}`,
          documentId,
          certificateUrl: cloudinaryResult.url,
        });
      }

      await Candidate.findByIdAndUpdate(candidateId, {
        certificateSent: true, certificateSentDate: new Date(),
        certificateDocumentId: documentId,
        certificateDriveFileId: cloudinaryResult.publicId,
        certificateDriveViewLink: cloudinaryResult.url,
        certificateFileName: `${documentId}.pdf`,
      });

      // Clean up temp file
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}

      res.json({ status: 'success', message: `Certificate sent to ${c.name}`, documentId, wamid: waResult?.message_wamid });
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

      const documentId = generateDocumentId(c.name);
      const outputPath = path.join(tempDir, `${documentId}.pdf`);
      await generateCertificatePDF(c.name, outputPath, documentId);

      const cloudinaryResult = await uploadToCloudinary(outputPath, documentId);
      if (!cloudinaryResult.success) {
        return res.status(500).json({ status: 'error', message: `Cloudinary upload failed: ${cloudinaryResult.error}` });
      }

      let waResult;
      try {
        waResult = await sendWhatsapp.sendCertificate(c, cloudinaryResult.url, documentId);
        if (waResult && waResult.skipped) {
          throw new Error('WAPI_TMPL_CERTIFICATE is not set — WhatsApp delivery skipped');
        }
      } catch (waErr) {
        console.error(`Certificate WhatsApp failed for ${c.name}:`, waErr.message);
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
        return res.status(502).json({
          status: 'error',
          message: `Certificate generated but WhatsApp delivery failed: ${waErr.message}`,
          documentId,
          certificateUrl: cloudinaryResult.url,
        });
      }

      await Candidate.findByIdAndUpdate(candidateId, {
        certificateSent: true, certificateSentDate: new Date(),
        certificateDocumentId: documentId,
        certificateDriveFileId: cloudinaryResult.publicId,
        certificateDriveViewLink: cloudinaryResult.url,
      });

      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}

      res.json({ status: 'success', message: `Certificate resent to ${c.name}`, documentId, wamid: waResult?.message_wamid });
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
      // Flaxxa is the live provider; the token env var is WAPI_TOKEN (the old
      // FLAXXA_WAPI_TOKEN name never existed, so this always read "missing").
      const whatsappOk = !!(process.env.WAPI_TOKEN && process.env.WAPI_TMPL_CERTIFICATE);
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
          // Generic template send — uses sendTemplate directly for flexibility
          await sendWhatsapp.sendTemplate(e164(user.whatsappNumber), process.env.GUPSHUP_TEMPLATE_ID, templateParams || []);
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

  // ── Admin: slot-change broadcast (Template #5) ─────────────────────────────
  // Tells Evening-slot registrants their slot has been merged into the Morning
  // one. Deliberately does NOT modify `slot` — reception still sees what the
  // student originally booked; only the notification state is recorded.
  //
  // Two safety properties matter more than anything here, because this fires at
  // hundreds of real students two days before the event and cannot be recalled:
  //   1. dryRun defaults to TRUE. You must pass dryRun:false to send anything.
  //   2. Every success is stamped with slotChangeNotifiedAt, and already-stamped
  //      candidates are skipped, so re-running never double-messages anyone.
  //
  // The send runs in the BACKGROUND: ~160 messages at a polite throttle takes
  // minutes, far longer than any HTTP request should be held open. Poll
  // GET /users/admin/slot-change-status for progress — the DB is the source
  // of truth, so progress survives a restart mid-run.
  sendSlotChange: async (req, res) => {
    try {
      const {
        slot = 'Evening',
        reportingTime,
        meal,
        dryRun = true,
        resend = false,
        limit,
        candidateIds,
      } = req.body || {};

      if (!reportingTime || !meal) {
        return res.status(400).json({
          status: 'error',
          message: 'reportingTime ({{2}}) and meal ({{3}}) are both required',
        });
      }
      if (slotChangeRun.running) {
        return res.status(409).json({
          status: 'error',
          message: 'A slot-change broadcast is already running',
          progress: slotChangeRun,
        });
      }

      const query = { paymentStatus: 'Paid' };
      if (candidateIds?.length) query._id = { $in: candidateIds };
      else query.slot = slot;
      if (!resend) query.slotChangeNotifiedAt = { $exists: false };

      let targets = await Candidate.find(query).sort({ registrationDate: 1 });
      targets = targets.filter(c => normalizePhone(c.whatsappNumber));
      if (limit) targets = targets.slice(0, Number(limit));

      const preview = {
        status: 'success',
        dryRun: !!dryRun,
        provider: whatsapp.providerFor('slotchange'),
        templateName: whatsapp.providerFor('slotchange') === 'gupshup'
          ? (process.env.GUPSHUP_TMPL_SLOTCHANGE || GUPSHUP_SLOTCHANGE_ID)
          : (process.env.WAPI_TMPL_SLOT_CHANGE || 'kp_slot_change'),
        targeted: targets.length,
        reportingTime,
        meal,
        sample: targets.slice(0, 5).map(c => ({
          name: c.name, phone: c.whatsappNumber, slot: c.slot, gender: c.gender,
        })),
      };

      if (dryRun) {
        preview.message =
          `DRY RUN — nothing sent. ${targets.length} candidate(s) would receive the ` +
          `slot-change notice. Re-send with dryRun:false to actually deliver.`;
        return res.json(preview);
      }

      if (!targets.length) {
        return res.json({ ...preview, message: 'Nothing to send — no matching candidates' });
      }

      // Fire and forget; the client polls the status endpoint.
      slotChangeRun = {
        running: true, total: targets.length, sent: 0, failed: 0,
        startedAt: new Date(), finishedAt: null, failures: [],
      };
      res.json({
        ...preview,
        started: true,
        message:
          `Sending to ${targets.length} candidate(s) in the background. ` +
          `Poll GET /users/admin/slot-change-status for progress.`,
      });

      const throttleMs = Number(process.env.SLOT_CHANGE_THROTTLE_MS || 1200);
      (async () => {
        for (const c of targets) {
          try {
            // Routed by WHATSAPP_PROVIDER_SLOTCHANGE. The Flaxxa number hit a
            // Meta spam rate limit on 4 Sep and dropped 165 accepted messages;
            // Gupshup is a separate registered number with its own limits.
            const r = await whatsapp.sendText('slotchange', c, {
              flaxxaTemplate: process.env.WAPI_TMPL_SLOT_CHANGE || 'kp_slot_change',
              gupshupTemplate: process.env.GUPSHUP_TMPL_SLOTCHANGE || GUPSHUP_SLOTCHANGE_ID,
              values: [reportingTime, meal],
            });
            if (r?.skipped) throw new Error('WAPI_TMPL_SLOT_CHANGE not configured');
            await Candidate.findByIdAndUpdate(c._id, {
              slotChangeNotifiedAt: new Date(),
              slotChangeWamid: r.message_wamid,
              slotChangeOriginalSlot: c.slot,
              slotChangeError: undefined,
            });
            await logSend(c, 'slotChange', preview.templateName, r);
            slotChangeRun.sent++;
          } catch (err) {
            slotChangeRun.failed++;
            slotChangeRun.failures.push({ name: c.name, phone: c.whatsappNumber, error: err.message });
            await Candidate.findByIdAndUpdate(c._id, { slotChangeError: err.message }).catch(() => {});
            console.error(`❌ Slot change failed for ${c.name}:`, err.message);
          }
          await new Promise(r => setTimeout(r, throttleMs));
        }
        slotChangeRun.running = false;
        slotChangeRun.finishedAt = new Date();
        console.log(
          `📣 Slot-change broadcast finished — sent ${slotChangeRun.sent}, failed ${slotChangeRun.failed}`
        );
      })();
    } catch (err) {
      slotChangeRun.running = false;
      if (!res.headersSent) res.status(500).json({ status: 'error', message: err.message });
    }
  },




  // ── Admin: re-send the registration confirmation (group link) ──────────────
  // Not the same thing as the automatic confirmation on payment — this is a
  // catch-up broadcast for students whose original message never arrived, or
  // arrived with a dead rebrand.ly button. Same safety shape as the slot-change
  // broadcast: dryRun defaults true, every success is stamped so a re-run never
  // double-messages, and it runs in the background because ~900 messages is far
  // longer than an HTTP request should be held open.
  sendRegistrationLink: async (req, res) => {
    try {
      const { dryRun = true, resend = false, limit, gender, candidateIds } = req.body || {};

      if (registrationResendRun.running) {
        return res.status(409).json({
          status: 'error',
          message: 'A registration re-send is already running',
          progress: registrationResendRun,
        });
      }

      const query = { paymentStatus: 'Paid' };
      if (candidateIds?.length) query._id = { $in: candidateIds };
      if (gender) query.gender = gender;
      if (!resend) query.registrationResentAt = { $exists: false };

      let targets = await Candidate.find(query).sort({ registrationDate: 1 });
      targets = targets.filter(c => normalizePhone(c.whatsappNumber));
      if (limit) targets = targets.slice(0, Number(limit));

      const male = targets.filter(c => String(c.gender || '').toLowerCase() !== 'female').length;

      const preview = {
        status: 'success',
        dryRun: !!dryRun,
        provider: whatsapp.providerFor('registration'),
        targeted: targets.length,
        split: { boysGroup: male, girlsGroup: targets.length - male },
        sample: targets.slice(0, 5).map(c => ({
          name: c.name, phone: c.whatsappNumber, gender: c.gender,
        })),
      };

      if (dryRun) {
        preview.message =
          `DRY RUN — nothing sent. ${targets.length} student(s) would be re-sent their ` +
          `group link. Re-send with dryRun:false to actually deliver.`;
        return res.json(preview);
      }
      if (!targets.length) {
        return res.json({ ...preview, message: 'Nothing to send' });
      }

      registrationResendRun = {
        running: true, total: targets.length, sent: 0, failed: 0,
        startedAt: new Date(), finishedAt: null, failures: [],
      };
      res.json({
        ...preview,
        started: true,
        message:
          `Re-sending to ${targets.length} student(s) in the background. ` +
          `Poll GET /users/admin/registration-resend-status for progress.`,
      });

      const throttleMs = Number(process.env.REGISTRATION_RESEND_THROTTLE_MS || 1200);
      (async () => {
        for (const c of targets) {
          try {
            const r = await whatsapp.sendRegistration(c);
            if (r?.skipped) throw new Error('registration template not configured');
            await Candidate.findByIdAndUpdate(c._id, {
              registrationResentAt: new Date(),
              registrationResendWamid: r.message_wamid,
              registrationResendError: undefined,
            });
            const group = String(c.gender || '').toLowerCase() === 'female' ? 'girls' : 'boys';
            await logSend(c, 'registration-resend', `${r?.provider || 'flaxxa'}:${group}`, r);
            registrationResendRun.sent++;
          } catch (err) {
            registrationResendRun.failed++;
            registrationResendRun.failures.push({ name: c.name, phone: c.whatsappNumber, error: err.message });
            await Candidate.findByIdAndUpdate(c._id, { registrationResendError: err.message }).catch(() => {});
            console.error(`❌ Registration re-send failed for ${c.name}:`, err.message);
          }
          await new Promise(r => setTimeout(r, throttleMs));
        }
        registrationResendRun.running = false;
        registrationResendRun.finishedAt = new Date();
        console.log(
          `📣 Registration re-send finished — sent ${registrationResendRun.sent}, failed ${registrationResendRun.failed}`
        );
      })();
    } catch (err) {
      registrationResendRun.running = false;
      if (!res.headersSent) res.status(500).json({ status: 'error', message: err.message });
    }
  },

  getRegistrationResendStatus: async (req, res) => {
    try {
      const [paid, resent, errored] = await Promise.all([
        Candidate.countDocuments({ paymentStatus: 'Paid' }),
        Candidate.countDocuments({ paymentStatus: 'Paid', registrationResentAt: { $exists: true } }),
        Candidate.countDocuments({ paymentStatus: 'Paid', registrationResendError: { $exists: true, $ne: null } }),
      ]);
      res.json({
        status: 'success', paid, resent, pending: paid - resent, errored,
        currentRun: registrationResendRun,
      });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Preflight: does every configured template actually work? ───────────────
  // Every failure this week was a mismatch discovered only by sending:
  //   • kp_slot_change sent 3 variables to a 1-variable template (certificate)
  //   • reminders assumed 3 variables where the real templates take 4, 3 and 1
  //   • a MARKETING template used for a bulk run that Meta then throttled
  // All of it is answerable from Gupshup's template API before anyone sends.
  getTemplateCheck: async (req, res) => {
    try {
      const { GUPSHUP_TEMPLATES } = require('../utils/whatsappTemplates');
      const gupshup = require('../utils/sendWhatsappGupshupTemplate');

      let remote = [];
      let listError = null;
      try {
        remote = await gupshup.listTemplates();
      } catch (err) {
        listError = err.message;
      }
      const byId = new Map(remote.map(t => [t.id, t]));

      const rows = Object.entries(GUPSHUP_TEMPLATES).map(([kind, t]) => {
        const live = byId.get(t.id);
        const body = String(live?.data || '');
        const actualVars = new Set(body.match(/\{\{(\d+)\}\}/g) || []).size;
        const problems = [];

        if (!live) problems.push('not found on this Gupshup app');
        else {
          if (live.status !== 'APPROVED') problems.push(`status is ${live.status}, not APPROVED`);
          if (actualVars !== t.vars) {
            problems.push(`template has ${actualVars} variable(s) but the code sends ${t.vars} — Meta would drop this silently`);
          }
          if (live.category === 'MARKETING') {
            problems.push('MARKETING category — throttled harder than UTILITY, risky for bulk sends');
          }
        }

        return {
          kind,
          expects: t.vars,
          id: t.id,
          name: live?.elementName || t.name,
          status: live?.status || 'MISSING',
          category: live?.category || '—',
          type: live?.templateType || '—',
          actualVars: live ? actualVars : null,
          ok: problems.length === 0,
          problems,
        };
      });

      let wallet = null;
      try { wallet = await gupshup.walletBalance(); } catch (e) { /* non-fatal */ }

      res.json({
        status: 'success',
        ready: rows.every(r => r.ok) && !listError,
        listError,
        wallet,
        walletWarning: wallet != null && wallet < 50
          ? `Only ₹${wallet} left — a large run will stop partway`
          : undefined,
        providers: whatsapp.providerStatus(),
        templates: rows,
      });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Flaxxa delivery-status callback ────────────────────────────────────────
  // Configure this URL in Flaxxa → Developer as the webhook / callback target:
  //   POST https://<backend>/users/webhooks/wapi?key=<WAPI_WEBHOOK_KEY>
  //
  // Flaxxa's callback body shape is undocumented and no status endpoint exists
  // (every plausible /api/v1 path 404s), so this parser is deliberately loose:
  // it walks whatever JSON arrives looking for a wamid and a status word, and
  // stores the raw body either way. Once real callbacks land, tighten it using
  // the stored samples rather than guessing.
  wapiWebhook: async (req, res) => {
    // Always 200 quickly — a webhook that errors or hangs gets retried or
    // disabled by the sender, and we would rather keep the samples flowing.
    res.status(200).json({ received: true });

    try {
      const key = process.env.WAPI_WEBHOOK_KEY;
      if (key && req.query.key !== key) {
        console.warn('[wapi-hook] rejected callback with bad key');
        return;
      }

      const body = req.body || {};
      const flat = JSON.stringify(body);

      // Three payload shapes reach this endpoint, and they disagree about what
      // a message id even is:
      //
      //   Gupshup v2  {type:"message-event", payload:{id:"<gupshup uuid>",
      //                type:"delivered", destination:"91…"}}
      //   Meta v3     {entry:[{changes:[{value:{statuses:[{id:"wamid.XXX",
      //                status:"delivered"}]}}]}]}
      //   Flaxxa      undocumented — treated by the loose fallback below.
      //
      // We store whatever id the SEND returned: a wamid for Flaxxa, a Gupshup
      // UUID for Gupshup. So configure Gupshup for v2 — its callbacks carry the
      // same UUID we hold, whereas v3 reports Meta's wamid, which we never saw
      // for a Gupshup send and therefore could never match.
      let msgId = null;
      let status = null;
      let errText;
      let recipient = null;

      if (body?.type === 'message-event' && body?.payload) {
        msgId = body.payload.id || body.payload.gsId || null;
        status = String(body.payload.type || '').toLowerCase();
        errText = body.payload.payload?.reason || body.payload.reason;
        recipient = body.payload.destination || null;
      } else if (Array.isArray(body?.entry)) {
        const st = body.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
        if (st) {
          msgId = st.id || null;
          status = String(st.status || '').toLowerCase();
          errText = st.errors?.[0]?.title || st.errors?.[0]?.message;
          recipient = st.recipient_id || null;
        }
      }

      // Fallback for any shape we have not met yet (Flaxxa included).
      if (!msgId) {
        msgId = (flat.match(/wamid\.[A-Za-z0-9_=-]+/) || [])[0]
             || (flat.match(/"(?:id|messageId|message_id)"\s*:\s*"([0-9a-f-]{20,})"/i) || [])[1]
             || null;
      }
      if (!status) {
        status = String(
          (flat.match(/"(?:status|state|event|message_status|type)"\s*:\s*"([^"]+)"/i) || [])[1] || ''
        ).toLowerCase() || 'unknown';
      }
      if (!errText) {
        errText = (flat.match(/"(?:error_message|errorMessage|reason|description|title)"\s*:\s*"([^"]+)"/i) || [])[1];
      }

      const wamid = msgId;
      console.log(`[wapi-hook] ${status}${wamid ? ` ${String(wamid).slice(0, 30)}…` : ' (no id found)'}${errText ? ` — ${errText}` : ''}`);

      if (!wamid) {
        // Unrecognised shape — keep it so the parser can be fixed from real data.
        await MessageLog.create({ kind: 'unmatched-callback', status, error: errText, rawCallback: body });
        return;
      }

      // A Meta-v3 callback for a GUPSHUP send reports Meta's wamid, but the
      // send API only ever gave us Gupshup's own UUID — so the ids cannot
      // match. Rather than lose those callbacks, fall back to the most recent
      // still-unresolved message to that phone number. Configuring the webhook
      // as Gupshup v2 avoids needing this, but this keeps it working if not.
      let log = await MessageLog.findOneAndUpdate(
        { wamid },
        {
          status,
          error: errText,
          statusAt: new Date(),
          $setOnInsert: { rawCallback: body },
        },
        { new: true }
      );

      // The Gupshup subscription is app-wide, so callbacks for OTHER projects
      // on the same number arrive here too. Matching those by phone could
      // overwrite a Krishna Pulse record belonging to the same person, so the
      // phone fallback stays off unless explicitly enabled. With the webhook on
      // Gupshup v2 the ids match directly and it is not needed at all.
      if (!log && recipient && process.env.WAPI_HOOK_PHONE_FALLBACK === 'true') {
        const phone = String(recipient).replace(/\D/g, '');
        log = await MessageLog.findOneAndUpdate(
          { phone: { $regex: phone.slice(-10) + '$' }, status: { $in: ['accepted', 'enqueued', 'sent'] } },
          { status, error: errText, statusAt: new Date(), matchedBy: 'phone' },
          { sort: { sentAt: -1 }, new: true }
        );
      }

      if (!log) {
        // Not one of ours — almost certainly another project sharing this
        // Gupshup app. Record it thinly so the volume is visible, but never
        // let it touch a candidate.
        await MessageLog.create({ wamid, kind: 'foreign', status, error: errText, phone: recipient });
        return;
      }

      // Mirror a real failure onto the candidate so the broadcast status
      // endpoints stop claiming success for a message that never arrived.
      if (['failed', 'undelivered', 'error', 'rejected'].includes(status) && log.candidateId) {
        if (log.kind === 'slotChange') {
          await Candidate.findByIdAndUpdate(log.candidateId, {
            $unset: { slotChangeNotifiedAt: 1 },
            slotChangeError: errText || `delivery ${status}`,
          }).catch(() => {});
        } else if (String(log.kind).startsWith('reminder:')) {
          const type = String(log.kind).split(':')[1];
          if (REMINDER_TYPES.includes(type)) {
            await Candidate.findByIdAndUpdate(log.candidateId, {
              [`remindersSent.${type}`]: false,
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error('[wapi-hook] handler error:', err.message);
    }
  },

  // ── Real delivery outcomes, per message kind ───────────────────────────────
  getDeliveryReport: async (req, res) => {
    try {
      const match = req.query.kind ? { kind: req.query.kind } : {};
      const rows = await MessageLog.aggregate([
        { $match: match },
        { $group: { _id: { kind: '$kind', status: '$status' }, n: { $sum: 1 } } },
        { $sort: { '_id.kind': 1, '_id.status': 1 } },
      ]);

      const byKind = {};
      for (const r of rows) {
        byKind[r._id.kind] = byKind[r._id.kind] || {};
        byKind[r._id.kind][r._id.status] = r.n;
      }

      const recentFailures = await MessageLog.find({
        status: { $in: ['failed', 'undelivered', 'error', 'rejected'] },
      }).sort({ statusAt: -1 }).limit(20).select('name phone kind status error statusAt');

      res.json({
        status: 'success',
        note:
          '"accepted" only means Meta took the message. Anything that never ' +
          'moves past accepted was never confirmed delivered — a callback has ' +
          'to arrive for that, so check the Flaxxa webhook is configured.',
        byKind,
        recentFailures,
      });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Admin: slot-change broadcast progress ──────────────────────────────────
  getSlotChangeStatus: async (req, res) => {
    try {
      const slot = req.query.slot || 'Evening';
      const [paidInSlot, notified, errored] = await Promise.all([
        Candidate.countDocuments({ paymentStatus: 'Paid', slot }),
        Candidate.countDocuments({ paymentStatus: 'Paid', slot, slotChangeNotifiedAt: { $exists: true } }),
        Candidate.countDocuments({ paymentStatus: 'Paid', slot, slotChangeError: { $exists: true, $ne: null } }),
      ]);
      res.json({
        status: 'success',
        providers: whatsapp.providerStatus(),
        slot,
        paidInSlot,
        notified,
        pending: paidInSlot - notified,
        errored,
        currentRun: slotChangeRun,
      });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Admin: event-day reminder broadcast (Template #4) ───────────────────────
  // Sends the "Event Reminder" WhatsApp template to paid registrants who
  // haven't checked in yet. Manually triggered by an admin before the event.
  // TODO: swap GUPSHUP_TEMPLATE_ID / sendWhatsapp for the Flaxxa WAPI call +
  // approved Flaxxa template ID once the API contract is available.
  // Since the Evening slot was merged into the Morning one, reminders go to
  // EVERYONE by default — omit `slot` and pass the Morning timings, and the
  // ex-Evening registrants receive the Morning details like everybody else.
  // Pass `slot` only if you deliberately want to target one group.
  //
  // `type` picks which remindersSent flag is stamped (threeDay | twoDay |
  // oneDay | twoHour), which is what makes a re-run safe: candidates already
  // stamped for that type are excluded. Same dryRun / background / status
  // treatment as the slot-change broadcast, for the same reason — this is
  // hundreds of irreversible messages.
  sendEventReminder: async (req, res) => {
    try {
      const {
        type = 'oneDay',
        slot,
        params = [],
        excludeAttended = true,
        dryRun = true,
        resend = false,
        limit,
      } = req.body || {};

      if (!REMINDER_TYPES.includes(type)) {
        return res.status(400).json({
          status: 'error',
          message: `"type" must be one of: ${REMINDER_TYPES.join(', ')}`,
        });
      }
      // Each approved template takes a different number of variables — verified
      // live: reminder_day_before 4, event_day_reminder 3, 2hours_reminder 1.
      // {{1}} is always the name and is added automatically, so `params` carries
      // the rest. A wrong count is dropped silently by Meta, so the dry run
      // reports the totals and you check them before sending.
      if (!Array.isArray(params)) {
        return res.status(400).json({
          status: 'error',
          message: '"params" must be an array of the template variables AFTER the name',
        });
      }
      if (reminderRun.running) {
        return res.status(409).json({
          status: 'error',
          message: 'A reminder broadcast is already running',
          progress: reminderRun,
        });
      }

      const templateName = sendWhatsapp.reminderTemplateFor(type);
      const flag = `remindersSent.${type}`;
      const query = { paymentStatus: 'Paid' };
      if (slot) query.slot = slot;
      if (excludeAttended) query.attendance = { $ne: true };
      if (!resend) query[flag] = { $ne: true };

      let targets = await Candidate.find(query).sort({ registrationDate: 1 });
      targets = targets.filter(c => normalizePhone(c.whatsappNumber));
      if (limit) targets = targets.slice(0, Number(limit));

      const preview = {
        status: 'success',
        dryRun: !!dryRun,
        type,
        templateName,
        targeted: targets.length,
        scope: slot ? `slot="${slot}"` : 'ALL paid registrants (Evening merged into Morning)',
        variablesSent: 1 + params.length,
        preview: [`<name>`, ...params],
        sample: targets.slice(0, 5).map(c => ({
          name: c.name, phone: c.whatsappNumber, slot: c.slot,
        })),
      };

      if (!templateName) {
        return res.status(400).json({
          ...preview,
          status: 'error',
          message: 'No reminder template configured — nothing would be delivered.',
        });
      }

      if (dryRun) {
        preview.message =
          `DRY RUN — nothing sent. ${targets.length} candidate(s) would receive the "${type}" ` +
          `reminder. Re-send with dryRun:false to actually deliver.`;
        return res.json(preview);
      }

      if (!targets.length) {
        return res.json({ ...preview, message: 'Nothing to send — no matching candidates' });
      }

      reminderRun = {
        running: true, type, total: targets.length, sent: 0, failed: 0,
        startedAt: new Date(), finishedAt: null, failures: [],
      };
      res.json({
        ...preview,
        started: true,
        message:
          `Sending the "${type}" reminder to ${targets.length} candidate(s) in the background. ` +
          `Poll GET /users/admin/reminder-status?type=${type} for progress.`,
      });

      const throttleMs = Number(process.env.REMINDER_THROTTLE_MS || 1200);
      (async () => {
        for (const c of targets) {
          try {
            const r = await sendWhatsapp.sendEventReminder(c, type, params);
            // A skipped send used to be recorded as "sent" — the same silent
            // failure that hid the broken certificate delivery for a day.
            if (r?.skipped) throw new Error('WAPI_TMPL_REMINDER not configured');
            await Candidate.findByIdAndUpdate(c._id, { [flag]: true });
            await logSend(c, `reminder:${type}`, templateName, r);
            reminderRun.sent++;
          } catch (err) {
            reminderRun.failed++;
            reminderRun.failures.push({ name: c.name, phone: c.whatsappNumber, error: err.message });
            console.error(`❌ ${type} reminder failed for ${c.name}:`, err.message);
          }
          await new Promise(r => setTimeout(r, throttleMs));
        }
        reminderRun.running = false;
        reminderRun.finishedAt = new Date();
        console.log(
          `📣 "${type}" reminder finished — sent ${reminderRun.sent}, failed ${reminderRun.failed}`
        );
      })();
    } catch (err) {
      reminderRun.running = false;
      if (!res.headersSent) res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Admin: reminder broadcast progress ─────────────────────────────────────
  getReminderStatus: async (req, res) => {
    try {
      const type = req.query.type || 'oneDay';
      if (!REMINDER_TYPES.includes(type)) {
        return res.status(400).json({ status: 'error', message: `Unknown reminder type "${type}"` });
      }
      const templateName = sendWhatsapp.reminderTemplateFor(type);
      const flag = `remindersSent.${type}`;
      const [paid, notAttended, sent] = await Promise.all([
        Candidate.countDocuments({ paymentStatus: 'Paid' }),
        Candidate.countDocuments({ paymentStatus: 'Paid', attendance: { $ne: true } }),
        Candidate.countDocuments({ paymentStatus: 'Paid', [flag]: true }),
      ]);
      res.json({
        status: 'success',
        type,
        templateConfigured: !!sendWhatsapp.reminderTemplateFor(type),
        templateName: sendWhatsapp.reminderTemplateFor(type),
        paid,
        notYetAttended: notAttended,
        alreadySent: sent,
        pending: notAttended - sent,
        currentRun: reminderRun,
      });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Help Desk / Reception: on-spot walk-in registration ─────────────────
  onSpotRegister: async (req, res) => {
    try {
      const { name, whatsappNumber, gender, college, course, year, email, slot, paymentAmount, paymentMethod, utr } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({ status: 'error', message: 'Name is required' });
      }
      const normalized = normalizePhone(whatsappNumber);
      if (!normalized) {
        return res.status(400).json({ status: 'error', message: 'A valid 10-digit WhatsApp number is required' });
      }

      // If paid via UPI, UTR is required and must be unique
      const method = paymentMethod === 'UPI' ? 'UPI' : 'Cash';
      if (method === 'UPI') {
        const trimmedUtr = (utr || '').trim();
        if (!trimmedUtr) {
          return res.status(400).json({ status: 'error', message: 'UTR is required for UPI payments' });
        }
        const existing = await Candidate.findOne({ utr: trimmedUtr });
        if (existing) {
          return res.status(409).json({
            status: 'error',
            message: `UTR already used for ${existing.name} (${existing.whatsappNumber})`,
          });
        }
      }

      const candidate = new Candidate({
        name: name.trim(),
        whatsappNumber: normalized,
        gender,
        college,
        course,
        year,
        email,
        slot: resolveSlot(slot, name),
        paymentStatus: 'Paid',
        paymentMethod: method,
        paymentId: method === 'UPI' ? 'onsite-upi' : 'onsite-cash',
        paymentAmount: Number(paymentAmount) || 49,
        paymentDate: new Date(),
        registrationDate: new Date(),
        utr: method === 'UPI' ? utr.trim() : undefined,
      });

      // Generate attendance token so the QR works immediately
      candidate.attendanceToken = candidate._id.toString();
      await candidate.save();

      // Respond immediately — send WhatsApp in background (fire-and-forget)
      res.status(201).json({
        status: 'success',
        message: 'On-spot registration successful',
        candidate,
      });

      if (candidate.whatsappNumber) {
        sendRegistrationConfirmation(candidate, 'onSpotRegister').catch(err =>
          console.error('On-spot WhatsApp failed (non-fatal):', err.message)
        );
      }
    } catch (err) {
      console.error('onSpotRegister error:', err.message);
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Help Desk: search by UTR or phone ──────────────────────────────────────
  helpDeskSearch: async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (!q) return res.status(400).json({ status: 'error', message: 'Search term is required' });

      const digitsOnly = q.replace(/\D/g, '');
      const isRrn = /^\d{6,20}$/.test(digitsOnly);

      let candidates = [];
      if (isRrn) {
        // exact RRN first; if none, fall back to phone match
        const byRrn = await Candidate.find({ rrn: q }).sort({ createdAt: -1 });
        if (byRrn.length) {
          candidates = byRrn;
        } else {
          candidates = await Candidate.find({ whatsappNumber: { $regex: digitsOnly + '$' } }).sort({ createdAt: -1 });
        }
      } else if (/^\d{10}$/.test(digitsOnly)) {
        // 10-digit number -> phone search (shows duplicates)
        candidates = await Candidate.find({ whatsappNumber: { $regex: digitsOnly + '$' } }).sort({ createdAt: -1 });
      } else {
        // anything else (letters/name) -> name search
        candidates = await Candidate.find({ name: { $regex: new RegExp(q, 'i') } }).sort({ createdAt: -1 });
      }

      res.json({ status: 'success', candidates });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },

  // ── Help Desk: fix actions on a matched candidate ─────────────────────────
  helpDeskFix: async (req, res) => {
    try {
      const { id, action, name, whatsappNumber, email } = req.body;
      if (!id) return res.status(400).json({ status: 'error', message: 'Candidate id is required' });

      const candidate = await Candidate.findById(id);
      if (!candidate) return res.status(404).json({ status: 'error', message: 'Not found' });

      switch (action) {
        case 'updateDetails': {
          const updates = {};
          if (name !== undefined && name !== null) {
            const n = String(name).trim();
            if (!n) return res.status(400).json({ status: 'error', message: 'Name cannot be empty' });
            updates.name = n;
          }
          if (whatsappNumber !== undefined && whatsappNumber !== null && whatsappNumber !== '') {
            const normalized = normalizePhone(whatsappNumber);
            if (!normalized) {
              return res.status(400).json({ status: 'error', message: 'Enter a valid 10-digit WhatsApp number' });
            }
            updates.whatsappNumber = normalized;
          }
          if (email !== undefined && email !== null) updates.email = String(email).trim();
          candidate.set(updates);
          await candidate.save();
          return res.json({ status: 'success', candidate, message: 'Details updated' });
        }

        case 'regenerateQr': {
          candidate.attendanceToken = candidate._id.toString();
          candidate.attendance = true;
          if (!candidate.attendanceDate) candidate.attendanceDate = new Date();
          await candidate.save();
          return res.json({ status: 'success', candidate, message: 'QR regenerated and attendance enabled' });
        }

        case 'markPresent': {
          candidate.attendance = true;
          if (!candidate.attendanceDate) candidate.attendanceDate = new Date();
          candidate.adminAttendance = true;
          if (!candidate.adminAttendanceDate) candidate.adminAttendanceDate = new Date();
          await candidate.save();
          return res.json({ status: 'success', candidate, message: 'Marked present' });
        }

        case 'resetAttendance': {
          candidate.attendance = false;
          candidate.attendanceDate = undefined;
          candidate.adminAttendance = false;
          candidate.adminAttendanceDate = undefined;
          await candidate.save();
          return res.json({ status: 'success', candidate, message: 'Attendance reset' });
        }

        default:
          return res.status(400).json({ status: 'error', message: 'Unknown action' });
      }
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  },
};

module.exports = { CandidateController };
