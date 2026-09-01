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

// The send window is ONE MOMENT FOR THE WHOLE EVENT, not per attendee.
// Everyone who registered (paid) and attended gets their certificate at
// EVENT_DATE + CERTIFICATE_SEND_DELAY_DAYS at CERTIFICATE_SEND_TIME IST.
//
// It deliberately is NOT keyed off each attendee's own attendanceDate: someone
// checked in at 00:30 on the 7th, or whose attendance an admin fixes up two days
// late, would otherwise have their certificate pushed a day or two past
// everybody else's. Once the window opens it stays open, so late attendance
// marks are picked up on the very next poll.
const EVENT_DATE = process.env.EVENT_DATE || '2026-09-06'; // IST calendar date

function certificateWindowOpensAt() {
  const [y, mo, d] = EVENT_DATE.split('-').map(Number);
  const [h, mi] = CERTIFICATE_SEND_TIME.split(':').map(Number);

  // Build the instant in IST wall-clock space, then shift out to real UTC.
  // (Never setHours() — that reads the container TZ, which is UTC on Railway.)
  const sendIstMs = Date.UTC(y, mo - 1, d + SEND_DELAY_DAYS, h, mi, 0, 0);
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
    const opensAt = certificateWindowOpensAt();
    results.windowOpensAt = opensAt;

    // Nothing goes out before the window opens — one moment for the whole event.
    if (now < opensAt) {
      results.waiting = true;
      return results;
    }

    // Registered (paid) AND attended. Non-attendees never get a certificate.
    const candidates = await Candidate.find({
      attendance: true,
      paymentStatus: 'Paid',
      certificateSent: { $ne: true },
    }).sort({ attendanceDate: 1 });

    const eligible = candidates.filter(c => {
      // Delivery failures no longer flip certificateSent (that was the old
      // silent-failure bug), so without a cap a permanently bad number would be
      // retried every few minutes forever — regenerating a PDF and burning a
      // Cloudinary upload each time. Give up after MAX_ATTEMPTS and let an admin
      // fix the number and resend by hand.
      return (c.certificateAttempts || 0) < MAX_ATTEMPTS;
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
      `🎓 Auto-send: ${eligible.length} paid + attended candidate(s) awaiting certificates. ` +
      `Window opened ${ist(opensAt)}; now ${ist(now)}.`
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

  // Print the resolved window on boot so a wrong EVENT_DATE or timezone is
  // obvious in the deploy log, instead of being discovered on the morning it
  // was supposed to fire.
  const opensAt = certificateWindowOpensAt();
  console.log(
    `⏰ Auto certificate job started — polls every ${intervalMinutes} min.\n` +
    `   Event date: ${EVENT_DATE} (IST). Certificates go to everyone who is ` +
    `Paid + Attended,\n` +
    `   all at once, ${SEND_DELAY_DAYS} day(s) later at ${CERTIFICATE_SEND_TIME} IST ` +
    `(max ${MAX_ATTEMPTS} attempts each).\n` +
    `   → Window opens ${ist(opensAt)}` +
    (Date.now() < opensAt.getTime() ? ' (waiting)' : ' (OPEN — sending now)') + '\n' +
    `   Container TZ is ${Intl.DateTimeFormat().resolvedOptions().timeZone}; ` +
    `server time now ${ist(new Date())}.`
  );

  runCertificateAutoSend().catch(() => {});
  setInterval(() => runCertificateAutoSend().catch(() => {}), intervalMs);
}

module.exports = { runCertificateAutoSend, startCertificateAutoSendJob };
