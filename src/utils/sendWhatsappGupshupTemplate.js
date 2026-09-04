/**
 * Gupshup template client — the SECOND WhatsApp sender.
 *
 * Why this exists: Meta rate limits and quality flags attach to a phone number
 * and its WABA, not to the BSP. On 4 Sep 2026 the Flaxxa number hit a spam rate
 * limit and 165 messages were accepted then dropped. Gupshup is a separate,
 * already-registered number with its own quality rating and its own daily
 * limit, so routing traffic here is real capacity — not a workaround.
 *
 * NOTE this is deliberately separate from the legacy sendWhatsappGupshup.js,
 * which uses the old session-message API (sm/api/v1/msg) and cannot send
 * templates. Templates go to wa/api/v1/template/msg.
 *
 * Env:
 *   GUPSHUP_API_KEY    — required
 *   GUPSHUP_SOURCE     — sending number, digits only (default 917075176108)
 *   GUPSHUP_APP_NAME   — the Gupshup app the number is attached to
 *   GUPSHUP_TMPL_*     — approved template IDs (UUIDs, not names — Gupshup
 *                        addresses templates by id where Flaxxa uses names)
 */

const axios = require('axios');
const { URLSearchParams } = require('url');

const WA_BASE = process.env.GUPSHUP_WA_BASE || 'https://api.gupshup.io/wa/api/v1';
const SOURCE = process.env.GUPSHUP_SOURCE || '917075176108';
const APP_NAME = process.env.GUPSHUP_APP_NAME || '';

function apiKey() {
  const k = process.env.GUPSHUP_API_KEY;
  if (!k) throw new Error('GUPSHUP_API_KEY is not set');
  return k;
}

function isConfigured() {
  return !!(process.env.GUPSHUP_API_KEY && APP_NAME);
}

/** Same normalisation as the Flaxxa client, so both providers agree. */
function e164(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return '91' + digits.slice(1);
  return digits;
}

async function postForm(url, fields) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return axios.post(url, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', apikey: apiKey() },
    timeout: 30000,
    validateStatus: () => true,
  });
}

/**
 * Gupshup answers 2xx with { status:"submitted", messageId } on acceptance.
 *
 * Read "submitted" exactly as sceptically as Flaxxa's wamid: it means Gupshup
 * took the message, NOT that WhatsApp delivered it. Real delivery only shows up
 * on the callback (see MessageLog + /users/webhooks/wapi). Do not let a
 * successful return here be recorded as "delivered" anywhere.
 */
function assertSubmitted(resp, ctx) {
  const { templateId, phone } = ctx;
  if (resp.status < 200 || resp.status >= 300) {
    const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || {});
    throw new Error(`[gupshup] ${templateId} → ${phone}: HTTP ${resp.status} ${body.slice(0, 400)}`);
  }
  const messageId = resp.data?.messageId;
  if (!messageId) {
    throw new Error(
      `[gupshup] ${templateId} → ${phone}: accepted with no messageId — ${JSON.stringify(resp.data).slice(0, 300)}`
    );
  }
  console.log(`[gupshup] ${templateId} → ${phone}: submitted (${messageId})`);
  return { provider: 'gupshup', message_id: messageId, message_wamid: messageId, raw: resp.data };
}

/** Text-only approved template. `params` fill {{1}}, {{2}}, … in order. */
async function sendTemplate(phone, templateId, params = []) {
  if (!isConfigured()) {
    console.warn(`[gupshup] not configured — skipping ${templateId} to ${phone}`);
    return { skipped: true };
  }
  const to = e164(phone);
  const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();

  const resp = await postForm(`${WA_BASE}/template/msg`, {
    channel: 'whatsapp',
    source: SOURCE,
    destination: to,
    'src.name': APP_NAME,
    template: { id: templateId, params: params.map(clean) },
  });
  return assertSubmitted(resp, { templateId, phone: to });
}

/**
 * Template with a document header — the certificate case.
 * Unlike Flaxxa (which wants the file bytes as multipart), Gupshup takes a
 * public URL, so the Cloudinary link is passed straight through.
 */
async function sendTemplateWithDocument(phone, templateId, params, url, filename = 'certificate.pdf') {
  if (!isConfigured()) {
    console.warn(`[gupshup] not configured — skipping ${templateId} with document to ${phone}`);
    return { skipped: true };
  }
  const to = e164(phone);
  const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();

  const resp = await postForm(`${WA_BASE}/template/msg`, {
    channel: 'whatsapp',
    source: SOURCE,
    destination: to,
    'src.name': APP_NAME,
    template: { id: templateId, params: params.map(clean) },
    message: { document: { link: url, filename }, type: 'document' },
  });
  return assertSubmitted(resp, { templateId, phone: to });
}

module.exports = { sendTemplate, sendTemplateWithDocument, isConfigured, e164 };
