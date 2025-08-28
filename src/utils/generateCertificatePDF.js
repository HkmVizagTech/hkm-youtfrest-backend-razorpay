const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const axios = require('axios');
const FormData = require('form-data');

const GUPSHUP_API_KEY = 'REDACTED_ROTATE_THIS_KEY';
const GUPSHUP_SOURCE = '917075176108';

async function generateCertificatePDF(candidateName, outputPath) {
  const templatePath = path.join(__dirname, '../certifications/certificate.pdf');
  if (!fs.existsSync(templatePath)) throw new Error(`Certificate template not found at: ${templatePath}`);
  const existingPdfBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(existingPdfBytes);
  const page = pdfDoc.getPages()[0];
  page.drawText(candidateName, {
    x: 200,
    y: 300,
    size: 36,
    font: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    color: rgb(0, 0, 0)
  });
  const pdfBytes = await pdfDoc.save();
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, pdfBytes);
  return outputPath;
}

async function sendCertificateWithTemplate(candidate, certificatePath) {
  let normalizedNumber = candidate.whatsappNumber.replace(/[^0-9]/g, '');
  if (!normalizedNumber.startsWith('91')) normalizedNumber = '91' + normalizedNumber;
  const formData = new FormData();
  formData.append('channel', 'whatsapp');
  formData.append('source', GUPSHUP_SOURCE);
  formData.append('destination', normalizedNumber);
  formData.append('src.name', 'Production');
  formData.append('template', JSON.stringify({
    id: '1e5b2dd0-3ee7-4d8d-bd41-9a80073b1399',
    params: []
  }));
  formData.append('media', fs.createReadStream(certificatePath), {
    filename: path.basename(certificatePath),
    contentType: 'application/pdf'
  });
  const response = await axios.post(
    'https://api.gupshup.io/sm/api/v1/template/msg',
    formData,
    {
      headers: {
        ...formData.getHeaders(),
        apikey: GUPSHUP_API_KEY
      },
      timeout: 60000
    }
  );
  return response.data;
}

module.exports = { generateCertificatePDF, sendCertificateWithTemplate };