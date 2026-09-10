// frontend/src/lib/pdfjs.ts
// Single source of truth for the pdf.js runtime.
//
// Every module that loads PDFs must import from here instead of configuring
// `GlobalWorkerOptions.workerSrc` itself. This keeps one worker assignment at
// module startup and guarantees no network/CDN dependency:
//
//   * `pdf.worker.min.js?url` is bundled by Vite as a local static asset, so
//     the worker resolves to an in-app URL (dev server or `dist/`).
//   * pdfjs-dist@3.11.x ships only classic (UMD) worker builds — there is no
//     `pdf.worker.min.mjs` in this version, which is why the previous CDN
//     `.mjs` URL failed with a worker-loading error.
//   * The `cmaps/` + `standard_fonts/` folders are staged into
//     `public/pdfjs-assets/` by `vite.config.ts` and referenced relatively.

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Local mirror of `pdfjs-dist/cmaps`, staged by the Vite build. */
export const PDFJS_CMAP_URL = './pdfjs-assets/cmaps/';

/** Local mirror of `pdfjs-dist/standard_fonts`, staged by the Vite build. */
export const PDFJS_STANDARD_FONTS_URL = './pdfjs-assets/standard_fonts/';

/** Shared document options: offline-safe cMaps + fonts, no `eval`. */
export const PDFJS_DOCUMENT_OPTIONS = {
  isEvalSupported: false,
  cMapUrl: PDFJS_CMAP_URL,
  cMapPacked: true,
  standardFontDataUrl: PDFJS_STANDARD_FONTS_URL,
} as const;

/**
 * Opens a PDF from raw bytes with the shared, fully local runtime options.
 *
 * The bytes are copied before being handed to pdf.js because the worker
 * transfers (detaches) the underlying buffer.
 */
export function loadPdfDocument(
  source: ArrayBuffer | Uint8Array,
  extra: Record<string, unknown> = {}
): pdfjsLib.PDFDocumentLoadingTask {
  const data = source instanceof Uint8Array ? source.slice() : source.slice(0);
  return pdfjsLib.getDocument({ ...PDFJS_DOCUMENT_OPTIONS, ...extra, data });
}

export { pdfjsLib };
