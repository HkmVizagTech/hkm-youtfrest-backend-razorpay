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

const KINDS = ['certificate', 'reminder', 'slotchange', 'registration', 'attendance'];

function providerFor(kind) {
  const key = `WHATSAPP_PROVIDER_${String(kind || '').toUpperCase()}`;
  const name = (process.env[key] || process.env.WHATSAPP_PROVIDER || 'flaxxa').toLowerCase();
  return name === 'gupshup' ? 'gupshup' : 'flaxxa';
}

/** What each provider looks like right now — for the admin health endpoint. */
function providerStatus() {
  return {
    default: (process.env.WHATSAPP_PROVIDER || 'flaxxa').toLowerCase(),
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

module.exports = { providerFor, providerStatus, sendText, flaxxa, gupshup };
