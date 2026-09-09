// backend/mergeTools.js
// Merge multiple PDF files into a single PDF using pdf-lib.
//
// Typical Electron IPC usage:
//   const outputPath = await mergeFiles(filePaths);
// When called without options.outputPath the module opens a native
// "Save As" dialog so the user can pick where the merged file is written.
// Corrupt or password-protected inputs throw explicit errors that main.js
// forwards to the React frontend as e.g. event.reply('merge-pdf-error', msg).

const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const { showSaveDialog } = require("./electronDialog");

/** Make sure a user-chosen path has a ".pdf" extension. */
function toPdfPath(filePath) {
  return filePath.toLowerCase().endsWith(".pdf") ? filePath : `${filePath}.pdf`;
}

/** Cheap pre-flight checks before we read/parse a file. */
function assertReadablePdf(filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("A PDF file path is required.");
  }
  if (path.extname(filePath).toLowerCase() !== ".pdf") {
    throw new Error(`"${filePath}" is not a PDF file. Only .pdf files can be merged.`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
}

/**
 * Read and parse a PDF with pdf-lib. Failures are wrapped in explicit,
 * human-readable errors so the caller can report exactly which file was
 * corrupt / password-protected.
 */
async function loadPdf(filePath, options = {}) {
  const ignoreEncryption = options.ignoreEncryption === true;

  let pdfBytes;
  try {
    pdfBytes = fs.readFileSync(filePath);
  } catch (err) {
    throw new Error(`Could not read "${path.basename(filePath)}": ${err.message}`);
  }

  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
  } catch (err) {
    const reason = /encrypt/i.test(err.message)
      ? "it is password-protected"
      : "the file is corrupt or is not a valid PDF";
    throw new Error(
      `"${path.basename(filePath)}" could not be opened (${reason}). ${err.message}`
    );
  }

  if (pdfDoc.isEncrypted) {
    throw new Error(
      `"${path.basename(filePath)}" is password-protected. ` +
        "Please remove the password before merging."
    );
  }

  // Force the page tree to resolve now so partially-valid/corrupt files that
  // lack a usable page tree produce an explicit error instead of crashing
  // later inside copyPages().
  try {
    pdfDoc.getPageCount();
  } catch (_) {
    throw new Error(
      `"${path.basename(filePath)}" could not be opened ` +
        "(the file is corrupt or is not a valid PDF)."
    );
  }
  return pdfDoc;
}

/**
 * Merge the given PDF files into a single PDF document.
 *
 * @param {string[]} filePaths - Absolute paths of the PDFs to merge.
 * @param {object}   [options] - { outputPath?, ignoreEncryption? }. When
 *   outputPath is omitted a native save dialog is opened.
 * @returns {Promise<string|null>} The output path, or null when the user
 *   cancelled the native save dialog.
 */
async function mergeFiles(filePaths, options = {}) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error("No PDF files were selected to merge.");
  }
  for (const filePath of filePaths) assertReadablePdf(filePath);

  // Merge into one PDFDocument (reads each file buffer and copies its pages).
  const mergedPdf = await PDFDocument.create();

  for (const filePath of filePaths) {
    const pdfDoc = await loadPdf(filePath, {
      ignoreEncryption: options.ignoreEncryption === true,
    });
    if (pdfDoc.getPageCount() === 0) {
      throw new Error(`"${path.basename(filePath)}" does not contain any pages.`);
    }
    let copiedPages;
    try {
      copiedPages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
    } catch (err) {
      throw new Error(
        `"${path.basename(filePath)}" could not be processed ` +
          `(it may be corrupt or use unsupported features). ${err.message}`
      );
    }
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }

  if (mergedPdf.getPageCount() === 0) {
    throw new Error("The merged PDF is empty; no pages could be copied.");
  }

  // Ask the user where to save unless an output path was supplied.
  let outputPath = options.outputPath;
  if (!outputPath) {
    const result = await showSaveDialog({
      title: "Save merged PDF",
      buttonLabel: "Save merged PDF",
      defaultPath: "merged.pdf",
      filters: [{ name: "PDF Files", extensions: ["pdf"] }],
    });
    if (result.canceled || !result.filePath) return null; // user cancelled
    outputPath = result.filePath;
  }
  outputPath = toPdfPath(outputPath);

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const mergedBytes = await mergedPdf.save({ useObjectStreams: true });
    fs.writeFileSync(outputPath, mergedBytes);
  } catch (err) {
    throw new Error(`Failed to write merged PDF to "${outputPath}": ${err.message}`);
  }

  return outputPath;
}

module.exports = { mergeFiles };
