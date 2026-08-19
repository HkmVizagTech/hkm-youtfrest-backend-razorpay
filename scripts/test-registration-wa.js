require('dotenv').config();

const { sendRegistrationConfirmed } = require('../src/utils/sendWhatsappFlaxxa');

function main() {
  const phone = process.env.TEST_PHONE;
  const name = process.env.TEST_NAME || 'Hare Krishna';
  const gender = process.env.TEST_GENDER || 'Male';

  if (!process.env.WAPI_TOKEN) {
    console.error('❌ WAPI_TOKEN is not set (server/.env)');
    process.exit(1);
  }
  if (!process.env.WAPI_TMPL_REGISTRATION_MALE && !process.env.WAPI_TMPL_REGISTRATION_FEMALE) {
    console.error('❌ WAPI_TMPL_REGISTRATION_MALE / _FEMALE not set (server/.env)');
    process.exit(1);
  }
  if (!phone) {
    console.error('❌ TEST_PHONE is not set — use your WhatsApp number with country code, e.g. 919876543210');
    process.exit(1);
  }

  console.log(`📤 Sending registration template to ${phone} (gender=${gender})…`);
  return sendRegistrationConfirmed({ whatsappNumber: phone, name, gender })
    .then((res) => {
      console.log('✅ Result:', JSON.stringify(res, null, 2));
    })
    .catch((err) => {
      console.error('❌ Send failed:', err.response?.data || err.message);
      process.exitCode = 1;
    });
}

main();
