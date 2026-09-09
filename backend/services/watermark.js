const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

async function applyWatermarkToPdf(inputPath, outputPath, options = {}) {
  const {
    text = 'CONFIDENTIAL',
    fontSize = 48,
    opacity = 0.35,
    rotation = 45,
  } = options;

  const pdfBytes = fs.readFileSync(inputPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages = pdfDoc.getPages();

  for (const page of pages) {
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const textHeight = font.heightAtSize(fontSize);

    page.drawText(text, {
      x: (width - textWidth) / 2,
      y: (height - textHeight) / 2,
      size: fontSize,
      font,
      color: rgb(0.6, 0.6, 0.6),
      opacity: parseFloat(opacity),
      rotate: degrees(Number(rotation)),
    });
  }

  const modifiedBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, modifiedBytes);
  return outputPath;
}

async function batchWatermark(filePaths, outputDir, options = {}) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const processedFiles = [];
  for (const filePath of filePaths) {
    const fileName = path.basename(filePath, '.pdf');
    const outputPath = path.join(outputDir, `${fileName}_watermarked.pdf`);
    await applyWatermarkToPdf(filePath, outputPath, options);
    processedFiles.push(outputPath);
  }

  return processedFiles;
}

module.exports = { applyWatermarkToPdf, batchWatermark };