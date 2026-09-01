const path = require('path');
const fs = require('fs');
const Candidate = require('../models/Candidate.model');
const sendWhatsapp = require('../utils/sendWhatsappFlaxxa');
const {
  generateCertificatePDF,
  generateDocumentId,
  uploadToCloudinary,
} = require('../utils/sendCertificateWithTemplate');

const tempDir = path.join(__dirname, '../temp/certificates');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

let isRunning = false;

const CERTIFICATE_SEND_TIME = process.env.CERTIFICATE_SEND_TIME || '09:00';

// Certificate is sent the day AFTER the attendee's slot at CERTIFICATE_SEND_TIME
// (default 09:00), instead of immediately on slot completion.
function certificateSendTime(c) {
  const base = c.attendanceDate || c.registrationDate || c.createdAt || new Date();
  const send = new Date(base);
  send.setDate(send.getDate() + 1);
  const [h, m] = CERTIFICATE_SEND_TIME.split(':').map(Number);
  send.setHours(h, m, 0, 0);
  return send;
}

async function sendCertificateToCandidate(c) {
  const documentId = generateDocumentId(c.name);
  const outputPath = path.join(tempDir, `${documentId}.pdf`);

  const certData = await generateCertificatePDF(c.name, outputPath, documentId);

  let cloudinaryResult;
  let waResult;
  try {
    cloudinaryResult = await uploadToCloudinary(certData.outputPath, documentId);
    if (!cloudinaryResult.success) {
      throw new Error(`Cloudinary upload failed: ${cloudinaryResult.error}`);
    }

    waResult = await sendWhatsapp.sendCertificate(c, cloudinaryResult.url, documentId);
    if (waResult && waResult.skipped) {
      throw new Error('Certificate WhatsApp template not configured (WAPI_TMPL_CERTIFICATE)');
    }
  } finally {
    if (fs.existsSync(certData.outputPath)) fs.unlinkSync(certData.outputPath);
  }

  return {
    documentId,
    url: cloudinaryResult.url,
    publicId: cloudinaryResult.publicId,
  };
}

async function runCertificateAutoSend() {
  if (isRunning) return { skipped: 'already-running' };
  isRunning = true;
  const results = { scanned: 0, sent: 0, failed: 0, failedNames: [] };

  try {
    const now = new Date();
    const candidates = await Candidate.find({
      attendance: true,
      paymentStatus: 'Paid',
      certificateSent: { $ne: true },
    }).sort({ attendanceDate: 1 });

    const eligible = candidates.filter(c => {
      if (!c.attendanceDate && !c.registrationDate && !c.createdAt) return false;
      return certificateSendTime(c) <= now;
    });

    results.scanned = eligible.length;
    if (!eligible.length) return results;

    console.log(
      `🎓 Auto-send: ${eligible.length} eligible attendee(s) found (past next-day ${CERTIFICATE_SEND_TIME} send time)`
    );

    for (let i = 0; i < eligible.length; i++) {
      const c = eligible[i];
      try {
        const result = await sendCertificateToCandidate(c);
        await Candidate.findByIdAndUpdate(c._id, {
          certificateSent: true,
          certificateSentDate: new Date(),
          certificateSentBy: 'auto',
          certificateDocumentId: result.documentId,
          certificateDriveFileId: result.publicId,
          certificateDriveViewLink: result.url,
          certificateFileName: `${result.documentId}.pdf`,
        });
        results.sent++;
        console.log(`✅ Auto certificate sent to ${c.name} (${result.documentId})`);
      } catch (err) {
        results.failed++;
        results.failedNames.push({ name: c.name, error: err.message });
        console.error(`❌ Auto certificate failed for ${c.name}:`, err.message);
      }

      if (i < eligible.length - 1) await new Promise(r => setTimeout(r, 3000));
    }
  } catch (err) {
    console.error('❌ Auto certificate job error:', err.message);
  } finally {
    isRunning = false;
  }

  return results;
}

function startCertificateAutoSendJob() {
  const enabled = (process.env.AUTO_SEND_CERTIFICATES ?? 'true') === 'true';
  if (!enabled) {
    console.log('⏸️ Auto certificate job disabled (AUTO_SEND_CERTIFICATES != "true")');
    return;
  }

  const intervalMinutes = parseFloat(process.env.CERTIFICATE_JOB_INTERVAL_MINUTES || '5');
  const intervalMs = Math.max(intervalMinutes, 0.5) * 60 * 1000;

  console.log(
    `⏰ Auto certificate job started — runs every ${intervalMinutes} min, sends the next day at ${CERTIFICATE_SEND_TIME}`
  );

  runCertificateAutoSend().catch(() => {});
  setInterval(() => runCertificateAutoSend().catch(() => {}), intervalMs);
}

module.exports = { runCertificateAutoSend, startCertificateAutoSendJob };
