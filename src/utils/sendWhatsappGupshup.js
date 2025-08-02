const gupshup = require('@api/gupshup');


function normalizeNumber(number) {
  if (!number) throw new Error(`Invalid WhatsApp number: ${number}`);
  let n = String(number).replace(/[^0-9]/g, '');
  if (n.startsWith('0')) n = n.slice(1);
  if (n.startsWith('91') && n.length === 12) return n;
  if (n.length === 10) return '91' + n;
  throw new Error(`Invalid WhatsApp number: ${number}`);
}
async function sendWhatsappGupshup(candidate, templateParams = [candidate.name], templateIdOverride = null) {
  let templateId = templateIdOverride;
  if (!templateId) {
    switch ((candidate.gender || '').trim().toLowerCase()) {
      case 'male': templateId = '2e1d19a6-5f70-4db7-9117-7c135490cc93'; break;
      case 'female': templateId = 'ec467dfe-34dd-40ea-9cd5-8e74644d9ccf'; break;
      default: templateId = '8d7d1fff-0543-4a4f-bc33-886bb0aa1fef';
    }
  }
  let normalizedNumber;
  try {
    normalizedNumber = normalizeNumber(candidate.whatsappNumber);
  } catch (err) {
    console.error('Gupshup WhatsApp error:', err.message);
    return { error: err.message };
  }
  try {
    const message = await gupshup.sendingTextTemplate(
      {
        template: { id: templateId, params: templateParams },
        'src.name': 'Production',
        destination: normalizedNumber,
        source: '917075176108',
      },
      { apikey: 'zbut4tsg1ouor2jks4umy1d92salxm38' }
    );
  //  console.log('WhatsApp message sent:', message.data);
    return message.data;
  } catch (err) {
    console.error('Error sending WhatsApp via Gupshup:', err.response?.data || err.message || err);
    return { error: err.response?.data || err.message || err };
  }
}
module.exports = sendWhatsappGupshup;