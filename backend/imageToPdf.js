// backend/imageToPdf.js
// Assemble PNG/JPG images into a single PDF using pdf-lib.
//
// IPC usage: imagesToPDF(imagePaths, outputPath, options)
//   options.pageSize    - "a4" | "letter" | "fit"            (default "a4")
//   options.orientation - "auto" | "portrait" | "landscape"   (default "auto")
//   options.margin      - "none" | "small" | "large"          (default "small")

const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");

/** Standard page dimensions in PDF points. */
const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

/** Page margins in points (72 pt = 1 inch). */
const MARGINS = {
  none: 0,
  small: 18, // 0.25 in
  large: 72, // 1 in
};

function toExtension(imagePath) {
  return path.extname(imagePath).toLowerCase();
}

/**
 * Compute the oriented output page box for the requested size/orientation.
 */
function resolvePageBox(pageSize, orientation, naturalWidth, naturalHeight) {
  let width;
  let height;

  if (pageSize === "fit") {
    width = naturalWidth;
    height = naturalHeight;
  } else {
    const size = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
    width = size[0];
    height = size[1];
  }

  if (orientation === "portrait" && width > height) {
    [width, height] = [height, width];
  } else if (orientation === "landscape" && width < height) {
    [width, height] = [height, width];
  }
  return { width, height };
}

/**
 * Assemble the given image files into a single PDF document.
 *
 * @param {string[]} imagePaths - Absolute paths (PNG/JPG) in page order.
 * @param {string}   outputPath - Absolute destination ".pdf" path.
 * @param {object}   [options]  - Layout options documented above.
 * @returns {Promise<string>} The output path.
 */
async function imagesToPDF(imagePaths, outputPath, options = {}) {
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    throw new Error("No images were selected to assemble into a PDF.");
  }

  const pageSize = String(options.pageSize || "a4").toLowerCase();
  const orientation = String(options.orientation || "auto").toLowerCase();
  const marginLabel = String(options.margin || "small").toLowerCase();
  const margin = Number.isFinite(MARGINS[marginLabel]) ? MARGINS[marginLabel] : MARGINS.small;

  const pdfDoc = await PDFDocument.create();

  for (const imagePath of imagePaths) {
    if (!imagePath || typeof imagePath !== "string") {
      throw new Error("A valid image path is required to build the PDF.");
    }
    if (!fs.existsSync(imagePath)) {
      throw new Error(`File not found: ${imagePath}`);
    }

    const extension = toExtension(imagePath);
    const imageBytes = fs.readFileSync(imagePath);

    let image;
    try {
      if (extension === ".png") {
        image = await pdfDoc.embedPng(imageBytes);
      } else if (extension === ".jpg" || extension === ".jpeg") {
        image = await pdfDoc.embedJpg(imageBytes);
      } else {
        throw new Error(`"${path.basename(imagePath)}" is not a PNG or JPEG image.`);
      }
    } catch (err) {
      if (err.message && err.message.includes("PNG")) {
        throw err;
      }
      throw new Error(`"${path.basename(imagePath)}" is not a valid image file. ${err.message}`);
    }

    const naturalWidth = image.width;
    const naturalHeight = image.height;
    const { width: pageWidth, height: pageHeight } = resolvePageBox(
      pageSize,
      orientation,
      naturalWidth,
      naturalHeight
    );

    // Fit the image inside the printable area while preserving aspect ratio,
    // then centre it on the page.
    const contentWidth = Math.max(1, pageWidth - margin * 2);
    const contentHeight = Math.max(1, pageHeight - margin * 2);
    const scale = Math.min(contentWidth / naturalWidth, contentHeight / naturalHeight);
    const drawWidth = naturalWidth * scale;
    const drawHeight = naturalHeight * scale;
    const x = (pageWidth - drawWidth) / 2;
    const y = (pageHeight - drawHeight) / 2;

    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    page.drawImage(image, {
      x,
      y,
      width: drawWidth,
      height: drawHeight,
    });
  }

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, pdfBytes);
  return outputPath;
}

module.exports = { imagesToPDF };

