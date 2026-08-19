require('dotenv').config();
const axios = require('axios');

const BASE = 'https://wapi.flaxxa.com/api/v1/sendtemplatemessage';
const TOKEN = process.env.WAPI_TOKEN;
const PHONE = process.env.TEST_PHONE;
const TEMPLATE = process.env.WAPI_TMPL_REGISTRATION_MALE;
const LANG = process.env.WAPI_TEMPLATE_LANG || 'en';

const variants = {
  components_array: [
    { type: 'body', parameters: [{ type: 'text', text: 'NameFromComponentsArray' }] },
  ],
  flat_body_body_1: { body_body_1: 'NameFromBodyBodyFlat' },
  flat_body_text_1: { body_text_1: 'NameFromBodyTextFlat' },
  flat_body_1: { body_1: 'NameFromBodyOneFlat' },
};

(async () => {
  for (const [label, body] of Object.entries(variants)) {
    const payload = {
      token: TOKEN,
      phone: PHONE,
      template_name: TEMPLATE,
      template_language: LANG,
      ...body,
    };
    try {
      const res = await axios.post(BASE, payload, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 15000,
      });
      console.log(`${label.padEnd(20)} →`, JSON.stringify(res.data));
    } catch (err) {
      console.log(`${label.padEnd(20)} → ERR`, JSON.stringify(err.response?.data || err.message));
    }
  }
})();
