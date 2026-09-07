/**
 * One-off Yatra Clubbing cross-promotion broadcast to Krishna Pulse
 * registrants — NOT a recurring job. Unlike reminderAutoSend/certificateAutoSend,
 * nothing here runs on a timer; it only fires when an admin explicitly
 * triggers it via POST /users/admin/send-yatra-promo, and the templateId +
 * imageUrl are supplied in that request — never hardcoded, never sharing an
 * env var with certificates or anything else.
 */

const Candidate = require('../models/Candidate.model');
const gupshup = require('../utils/sendWhatsappGupshupTemplate');

const THROTTLE_MS = Number(process.env.YATRA_PROMO_THROTTLE_MS || 1200);

let isRunning = false;
let progress = {
  running: false, total: 0, sent: 0, failed: 0,
  currentName: null, startedAt: null, finishedAt: null, failures: [],
};

const getProgress = () => ({ ...progress });

async function runYatraPromoSend({ templateId, imageUrl, trigger }) {
  if (!templateId) throw new Error('templateId is required');
  if (!imageUrl) throw new Error('imageUrl is required');
  if (isRunning) {
    throw new Error(`A Yatra promo run is already in progress (${progress.sent}/${progress.total})`);
  }

  isRunning = true;
  const results = { total: 0, sent: 0, failed: 0, failures: [] };

  try {
    // Everyone who registered for Krishna Pulse and paid — not filtered by
    // attendance, since this is a promotional cross-send, not an
    // event-logistics message.
    const eligible = await Candidate.find({
      paymentStatus: 'Paid',
      yatraPromoSent: { $ne: true },
    }).select('_id name whatsappNumber');

    results.total = eligible.length;
    if (!eligible.length) return results;

    progress = {
      running: true, total: eligible.length, sent: 0, failed: 0,
      currentName: null, startedAt: new Date(), finishedAt: null, failures: [],
    };

    console.log(`📣 Yatra promo: sending to ${eligible.length} paid registrant(s), triggered by ${trigger || 'admin'}.`);

    for (let i = 0; i < eligible.length; i++) {
      const c = eligible[i];
      progress.currentName = c.name;
      try {
        await gupshup.sendTemplateWithImage(c.whatsappNumber, templateId, [c.name], imageUrl);
        await Candidate.findByIdAndUpdate(c._id, {
          yatraPromoSent: true,
          yatraPromoSentDate: new Date(),
        });
        results.sent++;
        progress.sent++;
      } catch (err) {
        results.failed++;
        progress.failed++;
        progress.failures.push({ name: c.name, phone: c.whatsappNumber, error: err.message });
        console.error(`❌ Yatra promo failed for ${c.name}:`, err.message);
      }
      if (i < eligible.length - 1) await new Promise(r => setTimeout(r, THROTTLE_MS));
    }
  } catch (err) {
    console.error('❌ Yatra promo job error:', err.message);
    progress.error = err.message;
  } finally {
    isRunning = false;
    if (progress.running) {
      progress.running = false;
      progress.currentName = null;
      progress.finishedAt = new Date();
    }
  }

  return results;
}

module.exports = { runYatraPromoSend, getProgress };
