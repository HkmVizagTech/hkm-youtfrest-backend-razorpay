/**
 * Flaxxa WAPI client for Krishna Pulse Youth Fest.
 *
 * API spec: wapi.flaxxa.com  •  BASE = https://wapi.flaxxa.com
 *
 * IMPORTANT — how Flaxxa reports failures:
 *   Flaxxa answers HTTP 200 for *everything*, including rejections. The real
 *   outcome is in the body:
 *     { status: "success", message_id: 123, message_wamid: "wamid.XXX" }  → accepted by Meta
 *     { status: "success", message_id: 123, message_wamid: null }         → Meta REJECTED it
 *     { status: "error",   message: "Invalid template" }                  → Flaxxa rejected it
 *   A null message_wamid is the silent-failure case: the certificate looks
 *   sent but never reaches the phone. assertDelivered() below turns both
 *   failure shapes into thrown errors so callers actually find out.
 *
 * Required env vars:
 *   WAPI_TOKEN              — brand API token (Brand › API Access in Flaxxa dashboard)
 *   WAPI_TEMPLATE_LANG      — language code approved templates were submitted with
 *                             (must match exactly — "en" and "en_US" are different
 *                             templates to Flaxxa; ours are "en")
 *
 * Template env vars:
 *   WAPI_TMPL_REGISTRATION_FEMALE  — Template #1: registration confirm (girls group link)
 *   WAPI_TMPL_REGISTRATION_MALE    — Template #1: registration confirm (boys group link)
 *   WAPI_TMPL_REGISTRATION         — Template #1 fallback when gender-specific not set
 *   WAPI_TMPL_ATTENDANCE           — Template #2: attendance confirmed
 *   WAPI_TMPL_CERTIFICATE          — Template #3: certificate delivery (PDF attachment)
 *   WAPI_TMPL_CERTIFICATE_VARS     — comma-separated body variables for Template #3,
 *                                    in template order. Default "name".
 *                                    Allowed: name, college, course, documentId.
 *                                    MUST match the variable count of the approved
 *                                    template or Meta silently drops the message.
 *   WAPI_TMPL_REMINDER             — Template #4: event-day reminder broadcast
 *                                    (defaults to kp_event_reminder)
 *   WAPI_TMPL_SLOT_CHANGE          — Template #5: slot change notice
 *                                    (defaults to kp_slot_change)
 */

const fs = require('fs');
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

/**
 * Turn Flaxxa's always-200 response into a thrown error when the message did
 * not actually reach Meta. Returns the payload on success.
 */
function assertDelivered(data, ctx) {
  const { templateName, phone } = ctx;

  if (!data || typeof data !== 'object') {
    throw new Error(`[wapi] ${templateName} → ${phone}: unexpected response ${JSON.stringify(data)}`);
  }

  if (data.status === 'error' || data.error) {
    throw new Error(
      `[wapi] ${templateName} → ${phone}: Flaxxa rejected the request — ` +
      `${data.message || 'unknown error'}${data.error ? ` (${data.error})` : ''}`
    );
  }

  if (!data.message_wamid) {
    throw new Error(
      `[wapi] ${templateName} → ${phone}: Meta rejected the message (message_wamid was null). ` +
      `Usual causes: the number of body variables sent does not match the approved template, ` +
      `the template is not approved yet, or template_language "${lang()}" is not the language ` +
      `the template was approved in.`
    );
  }

  console.log(`[wapi] ${templateName} → ${phone}: delivered (wamid ${data.message_wamid})`);
  return data;
}

/** Axios errors hide the useful part in err.response.data — surface it. */
function rethrowAxios(err, ctx) {
  if (err.response) {
    throw new Error(
      `[wapi] ${ctx.templateName} → ${ctx.phone}: HTTP ${err.response.status} ` +
      `${JSON.stringify(err.response.data).slice(0, 500)}`
    );
  }
  throw err;
}

// ── Core send functions ───────────────────────────────────────────────────────

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

  const to = e164(phone);
  const ctx = { templateName, phone: to };

  let res;
  try {
    res = await axios.post(
      `${BASE}/api/v1/sendtemplatemessage`,
      {
        token: token(),
        phone: to,
        template_name: templateName,
        template_language: lang(),
        components,
      },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 15000 }
    );
  } catch (err) {
    rethrowAxios(err, ctx);
  }

  return assertDelivered(res.data, ctx);
}

/**
 * Send a template with a file attachment in the header (multipart/form-data).
 * Used for Template #3 — certificate PDF delivery.
 * `attachment` may be a public URL, a local file path, or a Buffer.
 *
 * NOTE: the multipart field is `components`, NOT `components[]`. Flaxxa runs
 * json_decode() on it, and PHP turns `components[]` into an array, which makes
 * json_decode throw ("must be of type string, array given") and the whole send
 * fail. This bit the certificate flow for a while — don't rename it back.
 */
async function sendTemplateWithAttachment(
  phone,
  templateName,
  attachment,
  bodyComponents = [],
  mimeType = 'application/pdf',
  filename = 'certificate.pdf'
) {
  if (!isConfigured()) {
    console.warn(`[wapi] WAPI_TOKEN not set — skipping ${templateName} with attachment to ${phone}`);
    return { skipped: true };
  }

  const to = e164(phone);
  const ctx = { templateName, phone: to };

  // `attachment` may be an http(s) URL, a local file path, or a Buffer.
  //
  // Prefer a local path on the bulk certificate run: the PDF was just written
  // to disk and uploaded to Cloudinary, so downloading it back over the network
  // costs seconds per attendee for nothing. At ~900 attendees that round trip
  // alone was over half an hour of the send window.
  let fileBuffer;
  if (Buffer.isBuffer(attachment)) {
    fileBuffer = attachment;
  } else if (typeof attachment === 'string' && !/^https?:\/\//i.test(attachment)) {
    try {
      fileBuffer = fs.readFileSync(attachment);
    } catch (err) {
      throw new Error(`[wapi] ${templateName} → ${to}: could not read the attachment at ${attachment} (${err.message})`);
    }
  } else {
    try {
      const fileRes = await axios.get(attachment, { responseType: 'arraybuffer', timeout: 30000 });
      fileBuffer = Buffer.from(fileRes.data);
    } catch (err) {
      throw new Error(
        `[wapi] ${templateName} → ${to}: could not download the attachment from ${attachment} ` +
        `(${err.response ? `HTTP ${err.response.status}` : err.message})`
      );
    }
  }

  if (!fileBuffer?.length) {
    throw new Error(`[wapi] ${templateName} → ${to}: attachment was empty`);
  }

  const fd = new FormData();
  fd.append('token', token());
  fd.append('phone', to);
  fd.append('template_name', templateName);
  fd.append('template_language', lang());
  if (bodyComponents.length) fd.append('components', JSON.stringify(bodyComponents));
  fd.append('header_attachment', fileBuffer, { filename, contentType: mimeType });

  let res;
  try {
    res = await axios.post(`${BASE}/api/v1/sendtemplatemessage_withattachment`, fd, {
      headers: { ...fd.getHeaders(), Accept: 'application/json' },
      timeout: 45000,
    });
  } catch (err) {
    rethrowAxios(err, ctx);
  }

  return assertDelivered(res.data, ctx);
}

// ── Krishna Pulse template messages ──────────────────────────────────────────

/**
 * Template #1 — Registration Confirmation (Utility)
 * Fires: after successful Razorpay payment (verifyPayment + webhook)
 * Variables: {{1}} name
 */
async function sendRegistrationConfirmed(candidate) {
  const gender = (candidate.gender || '').trim().toLowerCase();
  const male = process.env.WAPI_TMPL_REGISTRATION_MALE || process.env.WAPI_TMPL_REGISTRATION;
  const templateName = gender === 'female'
    ? process.env.WAPI_TMPL_REGISTRATION_FEMALE || male
    : male;
  if (!templateName) {
    console.warn('[wapi] no registration template configured (WAPI_TMPL_REGISTRATION_FEMALE/MALE) — skipping');
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
 * Template #2 — Attendance Confirmation (Utility)
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
 * Fires: sendCertificates / sendSingleCertificate / resendCertificate / auto job
 *
 * The approved `krishnapulse_certificate` template has ONE body variable
 * ({{1}} = name). Meta drops the message when the count doesn't match — and
 * Flaxxa reports success anyway — so the variable list is env-driven:
 * set WAPI_TMPL_CERTIFICATE_VARS to match whatever the template was approved
 * with (e.g. "name,college,course" if you later add variables and re-approve).
 */
function certificateVariables(candidate, documentId) {
  const values = {
    name: candidate.name || 'Participant',
    college: candidate.college || candidate.companyName || 'HKM Vizag',
    course: candidate.course || 'Youth Fest Participant',
    documentid: documentId || candidate.certificateDocumentId || '',
  };

  return (process.env.WAPI_TMPL_CERTIFICATE_VARS || 'name')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean)
    .map(v => ({ type: 'text', text: String(values[v] ?? '') }));
}

/**
 * @param pdfUrl    the Cloudinary URL (still stored on the candidate record)
 * @param localPath optional path to the PDF already on disk — when given it is
 *                  used as the upload source instead of re-fetching pdfUrl,
 *                  which saves seconds per attendee on the bulk run.
 */
async function sendCertificate(candidate, pdfUrl, documentId = null, localPath = null) {
  const templateName = process.env.WAPI_TMPL_CERTIFICATE;
  if (!templateName) {
    console.warn('[wapi] WAPI_TMPL_CERTIFICATE not set — skipping certificate delivery');
    return { skipped: true };
  }

  const parameters = certificateVariables(candidate, documentId);
  const bodyComponents = parameters.length ? [{ type: 'body', parameters }] : [];

  return sendTemplateWithAttachment(
    candidate.whatsappNumber,
    templateName,
    localPath || pdfUrl,
    bodyComponents,
    'application/pdf',
    `certificate-${String(candidate.name || 'participant').replace(/\s+/g, '_')}.pdf`
  );
}

/**
 * Template #4 — Reminders (Utility)
 *
 * There is NOT one reminder template — there are three approved in Flaxxa, and
 * they take DIFFERENT numbers of variables. Verified against the live API on
 * 4 Sep 2026 by sending each with 1..6 parameters and watching for a wamid:
 *
 *   reminder_day_before  → 4 variables   ({{1}} is the name)
 *   event_day_reminder   → 3 variables   ({{1}} is the name)
 *   2hours_reminder      → 1 variable    (name only)
 *
 * Meta silently drops a message whose parameter count doesn't match, and
 * Flaxxa still answers HTTP 200 — so a wrong count here is invisible until
 * nobody receives anything. Rather than hardcode a shape that will rot the
 * next time a template is edited, the caller supplies the values after the
 * name and this just passes them through; assertDelivered() catches any
 * mismatch loudly.
 */
const REMINDER_TEMPLATE_DEFAULTS = {
  threeDay: process.env.WAPI_TMPL_REMINDER_3DAY || null,
  twoDay:   process.env.WAPI_TMPL_REMINDER_2DAY || null,
  oneDay:   process.env.WAPI_TMPL_REMINDER_1DAY   || 'reminder_day_before',
  eventDay: process.env.WAPI_TMPL_REMINDER_EVENTDAY || 'event_day_reminder',
  twoHour:  process.env.WAPI_TMPL_REMINDER_2HOUR  || '2hours_reminder',
};

function reminderTemplateFor(type) {
  return process.env.WAPI_TMPL_REMINDER || REMINDER_TEMPLATE_DEFAULTS[type] || null;
}

/**
 * @param type   one of threeDay | twoDay | oneDay | eventDay | twoHour
 * @param values the template's variables AFTER {{1}} (the name is prepended).
 *               Pass [] for 2hours_reminder, 2 values for event_day_reminder,
 *               3 values for reminder_day_before.
 */
async function sendEventReminder(candidate, type, values = []) {
  const templateName = reminderTemplateFor(type);
  if (!templateName) {
    console.warn(`[wapi] no reminder template configured for "${type}" — skipping`);
    return { skipped: true };
  }

  const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
  const parameters = [
    { type: 'text', text: clean(candidate.name) || 'Devotee' },
    ...values.map(v => ({ type: 'text', text: clean(v) })),
  ];

  return sendTemplate(candidate.whatsappNumber, templateName, [
    { type: 'body', parameters },
  ]);
}

/**
 * Template #5 — Slot Change Notice (Utility)
 * Fires: admin broadcast when the Evening slot is merged into the Morning one.
 * Variables: {{1}} name, {{2}} new reporting time, {{3}} meal
 *
 * Approved body:
 *   Hare Krishna {{1}}! 🙏
 *   Important update regarding the Krishna Pulse Youth Festival on 6th September! 🎉
 *   Please note that your registration has been moved to the Morning Slot.
 *   🕒 New Reporting Time: {{2}}
 *   🍽️ {{3}} + 🏅 Digital Certificate will be provided after the session.
 *   ...
 *
 * EXACTLY three variables. Meta silently drops the message on a count
 * mismatch (Flaxxa still answers 200) — assertDelivered() catches that.
 */
async function sendSlotChange(candidate, reportingTime, meal) {
  const templateName = process.env.WAPI_TMPL_SLOT_CHANGE || 'kp_slot_change';
  if (!templateName) {
    console.warn('[wapi] WAPI_TMPL_SLOT_CHANGE not set — skipping slot change notice');
    return { skipped: true };
  }
  if (!reportingTime || !meal) {
    throw new Error('sendSlotChange needs both a reportingTime and a meal');
  }

  // WhatsApp rejects template parameters containing newlines, tabs, or runs of
  // 4+ spaces. Registration data is free text, so scrub before sending.
  const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();

  return sendTemplate(candidate.whatsappNumber, templateName, [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: clean(candidate.name) || 'Devotee' },
        { type: 'text', text: clean(reportingTime) },
        { type: 'text', text: clean(meal) },
      ],
    },
  ]);
}

module.exports = {
  reminderTemplateFor,
  sendRegistrationConfirmed,
  sendAttendanceConfirmed,
  sendCertificate,
  sendEventReminder,
  sendSlotChange,
  // low-level helpers
  sendTemplate,
  sendTemplateWithAttachment,
  certificateVariables,
  assertDelivered,
  e164,
  isConfigured,
};
