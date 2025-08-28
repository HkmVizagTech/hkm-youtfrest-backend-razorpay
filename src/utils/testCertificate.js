const axios = require('axios');

async function testDifferentTemplate() {
  try {
    console.log('🧪 Testing with different approach by saikiran11461 at 2025-08-24 18:34:36');
    

    const response1 = await axios.post(
      'https://api.gupshup.io/sm/api/v1/template/msg',
      {
        channel: 'whatsapp',
        source: '917075176108',
        destination: '918688487669',
        'src.name': 'Production',
        template: JSON.stringify({
          id: '1e5b2dd0-3ee7-4d8d-bd41-9a80073b1399',
          params: ['testing user']
        })
      },
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'apikey': 'REDACTED_ROTATE_THIS_KEY'
        }
      }
    );
    
    console.log('✅ Template without media result:', response1.data);
    
    // Test 2: Check if there are any webhook configurations
    try {
      const webhookResponse = await axios.get(
        'https://api.gupshup.io/sm/api/v1/settings/webhooks',
        {
          headers: {
            'apikey': 'REDACTED_ROTATE_THIS_KEY'
          }
        }
      );
      console.log('🔗 Webhook configuration:', webhookResponse.data);
    } catch (webhookError) {
      console.log('ℹ️ Webhook check not available');
    }
    
  } catch (error) {
    console.error('❌ Different template test failed:', error.response?.data || error.message);
  }
}

testDifferentTemplate();