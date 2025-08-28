const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

async function generateCertificatePDF(candidateName, outputPath) {
  const templatePath = path.join(__dirname, '../certifications/certificate.pdf');
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Certificate template not found at: ${templatePath}`);
  }
  const existingPdfBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(existingPdfBytes);
  const pages = pdfDoc.getPages();
  const firstPage = pages[0];

  firstPage.drawText(candidateName, {
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

module.exports = { generateCertificatePDF };