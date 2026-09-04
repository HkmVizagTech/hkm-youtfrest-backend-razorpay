/**
 * Provider router — decides which WhatsApp sender each message goes out on.
 *
 * Two registered numbers, two WABAs, two independent Meta quality ratings and
 * daily limits:
 *   flaxxa  — wapi.flaxxa.com, templates addressed BY NAME
 *   gupshup — api.gupshup.io,  templates addressed BY UUID
 *
 * Because a rate limit belongs to the number rather than the BSP, spreading
 * traffic across both is genuine extra capacity. That matters after 4 Sep 2026,
 * when the Flaxxa number hit a Meta spam rate limit and dropped 165 accepted
 * messages.
 *
 * Routing is per message kind so a bulk run can be moved off a struggling
 * number without touching the code:
 *
 *   WHATSAPP_PROVIDER=flaxxa                      # default for everything
 *   WHATSAPP_PROVIDER_CERTIFICATE=gupshup         # per-kind override
 *   WHATSAPP_PROVIDER_REMINDER=gupshup
 *   WHATSAPP_PROVIDER_SLOTCHANGE=flaxxa
 *
 * Gupshup addresses templates by UUID, so each kind routed there also needs its
 * id: GUPSHUP_TMPL_CERTIFICATE, GUPSHUP_TMPL_REMINDER_1DAY, and so on.
 */

const flaxxa = require('./sendWhatsappFlaxxa');
const gupshup = require('./sendWhatsappGupshupTemplate');
const { gupshupTemplateFor } = require('./whatsappTemplates');

const KINDS = ['certificate', 'reminder', 'slotchange', 'registration', 'attendance'];

// Gupshup is the DEFAULT as of 4 Sep 2026. The Flaxxa number was spam
// rate-limited by Meta that afternoon and silently dropped 165 accepted
// messages; Gupshup is a separate registered number that is delivering.
// Defaulting here means that when the Flaxxa variables are eventually deleted
// from Railway, everything lands on the working sender rather than the broken
// one. Set WHATSAPP_PROVIDER=flaxxa to go back.
function providerFor(kind) {
  const key = `WHATSAPP_PROVIDER_${String(kind || '').toUpperCase()}`;
  const name = (process.env[key] || process.env.WHATSAPP_PROVIDER || 'gupshup').toLowerCase();
  return name === 'flaxxa' ? 'flaxxa' : 'gupshup';
}

/** What each provider looks like right now — for the admin health endpoint. */
function providerStatus() {
  return {
    default: (process.env.WHATSAPP_PROVIDER || 'gupshup').toLowerCase(),
    routing: Object.fromEntries(KINDS.map(k => [k, providerFor(k)])),
    flaxxa: { configured: flaxxa.isConfigured() },
    gupshup: {
      configured: gupshup.isConfigured(),
      source: process.env.GUPSHUP_SOURCE || '917075176108',
      missing: [
        !process.env.GUPSHUP_API_KEY && 'GUPSHUP_API_KEY',
        !process.env.GUPSHUP_APP_NAME && 'GUPSHUP_APP_NAME',
      ].filter(Boolean),
    },
  };
}

/**
 * Send a text template by kind, letting each provider address it its own way.
 * `values` are the variables AFTER the name; the name is always {{1}}.
 */
async function sendText(kind, candidate, { flaxxaTemplate, gupshupTemplate, values = [] }) {
  const provider = providerFor(kind);

  if (provider === 'gupshup') {
    if (!gupshupTemplate) {
      throw new Error(
        `[whatsapp] ${kind} is routed to gupshup but no Gupshup template id is set ` +
        `— Gupshup addresses templates by UUID, not by the Flaxxa name`
      );
    }
    return gupshup.sendTemplate(candidate.whatsappNumber, gupshupTemplate, [candidate.name, ...values]);
  }

  return flaxxa.sendTemplate(candidate.whatsappNumber, flaxxaTemplate, [
    {
      type: 'body',
      parameters: [candidate.name, ...values].map(v => ({ type: 'text', text: String(v ?? '') })),
    },
  ]);
}

/**
 * Registration confirmation — the one message that fires continuously as
 * students sign up, so it is the most damaging to have silently failing.
 * Gender picks the group: anything that isn't "female" gets the boys' group,
 * which is also what the Flaxxa path does.
 */
async function sendRegistration(candidate) {
  const provider = providerFor('registration');
  const gender = String(candidate.gender || '').trim().toLowerCase();
  const kind = gender === 'female' ? 'registration:female' : 'registration:male';

  if (provider === 'gupshup') {
    const t = gupshupTemplateFor(kind, candidate, {});
    if (!t) throw new Error(`[whatsapp] no Gupshup template registered for ${kind}`);
    return gupshup.sendTemplate(candidate.whatsappNumber, t.id, t.params);
  }
  return flaxxa.sendRegistrationConfirmed(candidate);
}

/**
 * Reminder, by type. `values` is an object ({ when, reportingTime, meal }) —
 * not a positional array — because each template takes a different number of
 * variables in a different order, and the registry owns that mapping.
 */
async function sendReminder(candidate, type, values = {}) {
  const provider = providerFor('reminder');
  const kind = `reminder:${type}`;

  if (provider === 'gupshup') {
    const t = gupshupTemplateFor(kind, candidate, values);
    if (!t) throw new Error(`[whatsapp] no Gupshup template registered for ${kind}`);
    return gupshup.sendTemplate(candidate.whatsappNumber, t.id, t.params);
  }
  // Flaxxa keeps the older positional shape: name first, then the rest.
  const rest = [values.when, values.reportingTime, values.meal].filter(v => v != null);
  return flaxxa.sendEventReminder(candidate, type, rest);
}

/** Attendance confirmation, fired as a student checks in. */
async function sendAttendance(candidate) {
  const provider = providerFor('attendance');
  if (provider === 'gupshup') {
    const t = gupshupTemplateFor('attendance', candidate, {});
    if (!t) throw new Error('[whatsapp] no Gupshup template registered for attendance');
    return gupshup.sendTemplate(candidate.whatsappNumber, t.id, t.params);
  }
  return flaxxa.sendAttendanceConfirmed(candidate);
}

module.exports = {
  providerFor, providerStatus, sendText, sendRegistration, sendReminder, sendAttendance,
  flaxxa, gupshup,
};
