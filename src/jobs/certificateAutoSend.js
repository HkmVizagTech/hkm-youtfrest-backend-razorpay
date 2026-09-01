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
const SEND_DELAY_DAYS = Number(process.env.CERTIFICATE_SEND_DELAY_DAYS || 1);
const MAX_ATTEMPTS = Number(process.env.CERTIFICATE_MAX_ATTEMPTS || 3);

// CERTIFICATE_SEND_TIME is IST wall-clock, ALWAYS.
//
// Do not use setHours()/getDate() here. Those read the container's local
// timezone, and Railway runs in UTC — so `setHours(9, 0)` used to mean 09:00
// UTC, i.e. 2:30pm IST. Certificates went out five and a half hours late.
// India has a fixed +05:30 offset and no DST, so we shift into IST wall-clock
// space with Date.UTC() maths and shift back out. This is correct no matter
// what TZ the container is set to.
const TZ_OFFSET_MIN = Number(process.env.CERTIFICATE_TZ_OFFSET_MINUTES || 330); // +05:30
const TZ_OFFSET_MS = TZ_OFFSET_MIN * 60 * 1000;

function certificateSendTime(c) {
  const base = new Date(c.attendanceDate || c.registrationDate || c.createdAt || Date.now());

  // Shift the instant into IST space so the UTC getters read as IST wall clock.
  const ist = new Date(base.getTime() + TZ_OFFSET_MS);
  const [h, m] = CERTIFICATE_SEND_TIME.split(':').map(Number);

  // Same IST calendar day + delay, at HH:MM IST.
  const sendIstMs = Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate() + SEND_DELAY_DAYS,
    h, m, 0, 0
  );

  // Back to a real UTC instant for comparison against Date.now().
  return new Date(sendIstMs - TZ_OFFSET_MS);
}

/** Format an instant as IST, for logs that humans in Vizag have to read. */
function ist(d) {
  return new Date(d).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
  }) + ' IST';
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
      if (certificateSendTime(c) > now) return false;
      // Delivery failures no longer flip certificateSent (that was the old
      // silent-failure bug), so without a cap a permanently bad number would be
      // retried every few minutes forever — regenerating a PDF and burning a
      // Cloudinary upload each time. Give up after MAX_ATTEMPTS and let an admin
      // fix the number and resend by hand.
      if ((c.certificateAttempts || 0) >= MAX_ATTEMPTS) return false;
      return true;
    });

    results.scanned = eligible.length;

    const giveUp = candidates.filter(c => (c.certificateAttempts || 0) >= MAX_ATTEMPTS);
    if (giveUp.length) {
      results.needsManualFix = giveUp.map(c => ({
        name: c.name, phone: c.whatsappNumber, error: c.certificateLastError,
      }));
      console.warn(
        `⚠️ ${giveUp.length} attendee(s) hit ${MAX_ATTEMPTS} failed attempts and need a manual resend: ` +
        giveUp.map(c => c.name).join(', ')
      );
    }

    if (!eligible.length) return results;

    console.log(
      `🎓 Auto-send: ${eligible.length} eligible attendee(s) — send time is ` +
      `${CERTIFICATE_SEND_TIME} IST, ${SEND_DELAY_DAYS} day(s) after attendance. ` +
      `Now: ${ist(now)}`
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
        const attempts = (c.certificateAttempts || 0) + 1;
        await Candidate.findByIdAndUpdate(c._id, {
          certificateAttempts: attempts,
          certificateLastError: err.message,
          certificateLastAttemptAt: new Date(),
        }).catch(() => {});

        results.failed++;
        results.failedNames.push({ name: c.name, attempts, error: err.message });
        console.error(
          `❌ Auto certificate failed for ${c.name} (attempt ${attempts}/${MAX_ATTEMPTS}):`,
          err.message
        );
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

  // Show a worked example on boot so a wrong TZ is obvious in the deploy logs
  // instead of being discovered five and a half hours late on the day.
  const example = certificateSendTime({ attendanceDate: new Date() });
  console.log(
    `⏰ Auto certificate job started — polls every ${intervalMinutes} min.\n` +
    `   Send time: ${CERTIFICATE_SEND_TIME} IST, ${SEND_DELAY_DAYS} day(s) after attendance ` +
    `(max ${MAX_ATTEMPTS} attempts each).\n` +
    `   Container TZ is ${Intl.DateTimeFormat().resolvedOptions().timeZone}; ` +
    `someone attending right now would be sent at ${ist(example)}.`
  );

  runCertificateAutoSend().catch(() => {});
  setInterval(() => runCertificateAutoSend().catch(() => {}), intervalMs);
}

module.exports = { runCertificateAutoSend, startCertificateAutoSendJob };
