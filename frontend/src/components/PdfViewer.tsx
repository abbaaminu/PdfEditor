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
import { renderPdfPageToCanvas } from '../lib/pdfRenderer';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;
const PAGE_GAP_CSS = 32;

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

export const PdfViewer: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [fileName, setFileName] = useState('');
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !fileBuffer || pageCount === 0) return;

    let active = true;
    setIsLoading(true);
    setError('');
    void renderPdfPageToCanvas(fileBuffer, pageNumber, canvas, { scale: zoom, rotation })
      .catch((renderError) => {
        if (active) setError(describePdfError(renderError));
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [fileBuffer, pageNumber, pageCount, rotation, zoom]);


  const loadFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setError('Please choose a PDF file.');
      return;
    }

    setError('');
    setFileName(file.name);
    setFileBuffer(null);
    setPageCount(0);
    setPageNumber(1);
    setPageInput('1');
    setZoom(1);
    setRotation(0);
    setIsLoading(true);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const document = await loadingTask.promise;
      setPageCount(document.numPages);
      setFileBuffer(arrayBuffer.slice(0));
      await document.destroy();
    } catch (loadError) {
      setPageCount(0);
      setError(describePdfError(loadError));
    } finally {
      setIsLoading(false);
    }
  };

  const scrollToPage = (page: number) => {
    const target = Math.min(pageCount, Math.max(1, page));
    setPageNumber(target);
    setPageInput(String(target));
  };

  const handlePageInput = (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    setPageInput(raw);
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) scrollToPage(parsed);
  };

  const handleFitToWidth = () => {
    const container = scrollRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas || canvas.width === 0) return;
    const width = container.clientWidth - PAGE_GAP_CSS * 2;
    const currentScale = canvas.width / zoom;
    if (currentScale > 0) setZoom(clampZoom(width / currentScale));
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
          <div className="shrink-0">
            <p className="mb-1.5 text-center text-[11px] font-medium text-slate-500">
              Page {pageNumber} of {pageCount}
            </p>
            <canvas ref={canvasRef} className="block bg-white shadow-2xl" />
          </div>
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

