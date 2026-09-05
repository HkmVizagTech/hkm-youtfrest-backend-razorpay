/**
 * Automatic event reminders — the day-before and the event-day broadcast.
 *
 * Built the same way as certificateAutoSend.js, for the same reasons learned
 * the hard way this week:
 *
 *   • Times are IST wall-clock, computed with Date.UTC() maths. Never
 *     setHours() — Railway's container runs in UTC, and that bug once moved a
 *     09:00 send to 2:30pm.
 *   • The window OPENS and stays open. A deploy, a restart, or a few hours of
 *     downtime does not skip the send; the next poll picks it up.
 *   • remindersSent.<type> is stamped per candidate only AFTER the provider
 *     accepts, so a restart mid-run resumes instead of double-messaging.
 *   • A circuit breaker aborts the run if the failure rate spikes — on 4 Sep a
 *     rate-limited number accepted 165 messages and delivered none, and an
 *     unattended job should stop rather than burn a thousand into a wall.
 *
 * Schedule, all derived from EVENT_DATE:
 *   oneDay    → EVENT_DATE − 1 day at REMINDER_1DAY_TIME     (default 11:00 IST)
 *   eventDay  → EVENT_DATE       at REMINDER_EVENTDAY_TIME   (default 07:00 IST)
 *
 * Disable with AUTO_SEND_REMINDERS=false.
 */

const Candidate = require('../models/Candidate.model');
const MessageLog = require('../models/MessageLog.model');
const whatsapp = require('../utils/whatsapp');

const EVENT_DATE = process.env.EVENT_DATE || '2026-09-06';
const TZ_OFFSET_MS = Number(process.env.CERTIFICATE_TZ_OFFSET_MINUTES || 330) * 60 * 1000;
const THROTTLE_MS = Number(process.env.REMINDER_THROTTLE_MS || 1200);

// Abort a run if things are clearly going wrong rather than pushing on.
const BREAKER_AFTER = Number(process.env.REMINDER_BREAKER_AFTER || 20);
const BREAKER_RATE = Number(process.env.REMINDER_BREAKER_RATE || 0.5);

const SCHEDULE = {
  oneDay: {
    dayOffset: -1,
    time: process.env.REMINDER_1DAY_TIME || '11:00',
    values: () => ({
      when: process.env.REMINDER_1DAY_WHEN || 'tomorrow',
      reportingTime: process.env.EVENT_REPORTING_TIME || '10 AM',
      meal: process.env.EVENT_MEAL || 'Prasadam',
    }),
    excludeAttended: false,
  },
  eventDay: {
    dayOffset: 0,
    time: process.env.REMINDER_EVENTDAY_TIME || '07:00',
    values: () => ({
      reportingTime: process.env.EVENT_REPORTING_TIME || '10 AM',
      meal: process.env.EVENT_MEAL || 'Prasadam',
    }),
    // Someone already checked in does not need telling to turn up.
    excludeAttended: true,
  },
};

const running = {};

/** IST wall-clock → real UTC instant. */
function windowOpensAt(type) {
  const { dayOffset, time } = SCHEDULE[type];
  const [y, mo, d] = EVENT_DATE.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + dayOffset, h, mi, 0, 0) - TZ_OFFSET_MS);
}

function ist(d) {
  return new Date(d).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
  }) + ' IST';
}

async function runReminder(type) {
  if (running[type]) return { skipped: 'already-running' };
  const cfg = SCHEDULE[type];
  if (!cfg) return { skipped: `unknown type ${type}` };

  const opensAt = windowOpensAt(type);
  if (Date.now() < opensAt.getTime()) return { waiting: true, opensAt };

  running[type] = true;
  const results = { type, sent: 0, failed: 0, aborted: false, failures: [] };

  try {
    const flag = `remindersSent.${type}`;
    const query = { paymentStatus: 'Paid', [flag]: { $ne: true } };
    if (cfg.excludeAttended) query.attendance = { $ne: true };

    const targets = (await Candidate.find(query).sort({ registrationDate: 1 }))
      .filter(c => /^(91)?[6-9]\d{9}$/.test(String(c.whatsappNumber || '').replace(/\D/g, '')));

    if (!targets.length) return results;

    const values = cfg.values();
    console.log(
      `📣 Auto reminder "${type}": ${targets.length} to send. ` +
      `Window opened ${ist(opensAt)}; now ${ist(new Date())}. Values: ${JSON.stringify(values)}`
    );

    for (let i = 0; i < targets.length; i++) {
      const c = targets[i];
      try {
        const r = await whatsapp.sendReminder(c, type, values);
        if (r?.skipped) throw new Error('no reminder template configured');

        await Candidate.findByIdAndUpdate(c._id, { [flag]: true });
        await MessageLog.create({
          provider: r?.provider || 'flaxxa',
          wamid: r?.message_wamid,
          messageId: String(r?.message_id ?? ''),
          candidateId: c._id, name: c.name, phone: c.whatsappNumber,
          kind: `reminder:${type}`, status: 'accepted', sentAt: new Date(),
        }).catch(() => {});
        results.sent++;
      } catch (err) {
        results.failed++;
        results.failures.push({ name: c.name, phone: c.whatsappNumber, error: err.message });
        console.error(`❌ Auto reminder "${type}" failed for ${c.name}:`, err.message);
      }

      // Circuit breaker: if most of the first batch is failing, something is
      // wrong upstream (rate limit, bad template, dead credentials). Stop and
      // leave the rest unsent — they stay eligible for the next poll or a
      // manual run once it is fixed.
      const done = results.sent + results.failed;
      if (done >= BREAKER_AFTER && results.failed / done > BREAKER_RATE) {
        results.aborted = true;
        console.error(
          `🛑 Auto reminder "${type}" ABORTED after ${done} attempts — ` +
          `${results.failed} failed (>${Math.round(BREAKER_RATE * 100)}%). ` +
          `${targets.length - done} left unsent.`
        );
        break;
      }

      if (i < targets.length - 1) await new Promise(r => setTimeout(r, THROTTLE_MS));
    }

    console.log(`📣 Auto reminder "${type}" finished — sent ${results.sent}, failed ${results.failed}`);
  } catch (err) {
    console.error(`❌ Auto reminder "${type}" job error:`, err.message);
  } finally {
    running[type] = false;
  }

  return results;
}

async function runAllReminders() {
  const out = {};
  for (const type of Object.keys(SCHEDULE)) out[type] = await runReminder(type);
  return out;
}

function startReminderJobs() {
  if ((process.env.AUTO_SEND_REMINDERS ?? 'true') !== 'true') {
    console.log('⏸️ Auto reminders disabled (AUTO_SEND_REMINDERS != "true")');
    return;
  }

  const intervalMinutes = parseFloat(process.env.REMINDER_JOB_INTERVAL_MINUTES || '5');
  const intervalMs = Math.max(intervalMinutes, 0.5) * 60 * 1000;

  // Print the resolved schedule on boot, so a wrong EVENT_DATE or timezone is
  // visible in the deploy log instead of at the moment it fails to fire.
  const lines = Object.keys(SCHEDULE).map(type => {
    const at = windowOpensAt(type);
    const state = Date.now() < at.getTime() ? 'waiting' : 'OPEN — sending';
    return `   ${type.padEnd(9)} → ${ist(at)}  (${state})`;
  });
  console.log(
    `⏰ Auto reminder jobs started — polling every ${intervalMinutes} min.\n` +
    `   Event date: ${EVENT_DATE} (IST). Container TZ: ${Intl.DateTimeFormat().resolvedOptions().timeZone}\n` +
    lines.join('\n')
  );

  runAllReminders().catch(() => {});
  setInterval(() => runAllReminders().catch(() => {}), intervalMs);
}

module.exports = { runReminder, runAllReminders, startReminderJobs, windowOpensAt, SCHEDULE };
