import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

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

  const loadingTask = pdfjsLib.getDocument({ data: pdfBuffer });
  const pdfDocument = await loadingTask.promise;

  const page = await pdfDocument.getPage(pageNumber);
  const viewport = page.getViewport({ scale, rotation });

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas 2D context not available');
  }

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({
    canvasContext: context,
    viewport,
  }).promise;
}

/**
 * Converts all pages of a PDF File into PNG Data URLs (base64) for thumbnailing or exporting.
 */
export async function convertPdfToImages(
  file: File,
  scale = 1.5,
  onProgress?: (current: number, total: number) => void
): Promise<string[]> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdfDocument = await loadingTask.promise;

  const imageUrls: string[] = [];
  const totalPages = pdfDocument.numPages;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const page = await pdfDocument.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    if (context) {
      await page.render({
        canvasContext: context,
        viewport,
      }).promise;

      imageUrls.push(canvas.toDataURL('image/png'));
    }

    if (onProgress) {
      onProgress(pageNum, totalPages);
    }
  }

  return imageUrls;
}

/** Rasterizes each source page and rebuilds a smaller PDF from JPEG images. */
export async function compressPdfToPdf(
  file: File,
  scale = 0.85,
  quality = 0.55,
  onProgress?: (current: number, total: number) => void
): Promise<Uint8Array> {
  const loadingTask = pdfjsLib.getDocument({ data: await file.arrayBuffer() });
  const pdfDocument = await loadingTask.promise;
  const output = await PDFDocument.create();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context not available');

  try {
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      context.clearRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;

      const jpegBytes = dataUrlToBytes(canvas.toDataURL('image/jpeg', quality));
      const image = await output.embedJpg(jpegBytes);
      const pageWidth = 595.28;
      const pageHeight = 841.89;
      const fit = Math.min(pageWidth / image.width, pageHeight / image.height);
      const width = image.width * fit;
      const height = image.height * fit;
      const outputPage = output.addPage([pageWidth, pageHeight]);
      outputPage.drawImage(image, {
        x: (pageWidth - width) / 2,
        y: (pageHeight - height) / 2,
        width,
        height,
      });
      onProgress?.(pageNumber, pdfDocument.numPages);
    }
    return output.save({ useObjectStreams: true });
  } finally {
    await pdfDocument.destroy();
  }
}