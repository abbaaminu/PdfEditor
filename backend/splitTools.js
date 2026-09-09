// backend/splitTools.js
// Split a PDF into multiple smaller PDFs using pdf-lib.
//
// Typical Electron IPC usage:
//   const outputFiles = await splitPDF(filePath);          // one file per page
//   const outputFiles = await splitPDF(filePath, {
//     ranges: [[1, 2], [3, 3], [5, 8]],                    // custom page ranges
//   });
// The module opens a native folder picker so the user can choose the output
// directory unless options.outputDir is supplied. Corrupt or password
// protected inputs throw explicit errors that main.js forwards over IPC.

const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const { showOpenDialog } = require("./electronDialog");

/**
 * Read and parse the source PDF with pdf-lib. Failures are wrapped in
 * explicit, human-readable errors naming the offending file.
 */
async function loadSourcePdf(filePath) {
  let pdfBytes;
  try {
    pdfBytes = fs.readFileSync(filePath);
  } catch (err) {
    throw new Error(`Could not read "${path.basename(filePath)}": ${err.message}`);
  }

  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
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
        "Please remove the password before splitting."
    );
  }

  // Force the page tree to resolve now so corrupt files that lack a usable
  // page tree fail here with an explicit error instead of later.
  let pageCount;
  try {
    pageCount = pdfDoc.getPageCount();
  } catch (_) {
    throw new Error(
      `"${path.basename(filePath)}" could not be opened ` +
        "(the file is corrupt or is not a valid PDF)."
    );
  }
  if (pageCount === 0) {
    throw new Error(`"${path.basename(filePath)}" does not contain any pages to split.`);
  }
  return pdfDoc;
}

/**
 * Normalize user supplied ranges (1-based inclusive) to [start, end] pairs and
 * validate them against the document's page count.
 */
function normalizeRanges(ranges, pageCount) {
  const normalized = [];
  for (const raw of ranges) {
    let start;
    let end;
    if (Array.isArray(raw)) {
      if (raw.length !== 2 || !raw.every((n) => Number.isInteger(n))) {
        throw new Error(`Invalid page range: ${JSON.stringify(raw)}. ` +
          "Ranges must be [startPage, endPage] pairs of integers.");
      }
      [start, end] = raw;
    } else if (Number.isInteger(raw)) {
      start = raw;
      end = raw;
    } else {
      throw new Error(`Invalid page range entry: ${JSON.stringify(raw)}.`);
    }
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
      throw new Error(
        `Page range ${start}-${end} is outside the document (1-${pageCount}).`
      );
    }
    if (end < start) [start, end] = [end, start];
    normalized.push([start, end]);
  }
  return normalized;
}

/**
 * Expand a user supplied "1-3, 5, 8-12" style string into validated
 * [start, end] inclusive page ranges (1-based). Every token is parsed and
 * checked against the document so a typo surfaces as an explicit error.
 */
function parsePageRangeText(text, pageCount) {
  const spec = String(text ?? "").trim();
  if (!spec) {
    throw new Error(
      "No page ranges were entered. Use a format like: 1-3, 5, 8-12"
    );
  }
  const tokens = spec
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error(
      "No page ranges were entered. Use a format like: 1-3, 5, 8-12"
    );
  }

  const raw = [];
  for (const token of tokens) {
    const match = /^(\d{1,6})(?:\s*[-–—]\s*(\d{1,6}))?$/.exec(token);
    if (!match) {
      throw new Error(
        `"${token}" is not a valid page range. Expected formats like 1, 3-7 or 8-12.`
      );
    }
    const start = Number.parseInt(match[1], 10);
    const end = match[2] !== undefined ? Number.parseInt(match[2], 10) : start;
    if (end < start) {
      throw new Error(
        `Range ${start}-${end} is reversed — write it from the lowest to the highest page.`
      );
    }
    raw.push([start, end]);
  }
  return normalizeRanges(raw, pageCount);
}

/**
 * Build consecutive [start, end] chunks of `everyN` pages each (the final chunk
 * keeps the remaining pages).
 */
function rangesForEveryN(pageCount, everyN) {
  const chunkSize = Number(everyN);
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error("Split size must be a whole number of 1 or more pages.");
  }
  const ranges = [];
  for (let start = 1; start <= pageCount; start += chunkSize) {
    ranges.push([start, Math.min(start + chunkSize - 1, pageCount)]);
  }
  return ranges;
}

/**
 * Split a PDF into one or more PDFs.
 *
 * @param {string} filePath - Absolute path of the PDF to split.
 * @param {object} [options] - { outputDir?, ranges?, rangesText?, mode?,
 *   everyN?, ignoreEncryption? }. When outputDir is omitted a native folder
 *   picker is opened. Without ranges/mode every page is written as its own
 *   PDF file. Supported modes: "all", "extract" (uses rangesText) and
 *   "every-n" (uses everyN). A plain `ranges` array always takes precedence.
 * @returns {Promise<string[]|null>} The written output paths, or null when
 *   the user cancelled the folder picker.
 */
async function splitPDF(filePath, options = {}) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("No input PDF file was provided to split.");
  }
  if (path.extname(filePath).toLowerCase() !== ".pdf") {
    throw new Error(`"${filePath}" is not a PDF file.`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const sourceDoc = await loadSourcePdf(filePath);
  const pageCount = sourceDoc.getPageCount();

  // Determine which page ranges to write.
  let ranges;
  const mode = String(options.mode || options.splitMode || "all").toLowerCase();

  if (Array.isArray(options.ranges) && options.ranges.length > 0) {
    ranges = normalizeRanges(options.ranges, pageCount);
  } else if (mode === "extract" || mode === "range-text" || mode === "ranges") {
    ranges = parsePageRangeText(options.rangesText, pageCount);
  } else if (mode === "every-n" || mode === "every-n-pages") {
    ranges = rangesForEveryN(pageCount, options.everyN);
  } else {
    ranges = [];
    for (let page = 1; page <= pageCount; page++) ranges.push([page, page]);
  }

  // Ask the user for an output directory unless one was supplied.
  let outputDir = options.outputDir;
  if (!outputDir) {
    const result = await showOpenDialog({
      title: "Select a folder to save the split PDF files",
      buttonLabel: "Select Folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null; // user cancelled
    }
    outputDir = result.filePaths[0];
  }

  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    throw new Error(`Could not create output directory "${outputDir}": ${err.message}`);
  }

  const baseName = path.basename(filePath, path.extname(filePath));
  const outputPaths = [];

  for (const [startPage, endPage] of ranges) {
    const pageIndices = [];
    for (let page = startPage; page <= endPage; page++) pageIndices.push(page - 1);

    const outputPdf = await PDFDocument.create();
    let copiedPages;
    try {
      copiedPages = await outputPdf.copyPages(sourceDoc, pageIndices);
    } catch (err) {
      throw new Error(
        `"${path.basename(filePath)}" could not be processed ` +
          `(pages ${startPage}-${endPage} may be corrupt or use unsupported features). ${err.message}`
      );
    }
    copiedPages.forEach((page) => outputPdf.addPage(page));

    const fileName =
      startPage === endPage
        ? `${baseName}_page_${startPage}.pdf`
        : `${baseName}_pages_${startPage}_to_${endPage}.pdf`;
    const outputPath = path.join(outputDir, fileName);

    try {
      fs.writeFileSync(outputPath, await outputPdf.save({ useObjectStreams: true }));
    } catch (err) {
      throw new Error(`Failed to write "${outputPath}": ${err.message}`);
    }
    outputPaths.push(outputPath);
  }

  return outputPaths;
}

module.exports = { splitPDF };
