import { PDFDocument } from 'pdf-lib';
import { loadPdfDocument } from './pdfjs';

/**
 * pdf-lib's standard fonts use WinAnsi encoding, which cannot represent
 * ligatures, smart quotes, em/en dashes or emoji. Any unencodable glyph makes
 * `drawText()` throw and aborts the whole export, so every string must pass
 * through this sanitizer before it is drawn.
 */
export function sanitizeWinAnsiText(value: string): string {
  return (
    value
      // Ligatures
      .replace(/\ufb00/g, 'ff')
      .replace(/\ufb01/g, 'fi')
      .replace(/\ufb02/g, 'fl')
      .replace(/\ufb03/g, 'ffi')
      .replace(/\ufb04/g, 'ffl')
      .replace(/[\ufb05\ufb06]/g, 'st')
      // Smart quotes, apostrophes and primes
      .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
      .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
      .replace(/[\u2032\u02b9]/g, "'")
      .replace(/[\u2033\u02ba]/g, '"')
      // Dashes, ellipsis, bullets and special spaces
      .replace(/[\u2013\u2014\u2015]/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/[\u2022\u25cf\u25e6\u25aa]/g, '-')
      .replace(/[\u00a0\u2007\u202f\u2009]/g, ' ')
      // Soft hyphen, zero-width joiners/spaces and BOM: dropped outright.
      // eslint-disable-next-line no-misleading-character-class -- individual code points, not emoji sequences
      .replace(/[\u00ad\u200b\u200c\u200d\u2060\ufeff]/g, '')
      // Anything left outside the WinAnsi byte range (emoji, CJK, symbols).
      // eslint-disable-next-line no-control-regex -- WinAnsi is a single-byte range starting at 0x00
      .replace(/[^\x00-\xFF]/g, '')
  );
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export interface RenderPageOptions {
  scale?: number;
  rotation?: number;
}

/**
 * Loads a PDF file and renders a specific page onto an HTML5 Canvas.
 */
export async function renderPdfPageToCanvas(
  pdfBuffer: ArrayBuffer,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  options: RenderPageOptions = {}
): Promise<void> {
  const { scale = 1.5, rotation = 0 } = options;

  const loadingTask = loadPdfDocument(pdfBuffer);

  try {
    const pdfDocument = await loadingTask.promise;

    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale, rotation });

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas 2D context not available');
    }

    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    await page.render({
      canvasContext: context,
      viewport,
    }).promise;
    page.cleanup();
  } finally {
    // Without this, every zoom/rotate pass leaks a document + worker pair.
    await loadingTask.destroy();
  }
}

/**
 * Converts all pages of a PDF File into PNG Data URLs (base64) for thumbnailing or exporting.
 */
export async function convertPdfToImages(
  file: File,
  scale = 1.5,
  onProgress?: (current: number, total: number) => void
): Promise<string[]> {
  const loadingTask = loadPdfDocument(await file.arrayBuffer());

  try {
    const pdfDocument = await loadingTask.promise;
    const imageUrls: string[] = [];
    const totalPages = pdfDocument.numPages;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context not available');

    for (let pageNum = 1; pageNum <= totalPages; pageNum += 1) {
      const page = await pdfDocument.getPage(pageNum);
      const viewport = page.getViewport({ scale });

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      await page.render({ canvasContext: context, viewport }).promise;
      page.cleanup();
      imageUrls.push(canvas.toDataURL('image/png'));
      onProgress?.(pageNum, totalPages);
    }

    return imageUrls;
  } finally {
    await loadingTask.destroy();
  }
}

/** Compression presets shared with the PDF Tools UI. */
export type CompressionPresetKey = 'printer' | 'ebook' | 'screen';

export interface CompressPdfOptions {
  /** Raster scale for the page canvas (0.85 – 1.0 keeps text legible). */
  scale?: number;
  /** JPEG quality in the 0–1 range (the UI sends its 10–90% slider / 100). */
  quality?: number;
  /** Preset name from the UI; picks a scale when `scale` is not supplied. */
  preset?: CompressionPresetKey;
  onProgress?: (current: number, total: number) => void;
}

/** Raster scale per preset — smaller scale means a smaller output file. */
const PRESET_SCALE: Record<CompressionPresetKey, number> = {
  printer: 1,
  ebook: 0.95,
  screen: 0.85,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Actively re-encodes a PDF: every page is rasterised to a canvas and the
 * document is rebuilt in pdf-lib from JPEG frames (instead of a passive
 * `pdfDoc.save()` pass-through, which could never shrink the file).
 *
 * Original page dimensions are preserved; `scale` only controls how much
 * raster detail survives, and the JPEG quality drives the byte size.
 */
export async function compressPdfToPdf(
  file: File,
  options: CompressPdfOptions = {}
): Promise<Uint8Array> {
  const { preset = 'ebook', onProgress } = options;
  const scale = clamp(options.scale ?? PRESET_SCALE[preset], 0.5, 2);
  const quality = clamp(options.quality ?? 0.55, 0.05, 0.95);

  const loadingTask = loadPdfDocument(await file.arrayBuffer());
  const pdfDocument = await loadingTask.promise;
  const output = await PDFDocument.create();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas 2D context not available');

  try {
    const total = pdfDocument.numPages;
    for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      // The PDF page keeps its own size; the raster is only downsampled.
      const baseViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale });

      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      // JPEG has no alpha channel: paint white first, otherwise transparent
      // regions turn black in the compressed output.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      page.cleanup();

      const jpegBytes = dataUrlToBytes(canvas.toDataURL('image/jpeg', quality));
      const image = await output.embedJpg(jpegBytes);
      const outputPage = output.addPage([baseViewport.width, baseViewport.height]);
      outputPage.drawImage(image, {
        x: 0,
        y: 0,
        width: baseViewport.width,
        height: baseViewport.height,
      });
      onProgress?.(pageNumber, total);
    }
    return await output.save({ useObjectStreams: true });
  } finally {
    await pdfDocument.destroy();
    canvas.width = 0;
    canvas.height = 0;
  }
}
