// backend/imageTools.js
// Convert PDF pages to raster images (PNG/JPEG) using Poppler's pdftoppm.
//
// Platform strategy:
//   * Windows / macOS use the pdftoppm binary bundled inside pdf-poppler
//     (electron-builder unpacks it via the "asarUnpack" rule).
//   * Linux uses a system `pdftoppm` (poppler-utils) resolved from PATH,
//     because pdf-poppler ships no Linux binaries. On Linux install poppler
//     utils:  sudo apt-get install poppler-utils
//
// IPC usage:
//   convertPDFtoImages(filePaths, outputDir, {
//     format: "png" | "jpeg",
//     dpi: 72 | 150 | 300,
//     quality: 10..90,   // JPEG only
//   });

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const IS_WINDOWS = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const EXE = IS_WINDOWS ? ".exe" : "";

/**
 * Poppler binary directory for the current platform.
 * - Windows/macOS: reuse pdf-poppler's configured directory (it also runs the
 *   macOS dyld/chmod setup needed by its bundled binaries).
 * - Linux: null → rely on the system PATH lookup.
 */
function resolvePopplerDir() {
  if (!IS_WINDOWS && !IS_MAC) return null;
  try {
    // Trigger pdf-poppler's one-time platform setup, then read its bin dir.
    return require("pdf-poppler").path;
  } catch (_) {
    /* fall through to manual discovery below */
  }

  // Manual discovery (e.g. when pdf-poppler failed to initialise).
  const searchRoots = [
    path.resolve(__dirname, "..", "node_modules", "pdf-poppler", "lib"),
    path.resolve(__dirname, "node_modules", "pdf-poppler", "lib"),
  ];
  const platformDir = IS_WINDOWS ? "win" : "osx";
  for (const root of searchRoots) {
    const platformRoot = path.join(root, platformDir);
    if (!fs.existsSync(platformRoot)) continue;
    let entries;
    try {
      entries = fs.readdirSync(platformRoot);
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const versionDir = path.join(platformRoot, entry);
      try {
        if (!fs.statSync(versionDir).isDirectory()) continue;
      } catch (_) {
        continue;
      }
      const candidate = path.join(versionDir, "bin", `pdftoppm${EXE}`);
      if (fs.existsSync(candidate)) return path.join(versionDir, "bin");
    }
  }
  return null;
}

/** Resolve a binary from the system PATH. */
function findOnPath(name) {
  const candidates = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of candidates) {
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

/** Locate a usable pdftoppm executable (bundled → system PATH). */
function resolvePopplerExecutable() {
  const binDir = resolvePopplerDir();
  if (binDir) {
    const bundled = path.join(binDir, `pdftoppm${EXE}`);
    if (fs.existsSync(bundled)) return bundled;
  }
  const system = findOnPath(`pdftoppm${EXE}`) || findOnPath("pdftoppm");
  if (system) return system;
  throw new Error(
    "No PDF rasterizer was found. On Windows/macOS run \"npm run package\" to " +
      "bundle poppler; on Linux install poppler-utils (e.g. sudo apt-get " +
      "install poppler-utils) so pdftoppm is available on PATH."
  );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Poppler < 0.67 lacks "-jpegopt", so quality is applied in a second pass:
 * every freshly rasterised JPEG is re-encoded with the requested quality via
 * sharp (which also preserves the resolution metadata from pdftoppm).
 */
async function applyJpegQuality(outputDir, prefix, quality, dpi) {
  let sharp;
  try {
    sharp = require("sharp");
  } catch (_) {
    return; // sharp missing → keep the rasterizer's default encoding
  }
  const pattern = new RegExp(`^${escapeRegExp(prefix)}-\\d+\\.jpe?g$`, "i");
  let files;
  try {
    files = fs.readdirSync(outputDir).filter((name) => pattern.test(name));
  } catch (_) {
    return;
  }
  for (const name of files) {
    const fullPath = path.join(outputDir, name);
    const tmpPath = `${fullPath}.tmp.${process.pid}`;
    try {
      await sharp(fullPath)
        .jpeg({ quality: Math.round(quality) })
        .withMetadata({ density: Number(dpi) })
        .toFile(tmpPath);
      fs.renameSync(tmpPath, fullPath);
    } finally {
      // Remove the partial temp file on any failure or timeout.
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch (_) {
        /* already gone */
      }
    }
  }
}

/** Make sure a folder exists. */
function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    throw new Error(`Could not create output directory "${dirPath}": ${err.message}`);
  }
}

function sanitizeOptions(options = {}) {
  const format = String(options.format || "png").toLowerCase();
  const isJpeg = format === "jpeg" || format === "jpg";
  const dpi = Number(options.dpi || options.resolution || 150);
  const quality = Math.min(90, Math.max(10, Math.round(Number(options.quality) || 80)));
  return {
    format: isJpeg ? "jpeg" : "png",
    dpi: Number.isFinite(dpi) && dpi > 0 ? Math.round(dpi) : 150,
    quality,
  };
}

/**
 * Rasterise every page of one PDF into `outputDir`.
 * Output files are named `<prefix>-<page>.<ext>` to match Poppler conventions.
 */
async function rasterizeOne(inputPath, outputDir, settings, prefix) {
  if (!inputPath || typeof inputPath !== "string") {
    throw new Error("A valid PDF path is required for conversion.");
  }
  if (!fs.existsSync(inputPath)) {
    throw new Error(`File not found: ${inputPath}`);
  }
  if (path.extname(inputPath).toLowerCase() !== ".pdf") {
    throw new Error(`"${path.basename(inputPath)}" is not a PDF file.`);
  }
  ensureDir(outputDir);

  // Rasterise into a process-unique scratch directory first so a failed or
  // cancelled run never leaves partial page images inside the user's chosen
  // output folder. Finished pages are moved into place only on success.
  const tempDir = path.join(
    outputDir,
    `.pdf-images-${process.pid}-${Date.now().toString(36)}`
  );
  ensureDir(tempDir);

  try {
    const executable = resolvePopplerExecutable();
    const args = [
      settings.format === "jpeg" ? "-jpeg" : "-png",
      "-r",
      String(settings.dpi),
    ];
    args.push(inputPath, path.join(tempDir, prefix));

    try {
      await execFileAsync(executable, args, { timeout: 300000 });
    } catch (err) {
      throw new Error(
        `Could not convert "${path.basename(inputPath)}": ${
          String(err.stderr || err.message || "").trim() || "the rasterizer failed."
        }`
      );
    }

    if (settings.format === "jpeg") {
      await applyJpegQuality(tempDir, prefix, settings.quality, settings.dpi);
    }

    // Move the finished `<prefix>-<n>.<ext>` pages into the output directory.
    const produced = fs
      .readdirSync(tempDir)
      .filter((name) => name.startsWith(`${prefix}-`));
    if (produced.length === 0) {
      throw new Error(`No page images were produced for "${path.basename(inputPath)}".`);
    }
    for (const name of produced) {
      fs.renameSync(path.join(tempDir, name), path.join(outputDir, name));
    }
  } finally {
    // Always remove the scratch directory, including on failure/timeout/cancel.
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  }
}

/**
 * Convert one or more PDFs into page images.
 *
 * @param {string|string[]} inputPaths - PDF file(s) to convert.
 * @param {string}          outputDir  - Destination folder (created if needed).
 * @param {object}          [options]  - { format, dpi, quality }.
 * @returns {Promise<string>} The output directory.
 */
async function convertPDFtoImages(inputPaths, outputDir, options = {}) {
  const filePaths = Array.isArray(inputPaths)
    ? inputPaths
    : inputPaths
      ? [inputPaths]
      : [];
  if (filePaths.length === 0) {
    throw new Error("No PDF files were selected to convert to images.");
  }

  const settings = sanitizeOptions(options);
  const usedPrefixes = new Map();

  for (const filePath of filePaths) {
    const basePrefix = path.basename(filePath, path.extname(filePath));
    const seen = usedPrefixes.get(basePrefix) || 0;
    usedPrefixes.set(basePrefix, seen + 1);
    // Keep filenames unique when several source PDFs share the same basename.
    const prefix = seen === 0 ? basePrefix : `${basePrefix}_${seen + 1}`;
    await rasterizeOne(filePath, outputDir, settings, prefix);
  }

  return outputDir;
}

module.exports = { convertPDFtoImages };

