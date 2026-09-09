// frontend/src/components/PdfViewer.tsx
// Continuous vertical-scroll PDF reader.
//
// Every page is rendered onto its own high-DPI canvas and stacked vertically
// inside a scroll container. Toolbar zoom/rotation changes re-render all
// pages, an IntersectionObserver keeps the "Page X of Y" indicator in sync,
// and the page-number input smooth-scrolls to the requested page.

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileText,
  FolderOpen,
  LoaderCircle,
  Maximize2,
  Minus,
  Plus,
  RotateCw,
  Upload,
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
// Standard Vite URL resolver for the pinned pdfjs-dist worker bundle (3.11.174).
// (Typed by src/pdf-worker.d.ts.)
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfDocument = pdfjsLib.PDFDocumentProxy;
type PdfLoadingTask = pdfjsLib.PDFDocumentLoadingTask;
type PdfPage = pdfjsLib.PDFPageProxy;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;
const PAGE_GAP_CSS = 32; // matches the gap-8 between page cards

/** Document options shared by every load. */
function documentOptions(data: Uint8Array, disableWorker = false) {
  return {
    data,
    disableWorker,
    isEvalSupported: false,
    cMapUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/standard_fonts/',
  };
}

function describePdfError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/password|encrypted/i.test(message)) {
    return 'This PDF is password-protected. Remove its password and try again.';
  }
  if (/InvalidPDFException|invalid pdf|corrupt|parsing/i.test(message)) {
    return 'This file could not be opened. It may be corrupted or not a valid PDF.';
  }
  return message || 'The PDF could not be opened.';
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

function isWorkerSetupError(error: unknown): boolean {
  return /worker|fake worker|postmessage|protocol/i.test(
    error instanceof Error ? error.message : String(error)
  );
}

export const PdfViewer: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pageElRefs = useRef<Array<HTMLDivElement | null>>([]);
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const textLayerRefs = useRef<Array<HTMLDivElement | null>>([]);
  const pageProxiesRef = useRef<Array<PdfPage | null>>([]);
  const renderTasksRef = useRef<Map<number, ReturnType<PdfPage['render']>>>(new Map());
  const loadingTaskRef = useRef<PdfLoadingTask | null>(null);
  const documentRef = useRef<PdfDocument | null>(null);
  const renderVersionRef = useRef(0);

  const [fileName, setFileName] = useState('');
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  /** Cancel every in-flight page render without disturbing later ones. */
  const cancelAllRenders = () => {
    renderTasksRef.current.forEach((task) => task.cancel());
    renderTasksRef.current.clear();
  };

  /** Render one page at the current zoom/rotation on its dedicated canvas. */
  const renderPageToCanvas = async (
    page: PdfPage,
    canvas: HTMLCanvasElement,
    cssZoom: number
  ) => {
    const version = renderVersionRef.current;
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: cssZoom * dpr, rotation });

    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    // CSS size keeps the element at `cssZoom` physical-independent px so the
    // browser scales the high-DPI bitmap down crisply.
    canvas.style.width = `${Math.ceil(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.ceil(viewport.height / dpr)}px`;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable in this environment.');

    const task = page.render({ canvasContext: context, viewport });
    renderTasksRef.current.set(page.pageNumber - 1, task);
    try {
      await task.promise;
      if (version !== renderVersionRef.current) return;
    } catch (renderError) {
      // Superseded by a newer render/load or an intentional cancel.
      if (version !== renderVersionRef.current) return;
      if (
        !(renderError instanceof Error && renderError.name === 'RenderingCancelledException')
      ) {
        throw renderError;
      }
    } finally {
      if (renderTasksRef.current.get(page.pageNumber - 1) === task) {
        renderTasksRef.current.delete(page.pageNumber - 1);
      }
    }
  };

  /** Render the selectable text layer that sits directly above a page canvas. */
  const renderTextLayerForPage = async (page: PdfPage, index: number, cssZoom: number) => {
    const layer = textLayerRefs.current[index];
    if (!layer) return;
    const textViewport = page.getViewport({ scale: cssZoom, rotation });
    layer.style.width = `${textViewport.width}px`;
    layer.style.height = `${textViewport.height}px`;
    layer.innerHTML = '';

    const textContent = await page.getTextContent();
    const task = pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: layer,
      viewport: textViewport,
      textDivs: [],
    }) as { promise?: Promise<void> } | undefined;
    if (task?.promise) {
      await task.promise.catch(() => undefined);
    }
  };

  /** Render every visible page sequentially (crisp, high-DPI). */
  const renderAllPages = async (cssZoom = zoom) => {
    const doc = documentRef.current;
    if (!doc) return;
    const version = ++renderVersionRef.current;
    cancelAllRenders();

    for (let index = 0; index < pageCount; index += 1) {
      if (version !== renderVersionRef.current) return;
      const page = pageProxiesRef.current[index];
      const canvas = canvasRefs.current[index];
      if (!page || !canvas) continue;
      try {
        await renderPageToCanvas(page, canvas, cssZoom);
        if (version !== renderVersionRef.current) return;
        await renderTextLayerForPage(page, index, cssZoom);
      } catch (err) {
        if (version === renderVersionRef.current) {
          setError(describePdfError(err));
          return;
        }
      }
    }
  };

  // Re-render all pages whenever zoom/rotation/document state settles.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void renderAllPages();
    });
    return () => window.cancelAnimationFrame(frame);
    // renderAllPages is intentionally excluded; it re-reads latest state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount, fileName, zoom, rotation]);

  /** Keep "Page X of Y" in sync with the page nearest the scroll viewport. */
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || pageCount === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        let best: IntersectionObserverEntry | null = null;
        for (const entry of entries) {
          if (!best || entry.intersectionRatio > best.intersectionRatio) best = entry;
        }
        if (best && best.isIntersecting) {
          const found = pageElRefs.current.findIndex((el) => el === best.target);
          if (found >= 0) {
            setPageNumber(found + 1);
            setPageInput(String(found + 1));
          }
        }
      },
      { root: container, threshold: [0.15, 0.4, 0.65, 0.9] }
    );

    for (let index = 0; index < pageCount; index += 1) {
      const el = pageElRefs.current[index];
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [pageCount, fileName]);


  const loadFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setError('Please choose a PDF file.');
      return;
    }

    cancelAllRenders();
    renderVersionRef.current += 1;
    const previousTask = loadingTaskRef.current;
    loadingTaskRef.current = null;
    documentRef.current = null;
    pageProxiesRef.current = [];
    if (previousTask) void previousTask.destroy().catch(() => undefined);

    setError('');
    setFileName(file.name);
    setPageCount(0);
    setPageNumber(1);
    setPageInput('1');
    setZoom(1);
    setRotation(0);
    setIsLoading(true);

    let loadingTask: PdfLoadingTask | null = null;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const fileBytes = new Uint8Array(arrayBuffer).slice();
      loadingTask = pdfjsLib.getDocument(documentOptions(fileBytes));
      loadingTaskRef.current = loadingTask;
      loadingTask.onPassword = (callback: (password: string) => void) => {
        setError('This PDF is password-protected. Password entry is not supported here.');
        callback('');
      };

      let document: PdfDocument;
      try {
        document = await loadingTask.promise;
      } catch (loadError) {
        if (!isWorkerSetupError(loadError)) throw loadError;
        await loadingTask.destroy().catch(() => undefined);
        loadingTask = pdfjsLib.getDocument(documentOptions(fileBytes, true));
        loadingTaskRef.current = loadingTask;
        loadingTask.onPassword = (callback: (password: string) => void) => {
          setError('This PDF is password-protected. Password entry is not supported here.');
          callback('');
        };
        document = await loadingTask.promise;
      }
      if (previousTask && loadingTaskRef.current !== loadingTask) return;
      documentRef.current = document;
      pageProxiesRef.current = await Promise.all(
        Array.from({ length: document.numPages }, (_, index) => document.getPage(index + 1))
      );
      setPageCount(document.numPages);
    } catch (loadError) {
      if (loadingTask) {
        void loadingTask.destroy().catch(() => undefined);
        if (loadingTaskRef.current === loadingTask) loadingTaskRef.current = null;
      }
      documentRef.current = null;
      setPageCount(0);
      setError(describePdfError(loadError));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    return () => {
      cancelAllRenders();
      const task = loadingTaskRef.current;
      if (task) void task.destroy().catch(() => undefined);
    };
  }, []);

  const scrollToPage = (page: number) => {
    const target = Math.min(pageCount, Math.max(1, page));
    setPageNumber(target);
    setPageInput(String(target));
    const element = pageElRefs.current[target - 1];
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handlePageInput = (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    setPageInput(raw);
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) scrollToPage(parsed);
  };

  const handleFitToWidth = () => {
    const container = scrollRef.current;
    const firstPage = pageProxiesRef.current[0];
    if (!container || !firstPage) return;
    const width = container.clientWidth - PAGE_GAP_CSS * 2;
    const viewport = firstPage.getViewport({ scale: 1, rotation });
    if (viewport.width > 0) setZoom(clampZoom(width / viewport.width));
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void loadFile(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void loadFile(file);
  };

  const hasDocument = pageCount > 0;


  return (
    <div className="space-y-4">
      {hasDocument && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-200">
          <button
            type="button"
            aria-label="Previous page"
            disabled={pageNumber <= 1}
            onClick={() => scrollToPage(pageNumber - 1)}
            className="rounded p-1 text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <label className="flex items-center gap-1.5 text-slate-400">
            Page
            <input
              aria-label="Page number"
              type="number"
              min={1}
              max={pageCount}
              value={pageInput}
              onChange={handlePageInput}
              className="w-16 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-center text-slate-100"
            />
            <span>of {pageCount}</span>
          </label>
          <button
            type="button"
            aria-label="Next page"
            disabled={pageNumber >= pageCount}
            onClick={() => scrollToPage(pageNumber + 1)}
            className="rounded p-1 text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          <span className="mx-1 hidden h-5 w-px bg-slate-700 sm:block" aria-hidden="true" />

          <button
            type="button"
            title="Zoom out"
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((value) => clampZoom(value - ZOOM_STEP))}
            className="rounded p-1 text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-40"
          >
            <Minus className="h-4 w-4" />
          </button>
          <span className="w-12 text-center text-slate-400">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            title="Zoom in"
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((value) => clampZoom(value + ZOOM_STEP))}
            className="rounded p-1 text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Fit to width"
            aria-label="Fit to width"
            onClick={handleFitToWidth}
            className="rounded p-1 text-slate-300 transition hover:bg-slate-800 hover:text-white"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Reset to 100%"
            onClick={() => setZoom(1)}
            className="rounded px-2 py-1 text-slate-400 transition hover:bg-slate-800 hover:text-white"
          >
            100%
          </button>
          <button
            type="button"
            title="Rotate clockwise"
            aria-label="Rotate clockwise"
            onClick={() => setRotation((value) => (value + 90) % 360)}
            className="rounded p-1 text-slate-300 transition hover:bg-slate-800 hover:text-white"
          >
            <RotateCw className="h-4 w-4" />
          </button>

          <span
            className="ml-auto hidden min-w-0 max-w-48 truncate text-slate-500 md:inline"
            title={fileName}
          >
            {fileName}
          </span>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-300">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div
        ref={scrollRef}
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`relative flex h-[72vh] flex-col items-center gap-8 overflow-y-auto rounded-xl border bg-slate-900 p-6 transition ${
          isDragging ? 'border-indigo-400 bg-indigo-950/30' : 'border-slate-800'
        }`}
      >

        {isLoading ? (
          <div className="flex items-center gap-2 py-20 text-sm text-slate-400">
            <LoaderCircle className="h-5 w-5 animate-spin text-indigo-400" /> Loading PDF…
          </div>
        ) : hasDocument ? (
          Array.from({ length: pageCount }, (_, index) => (
            <div
              key={`${fileName}-${index}`}
              ref={(el) => {
                pageElRefs.current[index] = el;
              }}
              data-page-index={index}
              className="shrink-0"
            >
              <p className="mb-1.5 text-center text-[11px] font-medium text-slate-500">
                Page {index + 1} of {pageCount}
              </p>
              <div className="relative">
                <canvas
                  ref={(el) => {
                    canvasRefs.current[index] = el;
                  }}
                  className="block bg-white shadow-2xl"
                />
                <div
                  ref={(el) => {
                    textLayerRefs.current[index] = el;
                  }}
                  className="textLayer"
                  aria-hidden="false"
                />
              </div>
            </div>
          ))
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 text-center">
            <Upload className="h-10 w-10 text-indigo-400/80" />
            <p className="text-sm text-slate-400">Drop a PDF here or open one to begin reading.</p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 rounded-lg border border-indigo-500/50 px-4 py-2 text-xs font-semibold text-indigo-300 transition hover:bg-indigo-500/10"
            >
              <FolderOpen className="h-4 w-4" /> Choose a PDF
            </button>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        onChange={handleFileInput}
      />

      <p className="flex items-center gap-2 text-xs text-slate-500">
        <FileText className="h-3.5 w-3.5 text-indigo-400" />
        Scroll through every page — zoom and rotation apply to all pages at once.
      </p>
    </div>
  );
};

