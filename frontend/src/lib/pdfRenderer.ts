import * as pdfjsLib from 'pdfjs-dist';

// Configure pdfjs-dist web worker for Vite builds
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString();

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