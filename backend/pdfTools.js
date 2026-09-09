const { PDFDocument } = require("pdf-lib");
const fs = require("fs");

async function mergePDFs(files, outputPath) {
  const mergedPdf = await PDFDocument.create();
  for (const file of files) {
    const pdfBytes = fs.readFileSync(file);
    const pdf = await PDFDocument.load(pdfBytes);
    const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }
  const mergedBytes = await mergedPdf.save();
  fs.writeFileSync(outputPath, mergedBytes);
}

module.exports = { mergePDFs };
