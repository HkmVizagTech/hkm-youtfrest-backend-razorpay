/**
 * Flaxxa WAPI client for Krishna Pulse Youth Fest.
 *
 * Ported from the proven Bhajan Clubbing implementation.
 * API spec: wapi.flaxxa.com  •  BASE = https://wapi.flaxxa.com
 *
 * Required env vars:
 *   WAPI_TOKEN              — brand API token (Brand › API Access in Flaxxa dashboard)
 *   WAPI_TEMPLATE_LANG      — language code approved templates were submitted with
 *                             (usually "en" or "en_US", default "en")
 *
 * Template env vars (set once templates are approved in Flaxxa):
 *   WAPI_TMPL_REGISTRATION  — Template #1: registration confirmation
 *   WAPI_TMPL_ATTENDANCE    — Template #2: attendance confirmed
 *   WAPI_TMPL_CERTIFICATE   — Template #3: certificate delivery (PDF attachment)
 *   WAPI_TMPL_REMINDER      — Template #4: event-day reminder broadcast
 */

const axios = require('axios');
const FormData = require('form-data');

const BASE = 'https://wapi.flaxxa.com';

// ── Helpers ───────────────────────────────────────────────────────────────────

function token() {
  const t = process.env.WAPI_TOKEN;
  if (!t) throw new Error('WAPI_TOKEN is not set');
  return t;
}

function isConfigured() {
  return !!process.env.WAPI_TOKEN;
}

function lang() {
  return process.env.WAPI_TEMPLATE_LANG || 'en';
}

// Normalise any stored phone number to E.164 without leading +
// (Flaxxa accepts both "91XXXXXXXXXX" and "+91XXXXXXXXXX")
function e164(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return '91' + digits.slice(1);
  return digits;
}

// ── Core send functions (direct port from Bhajan) ─────────────────────────────

/**
 * Send a pre-approved template message (text-only body/buttons).
 * components follows Meta Cloud API format:
 * [{ type: "body", parameters: [{ type: "text", text: "..." }] }]
 */
async function sendTemplate(phone, templateName, components = []) {
  if (!isConfigured()) {
    console.warn(`[wapi] WAPI_TOKEN not set — skipping ${templateName} to ${phone}`);
    return { skipped: true };
  }
  const res = await axios.post(
    `${BASE}/api/v1/sendtemplatemessage`,
    {
      token: token(),
      phone: e164(phone),
      template_name: templateName,
      template_language: lang(),
      components,
    },
    { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 15000 }
  );
  return res.data;
}

/**
 * Send a template with a file attachment in the header (multipart/form-data).
 * Used for Template #3 — certificate PDF delivery.
 * attachmentUrl must be a publicly accessible URL (Cloudinary works fine).
 */
async function sendTemplateWithAttachment(phone, templateName, attachmentUrl, bodyComponents = [], mimeType = 'application/pdf', filename = 'certificate.pdf') {
  if (!isConfigured()) {
    console.warn(`[wapi] WAPI_TOKEN not set — skipping ${templateName} with attachment to ${phone}`);
    return { skipped: true };
  }

  const fileRes = await axios.get(attachmentUrl, { responseType: 'arraybuffer', timeout: 30000 });
  const fileBuffer = Buffer.from(fileRes.data);

  const fd = new FormData();
  fd.append('token', token());
  fd.append('phone', e164(phone));
  fd.append('template_name', templateName);
  fd.append('template_language', lang());
  if (bodyComponents.length)
    fd.append('components[]', JSON.stringify(bodyComponents));
  fd.append('header_attachment', fileBuffer, { filename, contentType: mimeType });

  const res = await axios.post(`${BASE}/api/v1/sendtemplatemessage_withattachment`, fd, {
    headers: { ...fd.getHeaders(), Accept: 'application/json' },
    timeout: 45000,
  });
  return res.data;
}

// ── Krishna Pulse template messages ──────────────────────────────────────────

/**
 * Template #1 — Registration Confirmation (Utility)
 * Fires: after successful Razorpay payment (verifyPayment + webhook)
 * Variables: {{1}} name, {{2}} slot, {{3}} amount
 */
async function sendRegistrationConfirmed(candidate) {
  const templateName = process.env.WAPI_TMPL_REGISTRATION;
  if (!templateName) {
    console.warn('[wapi] WAPI_TMPL_REGISTRATION not set — skipping registration confirmation');
    return { skipped: true };
  }
  return sendTemplate(candidate.whatsappNumber, templateName, [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: candidate.name },
        { type: 'text', text: candidate.slot || 'TBD' },
        { type: 'text', text: String(candidate.paymentAmount || 49) },
      ],
    },
  ]);
}

/**
 * Template #2 — Attendance Confirmation (Utility)
 * Fires: when attendee marks their own attendance (markAttendance endpoint)
 * Variables: {{1}} name
 */
async function sendAttendanceConfirmed(candidate) {
  const templateName = process.env.WAPI_TMPL_ATTENDANCE;
  if (!templateName) {
    console.warn('[wapi] WAPI_TMPL_ATTENDANCE not set — skipping attendance confirmation');
    return { skipped: true };
  }
  return sendTemplate(candidate.whatsappNumber, templateName, [
    {
      type: 'body',
      parameters: [{ type: 'text', text: candidate.name }],
    },
  ]);
}

/**
 * Template #3 — Certificate Delivery (Utility, PDF attachment in header)
 * Fires: when admin sends certificates (sendCertificates / sendSingleCertificate)
 * Variables: {{1}} name, {{2}} college/company, {{3}} course
 * Header: PDF document (certificate)
 */
async function sendCertificate(candidate, pdfUrl) {
  const templateName = process.env.WAPI_TMPL_CERTIFICATE;
  if (!templateName) {
    console.warn('[wapi] WAPI_TMPL_CERTIFICATE not set — skipping certificate delivery');
    return { skipped: true };
  }
  const bodyComponents = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: candidate.name },
        { type: 'text', text: candidate.college || candidate.companyName || 'HKM Vizag' },
        { type: 'text', text: candidate.course || 'Youth Fest Participant' },
      ],
    },
  ];
  return sendTemplateWithAttachment(
    candidate.whatsappNumber,
    templateName,
    pdfUrl,
    bodyComponents,
    'application/pdf',
    `certificate-${candidate.name.replace(/\s+/g, '_')}.pdf`
  );
}

/**
 * Template #4 — Event-Day Reminder (Utility)
 * Fires: admin broadcast before the event (sendEventReminder endpoint)
 * Variables: {{1}} name, {{2}} timeToEvent, {{3}} venue
 */
async function sendEventReminder(candidate, timeToEvent, venue) {
  const templateName = process.env.WAPI_TMPL_REMINDER;
  if (!templateName) {
    console.warn('[wapi] WAPI_TMPL_REMINDER not set — skipping event reminder');
    return { skipped: true };
  }
  return sendTemplate(candidate.whatsappNumber, templateName, [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: candidate.name },
        { type: 'text', text: timeToEvent },
        { type: 'text', text: venue },
      ],
    },
  ]);
}

module.exports = {
  sendRegistrationConfirmed,
  sendAttendanceConfirmed,
  sendCertificate,
  sendEventReminder,
  // expose low-level helpers for any future use
  sendTemplate,
  sendTemplateWithAttachment,
  e164,
  isConfigured,
};
