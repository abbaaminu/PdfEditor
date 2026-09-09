// backend/compressTools.js
// Compress / optimize a PDF file.
//
// Engine strategy:
//   * Ghostscript (preferred, real lossy re-compression of images + fonts).
//   * pdf-lib (automatic fallback): rewrites the document so metadata,
//     attachments and orphaned objects are dropped. pdf-lib cannot perform
//     lossy image compression, so this fallback primarily "cleans" the file.
// pdf-lib is always used first to validate the input so corrupt or
// password-protected files fail with an explicit, user-facing error.
//
// Typical Electron IPC usage:
//   const result = await compressPDF(filePath);
// Returns { outputPath, engine, originalSize, outputSize, savingsPercent } or
// null when the user cancels the native save dialog.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { PDFDocument } = require("pdf-lib");
const { showSaveDialog } = require("./electronDialog");

const execFileAsync = promisify(execFile);

/** Ghostscript quality presets mapped to -dPDFSETTINGS values. */
const PDF_SETTINGS = {
  screen: "/screen", // lowest quality / smallest size (~72 dpi)
  ebook: "/ebook", // medium quality (~150 dpi)
  printer: "/printer", // high quality (~300 dpi)
  prepress: "/prepress", // near lossless
  default: "/default",
};

/** Candidate executable names on PATH. */
const GS_NAMES = ["gswin64c.exe", "gswin32c.exe", "gs.exe", "gs"];

/** Common Ghostscript installation roots on Windows. */
const GS_ROOTS = ["C:\\Program Files\\gs", "C:\\Program Files (x86)\\gs"];

/** Make sure a user-chosen path has a ".pdf" extension. */
function toPdfPath(filePath) {
  return filePath.toLowerCase().endsWith(".pdf") ? filePath : `${filePath}.pdf`;
}

/**
 * Locate a Ghostscript executable. Resolution order:
 *   1. GS_PATH / GS_EXECUTABLE environment variable.
 *   2. Versioned sub-folders under the common Windows install roots.
 *   3. Any executable named like Ghostscript on PATH.
 */
function resolveGhostscript() {
  const fromEnv = process.env.GS_PATH || process.env.GS_EXECUTABLE;
  if (fromEnv) {
    try {
      if (fs.statSync(fromEnv).isFile()) return fromEnv;
    } catch (_) {
      /* fall through to the standard installation and PATH checks */
    }
  }

  for (const root of GS_ROOTS) {
    if (!fs.existsSync(root)) continue;
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const versionDir = path.join(root, entry);
      let isDirectory = false;
      try {
        isDirectory = fs.statSync(versionDir).isDirectory();
      } catch (_) {
        /* ignore */
      }
      if (!isDirectory) continue;
      for (const bin of ["gswin64c.exe", "gswin32c.exe"]) {
        const candidate = path.join(versionDir, "bin", bin);
        if (fs.statSync(candidate).isFile()) return candidate;
      }
    }
  }

  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of GS_NAMES) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch (_) {
        /* ignore */
      }
    }
  }
  return null;
}

/**
 * Read and validate the source PDF with pdf-lib so corrupt files are caught
 * before any compression engine runs.
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
        "Please remove the password before compressing."
    );
  }

  // Force the page tree to resolve now so corrupt files that lack a usable
  // page tree fail here with an explicit error instead of later.
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
 * Compress via Ghostscript. Uses execFile with an argument array (no shell
 * interpolation) so paths with spaces or special characters are safe.
 */
async function compressWithGhostscript(inputPath, outputPath, preset, dpi, quality) {
  const gsPath = resolveGhostscript();
  if (!gsPath) {
    throw new Error(
      "Ghostscript was not found. Install it from https://ghostscript.com or " +
        "set the GS_PATH environment variable to the gswin64c.exe binary."
    );
  }

  const setting = PDF_SETTINGS[preset];
  if (!setting) {
    throw new Error(
      `Unknown Ghostscript preset "${preset}". Use one of: ` +
        Object.keys(PDF_SETTINGS).join(", ") +
        "."
    );
  }

  const args = [
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    `-dPDFSETTINGS=${setting}`,
    "-dNOPAUSE",
    "-dBATCH",
    "-dQUIET",
    "-dSAFER",
    "-dEmbedAllFonts=false",
    "-dSubsetFonts=true",
    "-dAutoRotatePages=/None",
    "-dColorImageDownsampleType=/Bicubic",
    "-dGrayImageDownsampleType=/Bicubic",
    "-dMonoImageDownsampleType=/Subsample",
    "-dAutoFilterColorImages=true",
    "-dAutoFilterGrayImages=true",
    "-dColorImageFilter=/DCTEncode",
    "-dGrayImageFilter=/DCTEncode",
    "-dEncodeColorImages=true",
    "-dEncodeGrayImages=true",
  ];

  if (Number.isFinite(Number(dpi)) && Number(dpi) > 0) {
    args.push("-dDownsampleColorImages=true", `-dColorImageResolution=${Number(dpi)}`);
    args.push("-dDownsampleGrayImages=true", `-dGrayImageResolution=${Number(dpi)}`);
  }

  // Explicit JPEG quality (10-90). Ghostscript accepts -dJPEGQ to tune the
  // DCT re-encode of downsampled raster images.
  if (Number.isFinite(Number(quality))) {
    const jpegQuality = Math.min(90, Math.max(10, Math.round(Number(quality))));
    args.push(`-dJPEGQ=${jpegQuality}`);
  }

  args.push(`-sOutputFile=${outputPath}`, inputPath);

  try {
    await execFileAsync(gsPath, args, { windowsHide: true, timeout: 180000 });
  } catch (err) {
    const tail = String(err.stderr || err.message || "")
      .trim()
      .split(/\r?\n/)
      .slice(-3)
      .join(" ");
    throw new Error(`Ghostscript compression failed${tail ? `: ${tail}` : "."}`);
  }
}


/**
 * pdf-lib fallback engine: rebuild the document with only its page content.
 * Document-level metadata, attachments and unreachable objects are dropped,
 * which yields a smaller (and cleaner) file whenever the source carried that
 * extra baggage.
 */
async function compressWithPdfLib(inputPath, outputPath, sourceDoc) {
  const cleanDoc = await PDFDocument.create();
  let copiedPages;
  try {
    copiedPages = await cleanDoc.copyPages(sourceDoc, sourceDoc.getPageIndices());
  } catch (err) {
    throw new Error(
      `"${path.basename(inputPath)}" could not be processed ` +
        `(it may be corrupt or use unsupported features). ${err.message}`
    );
  }
  copiedPages.forEach((page) => cleanDoc.addPage(page));
  const bytes = await cleanDoc.save({ useObjectStreams: true });
  try {
    fs.writeFileSync(outputPath, bytes);
  } catch (err) {
    throw new Error(`Failed to write compressed PDF to "${outputPath}": ${err.message}`);
  }
}

/**
 * Compress a PDF file.
 *
 * @param {string}  inputPath - Absolute path of the PDF to compress.
 * @param {object|string} [optionsOrOutputPath] - Either an options object
 *   ({ outputPath?, preset?, engine?, dpi? }) or a legacy string output path.
 * @param {number}  [legacyDpi] - Legacy third argument (dpi).
 * @returns {Promise<object|null>} Compression report, or null when the user
 *   cancels the native save dialog.
 */
async function compressPDF(inputPath, optionsOrOutputPath, legacyDpi) {
  // Normalise the two supported calling styles:
  //   compressPDF(file)
  //   compressPDF(file, { outputPath, preset, engine, dpi })
  //   compressPDF(file, "output.pdf", 150)   (legacy)
  let options = {};
  if (typeof optionsOrOutputPath === "string") {
    options = { outputPath: optionsOrOutputPath };
    if (legacyDpi) options.dpi = legacyDpi;
  } else if (optionsOrOutputPath && typeof optionsOrOutputPath === "object") {
    options = optionsOrOutputPath;
  } else if (legacyDpi) {
    options.dpi = legacyDpi;
  }

  if (!inputPath || typeof inputPath !== "string") {
    throw new Error("No input PDF file was provided to compress.");
  }
  if (path.extname(inputPath).toLowerCase() !== ".pdf") {
    throw new Error(`"${inputPath}" is not a PDF file.`);
  }
  if (!fs.existsSync(inputPath)) {
    throw new Error(`File not found: ${inputPath}`);
  }

  // pdf-lib validation pass: catches corrupt / password-protected files first.
  const sourceDoc = await loadSourcePdf(inputPath);
  if (sourceDoc.getPageCount() === 0) {
    throw new Error(`"${path.basename(inputPath)}" does not contain any pages.`);
  }
  const originalSize = fs.statSync(inputPath).size;
  if (originalSize === 0) {
    throw new Error(`"${path.basename(inputPath)}" is empty.`);
  }

  // Ask the user where to save unless an output path was supplied.
  let outputPath = options.outputPath;
  if (!outputPath) {
    const result = await showSaveDialog({
      title: "Save compressed PDF",
      buttonLabel: "Save compressed PDF",
      defaultPath: `${path.basename(inputPath, path.extname(inputPath))}_compressed.pdf`,
      filters: [{ name: "PDF Files", extensions: ["pdf"] }],
    });
    if (result.canceled || !result.filePath) return null; // user cancelled
    outputPath = result.filePath;
  }
  outputPath = toPdfPath(outputPath);

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  } catch (err) {
    throw new Error(`Could not create output folder for "${outputPath}": ${err.message}`);
  }

  // Pick a compression engine. Both engines write to a process-unique temp
  // path first; the temp file is renamed to the real destination only after a
  // fully successful run and is always removed again on failure/timeout/cancel.
  const engine = String(options.engine || "auto").toLowerCase();
  const preset = String(options.preset || "screen").toLowerCase();
  const tempOutput = `${outputPath}.tmp.${process.pid}`;
  let usedEngine;

  try {
    if (engine === "auto") {
      if (resolveGhostscript()) {
        await compressWithGhostscript(inputPath, tempOutput, preset, options.dpi, options.quality);
        usedEngine = "ghostscript";
      } else {
        await compressWithPdfLib(inputPath, tempOutput, sourceDoc);
        usedEngine = "pdf-lib";
      }
    } else if (engine === "gs" || engine === "ghostscript") {
      await compressWithGhostscript(inputPath, tempOutput, preset, options.dpi, options.quality);
      usedEngine = "ghostscript";
    } else if (engine === "pdf" || engine === "pdf-lib" || engine === "pdflib") {
      await compressWithPdfLib(inputPath, tempOutput, sourceDoc);
      usedEngine = "pdf-lib";
    } else {
      throw new Error(
        `Unknown compression engine "${options.engine}". Use "auto", "ghostscript" or "pdf-lib".`
      );
    }

    if (!fs.existsSync(tempOutput) || fs.statSync(tempOutput).size === 0) {
      throw new Error("Compression produced an empty output file.");
    }

    try {
      fs.rmSync(outputPath, { force: true });
    } catch (_) {
      /* output may not exist yet; rename will overwrite on POSIX anyway */
    }
    fs.renameSync(tempOutput, outputPath);
  } finally {
    // Never leave a partial `.tmp.<pid>` file behind (failure, timeout, cancel…).
    try {
      if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
    } catch (_) {
      /* already gone */
    }
  }

  const outputSize = fs.statSync(outputPath).size;
  const savingsPercent =
    originalSize > 0
      ? Math.round(((originalSize - outputSize) / originalSize) * 100)
      : 0;

  return {
    outputPath,
    engine: usedEngine,
    originalSize,
    outputSize,
    savingsPercent: Math.max(savingsPercent, 0),
  };
}

module.exports = { compressPDF };
