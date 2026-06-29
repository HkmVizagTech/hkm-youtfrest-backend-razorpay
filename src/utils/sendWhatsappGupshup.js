const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const GUPSHUP_API_KEY = process.env.GUPSHUP_API_KEY;
const GUPSHUP_SOURCE = '917075176108';


let gupshup;
try {
  gupshup = require('@api/gupshup');
  console.log('✅ Gupshup SDK loaded successfully');
} catch (error) {
  console.log('⚠️ Gupshup SDK not available, using pure axios approach');
  gupshup = null;
}

function normalizeNumber(number) {
  if (!number) throw new Error(`Invalid WhatsApp number: ${number}`);
  let n = String(number).replace(/[^0-9]/g, '');
  if (n.startsWith('0')) n = n.slice(1);
  if (n.startsWith('91') && n.length === 12) return n;
  if (n.length === 10) return '91' + n;
  throw new Error(`Invalid WhatsApp number: ${number}`);
}


async function sendDirectTextMessage(normalizedNumber, candidate, message) {
  console.log(`📱 Sending direct text message to ${candidate.name}`);
  
  const payload = {
    channel: 'whatsapp',
    source: GUPSHUP_SOURCE,
    destination: normalizedNumber,
    'src.name': 'Production',
    message: message
  };

  const response = await axios.post('https://api.gupshup.io/sm/api/v1/msg', payload, {
    headers: {
      'Content-Type': 'application/json',
      'apikey': GUPSHUP_API_KEY
    },
    timeout: 30000
  });

  return response.data;
}


async function sendCertificateTemplate(normalizedNumber, candidate) {
  console.log(`📜 Sending certificate-specific template to ${candidate.name}`);
  

  const certificateMessage = `🎉 Congratulations ${candidate.name}! 🏆

Your *Certificate of Completion* for the Krishna Pulse Youth Fest has been generated successfully! ✨

🎓 Event: Krishna Pulse Youth Fest 2025
👤 Participant: ${candidate.name}
🏫 College: ${candidate.college}
📚 Course: ${candidate.course}
📅 Event Date: 15th August 2025

Thank you for being part of this amazing spiritual journey! Your participation and enthusiasm made the event truly special. 🙏

Due to technical limitations, we'll be sending your certificate via email shortly. Please check your email: ${candidate.email}

With divine blessings,
Hare Krishna Movement, Visakhapatnam 🕉️`;

  return await sendDirectTextMessage(normalizedNumber, candidate, certificateMessage);
}

async function sendWhatsappGupshup(candidate, templateParams = [candidate.name], templateIdOverride = null, mediaPath = null) {
  let normalizedNumber;
  try {
    normalizedNumber = normalizeNumber(candidate.whatsappNumber);
  } catch (err) {
    console.error('❌ WhatsApp number error:', err.message);
    return { error: err.message };
  }

  try {
    if (mediaPath) {
      console.log(`📤 Sending certificate to ${candidate.name} (${normalizedNumber})`);
      console.log(`📁 Certificate path: ${mediaPath}`);
      
   
      if (!fs.existsSync(mediaPath)) {
        throw new Error(`Certificate file not found: ${mediaPath}`);
      }

      const fileStats = fs.statSync(mediaPath);
      console.log(`📊 File size: ${fileStats.size} bytes`);

  
      try {
        console.log('🔄 Method 1: Minimal FormData structure...');
        
        const formData = new FormData();
        formData.append('channel', 'whatsapp');
        formData.append('source', GUPSHUP_SOURCE);
        formData.append('destination', normalizedNumber);
        formData.append('src.name', 'Production');
        formData.append('message', `🎉 Certificate for ${candidate.name} 🏆`);
        formData.append('media', fs.createReadStream(mediaPath));

        const response = await axios.post('https://api.gupshup.io/sm/api/v1/msg', formData, {
          headers: {
            ...formData.getHeaders(),
            'apikey': GUPSHUP_API_KEY
          },
          timeout: 60000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });

        console.log('✅ Certificate sent successfully:', response.data);
        return response.data;

      } catch (method1Error) {
        console.log('❌ Method 1 failed:', method1Error.response?.data || method1Error.message);

  
        try {
          console.log('🔄 Method 2: Without src.name...');
          
          const formData2 = new FormData();
          formData2.append('channel', 'whatsapp');
          formData2.append('source', GUPSHUP_SOURCE);
          formData2.append('destination', normalizedNumber);
          formData2.append('message', `🎉 Certificate for ${candidate.name} 🏆`);
          formData2.append('media', fs.createReadStream(mediaPath));

          const response2 = await axios.post('https://api.gupshup.io/sm/api/v1/msg', formData2, {
            headers: {
              ...formData2.getHeaders(),
              'apikey': GUPSHUP_API_KEY
            },
            timeout: 60000
          });

          console.log('✅ Certificate sent via method 2:', response2.data);
          return response2.data;

        } catch (method2Error) {
          console.log('❌ Method 2 failed:', method2Error.response?.data || method2Error.message);

          try {
            console.log('🔄 Method 3: Media only...');
            
            const formData3 = new FormData();
            formData3.append('channel', 'whatsapp');
            formData3.append('source', GUPSHUP_SOURCE);
            formData3.append('destination', normalizedNumber);
            formData3.append('media', fs.createReadStream(mediaPath));

            const response3 = await axios.post('https://api.gupshup.io/sm/api/v1/msg', formData3, {
              headers: {
                ...formData3.getHeaders(),
                'apikey': GUPSHUP_API_KEY
              },
              timeout: 60000
            });

            console.log('✅ Media sent, now sending caption...');
            

            const captionMessage = `🎉 Congratulations ${candidate.name}! 🏆\n\nHere's your certificate of completion for the Krishna Pulse Youth Fest!\n\nThank you for being part of this amazing journey! 🙏`;
            
            const captionResponse = await sendDirectTextMessage(normalizedNumber, candidate, captionMessage);
            
            console.log('✅ Certificate and caption sent successfully');
            return {
              ...response3.data,
              captionSent: captionResponse
            };

          } catch (method3Error) {
            console.log('❌ Method 3 failed:', method3Error.response?.data || method3Error.message);

         
            try {
              console.log('🔄 Method 4: Ultra-compressed JPEG...');
              
              const Canvas = require('canvas');
              
      
              const image = await Canvas.loadImage(mediaPath);
              const canvas = Canvas.createCanvas(800, Math.round(800 * (image.height / image.width))); // Smaller size
              const ctx = canvas.getContext('2d');
              ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
              
         
              const jpegBuffer = canvas.toBuffer('image/jpeg', { quality: 0.5 });
              const jpegPath = mediaPath.replace('.png', '_compressed.jpg');
              fs.writeFileSync(jpegPath, jpegBuffer);
              
              console.log(`📉 Ultra-compressed JPEG size: ${jpegBuffer.length} bytes`);

              const formData4 = new FormData();
              formData4.append('channel', 'whatsapp');
              formData4.append('source', GUPSHUP_SOURCE);
              formData4.append('destination', normalizedNumber);
              formData4.append('message', `🎉 Certificate for ${candidate.name} 🏆`);
              formData4.append('media', fs.createReadStream(jpegPath));

              const response4 = await axios.post('https://api.gupshup.io/sm/api/v1/msg', formData4, {
                headers: {
                  ...formData4.getHeaders(),
                  'apikey': GUPSHUP_API_KEY
                },
                timeout: 60000
              });

             
              if (fs.existsSync(jpegPath)) {
                fs.unlinkSync(jpegPath);
              }

              console.log('✅ Ultra-compressed certificate sent:', response4.data);
              return response4.data;

            } catch (method4Error) {
              console.log('❌ Method 4 failed:', method4Error.response?.data || method4Error.message);

            
              console.log('🔄 Final fallback: Certificate-specific text message...');
              
              try {
                const certificateResponse = await sendCertificateTemplate(normalizedNumber, candidate);
                
                console.log('⚠️ Certificate notification sent (media delivery failed):', certificateResponse);
                return {
                  ...certificateResponse,
                  warning: 'Certificate image could not be delivered via WhatsApp, detailed notification sent instead',
                  originalErrors: {
                    method1: method1Error.response?.data || method1Error.message,
                    method2: method2Error.response?.data || method2Error.message,
                    method3: method3Error.response?.data || method3Error.message,
                    method4: method4Error.response?.data || method4Error.message
                  }
                };

              } catch (textError) {
                console.log('❌ Text message also failed:', textError.response?.data || textError.message);
                throw new Error(`All delivery methods failed. Final error: ${textError.response?.data || textError.message}`);
              }
            }
          }
        }
      }
    } else {
    
      console.log(`📤 Sending template message to ${candidate.name} (${normalizedNumber})`);
      
      if (gupshup && gupshup.sendingTextTemplate) {
   
        let templateId = templateIdOverride;
        if (!templateId) {
          switch ((candidate.gender || '').trim().toLowerCase()) {
            case 'male': 
              templateId = '2e1d19a6-5f70-4db7-9117-7c135490cc93'; 
              console.log('🚹 Using male template');
              break;
            case 'female': 
              templateId = 'ec467dfe-34dd-40ea-9cd5-8e74644d9ccf'; 
              console.log('🚺 Using female template');
              break;
            default: 
              templateId = '8d7d1fff-0543-4a4f-bc33-886bb0aa1fef';
              console.log('⚪ Using default template');
          }
        }

        const message = await gupshup.sendingTextTemplate({
          template: { id: templateId, params: templateParams },
          'src.name': 'Production',
          destination: normalizedNumber,
          source: GUPSHUP_SOURCE,
        }, {
          apikey: GUPSHUP_API_KEY
        });
        
        console.log('✅ Template message sent successfully:', message.data);
        return message.data;
      } else {
      
        const directMessage = `Hare Krishna ${candidate.name}! 🙏\n\nThank you for your participation in the Krishna Pulse Youth Fest! Your registration is confirmed and we're excited to have you join us.\n\nWith best wishes,\nHare Krishna Movement, Visakhapatnam`;
        
        const response = await sendDirectTextMessage(normalizedNumber, candidate, directMessage);
        console.log('✅ Direct message sent successfully:', response);
        return response;
      }
    }
  } catch (err) {
    console.error('❌ Error sending WhatsApp via Gupshup:', err.response?.data || err.message || err);
    return { error: err.response?.data || err.message || 'Unknown error occurred' };
  }
}

module.exports = sendWhatsappGupshup;