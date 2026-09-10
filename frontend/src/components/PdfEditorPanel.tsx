// frontend/src/components/PdfEditorPanel.tsx
// Client-side Direct PDF Editor.
//
// Renders each page with pdf.js onto a canvas, layers user annotations
// (freehand pen, highlighting, click-to-place text, text/image watermarks)
// above it, and re-exports a new PDF with pdf-lib that applies page
// reordering/deletion/rotation plus the drawn vector overlays.

import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Download,
  Highlighter,
  MousePointer2,
  PenLine,
  RotateCw,
  Trash2,
  Type,
  Undo2,
  Upload,
} from 'lucide-react';
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { useToast } from './toast-context';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

interface PdfEditorPanelProps {
  /** Trial gate: true when the user may start exporting an edited PDF. */
  canStartAction: () => boolean;
  /** Records a free-trial use once an edited PDF is exported. */
  incrementUsage: () => void;
}

type ToolMode = 'select' | 'pen' | 'highlight' | 'text' | 'watermark';

interface Point {
  x: number;
  y: number;
}

interface StrokeOverlay {
  kind: 'pen' | 'highlight';
  points: Point[];
  color: string;
  size: number;
}

interface TextOverlay {
  kind: 'text';
  x: number;
  y: number;
  text: string;
  size: number;
  color: string;
}

type PageOverlay = StrokeOverlay | TextOverlay;

interface PageModel {
  /** Original page index inside the loaded PDF. */
  sourceIndex: number;
  rotation: 0 | 90 | 180 | 270;
  overlays: PageOverlay[];
}

type RgbTuple = { r: number; g: number; b: number };

/** "#rrggbb" -> pdf-lib rgb(). */
function hexToRgb(hex: string): RgbTuple {
  const value = hex.replace('#', '');
  const parsed = Number.parseInt(value, 16);
  return {
    r: ((parsed >> 16) & 255) / 255,
    g: ((parsed >> 8) & 255) / 255,
    b: (parsed & 255) / 255,
  };
}

function downloadPdf(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const nextRotation = (rotation: PageModel['rotation']): PageModel['rotation'] =>
  ((rotation + 90) % 360) as PageModel['rotation'];

/**
 * Rebuild the PDF with the requested page order/deletion/rotation and draw all
 * overlays into the copied pages as vector content.
 */
async function buildEditedPdf(
  sourceBytes: ArrayBuffer,
  pages: PageModel[],
  watermarkText: string,
  watermarkEnabled: boolean,
  stamp: { bytes: ArrayBuffer; kind: 'png' | 'jpg' } | null
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const src = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
  const font = await out.embedFont(StandardFonts.Helvetica);
  let stampImage: Awaited<ReturnType<typeof out.embedPng>> | null = null;

  for (const pageModel of pages) {
    const sourcePage = await src.getPage(pageModel.sourceIndex);
    const { width, height } = sourcePage.getSize();
    const [page] = await out.copyPages(src, [pageModel.sourceIndex]);
    if (pageModel.rotation !== 0) page.setRotation(degrees(pageModel.rotation));

    const drawAt = (overlayX: number, overlayY: number) => ({
      x: overlayX,
      y: height - overlayY,
    });

    for (const overlay of pageModel.overlays) {
      if (overlay.kind === 'text') {
        const { r, g, b } = hexToRgb(overlay.color);
        page.drawText(overlay.text, {
          ...drawAt(overlay.x, overlay.y),
          size: overlay.size,
          font,
          color: rgb(r, g, b),
        });
      } else if (overlay.kind === 'pen') {
        const { r, g, b } = hexToRgb(overlay.color);
        for (let i = 1; i < overlay.points.length; i += 1) {
          page.drawLine({
            start: drawAt(overlay.points[i - 1].x, overlay.points[i - 1].y),
            end: drawAt(overlay.points[i].x, overlay.points[i].y),
            thickness: overlay.size,
            color: rgb(r, g, b),
          });
        }
      } else {
        // Highlight: thick translucent line that mimics a marker stroke.
        const { r, g, b } = hexToRgb(overlay.color);
        for (let i = 1; i < overlay.points.length; i += 1) {
          page.drawLine({
            start: drawAt(overlay.points[i - 1].x, overlay.points[i - 1].y),
            end: drawAt(overlay.points[i].x, overlay.points[i].y),
            thickness: overlay.size,
            color: rgb(r, g, b),
            opacity: 0.35,
          });
        }
      }
    }

    if (watermarkEnabled && watermarkText.trim()) {
      const size = Math.max(18, width / 12);
      const textWidth = font.widthOfTextAtSize(watermarkText, size);
      page.drawText(watermarkText, {
        x: (width - textWidth) / 2,
        y: height / 2,
        size,
        font,
        color: rgb(0.4, 0.4, 0.4),
        opacity: 0.14,
        rotate: degrees(-30),
      });
    }

    if (stamp) {
      if (!stampImage) {
        stampImage =
          stamp.kind === 'png'
            ? await out.embedPng(stamp.bytes)
            : await out.embedJpg(stamp.bytes);
      }
      const stampSize = Math.min(width, height) * 0.25;
      page.drawImage(stampImage, {
        x: (width - stampSize) / 2,
        y: (height - stampSize) / 2,
        width: stampSize,
        height: stampSize,
        opacity: 0.3,
      });
    }

    out.addPage(page);
  }

  return out.save();
}

export const PdfEditorPanel: React.FC<PdfEditorPanelProps> = ({
  canStartAction,
  incrementUsage,
}) => {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const stampInputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const pageCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null);

  const [sourceBytes, setSourceBytes] = useState<ArrayBuffer | null>(null);

  const [fileName, setFileName] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  const [pages, setPages] = useState<PageModel[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);

  const [mode, setMode] = useState<ToolMode>('select');
  const [penColor, setPenColor] = useState('#f59e0b');
  const [brushSize, setBrushSize] = useState(2.5);
  const [highlightColor, setHighlightColor] = useState('#fde047');
  const [textColor, setTextColor] = useState('#1f2937');
  const [textContent, setTextContent] = useState('New note');
  const [textSize, setTextSize] = useState(18);
  const [watermarkEnabled, setWatermarkEnabled] = useState(false);
  const [watermarkText, setWatermarkText] = useState('CONFIDENTIAL');
  const [stamp, setStamp] = useState<{ bytes: ArrayBuffer; kind: 'png' | 'jpg' } | null>(null);

  const current = pages[currentIndex] ?? null;
  const draftRef = useRef<StrokeOverlay | null>(null);

  /** Draw the pdf.js-rendered base page onto its canvas. */
  const drawBasePage = async (pageModel: PageModel, scale = 1) => {
    const doc = docRef.current;
    const canvas = pageCanvasRef.current;
    if (!doc || !canvas) return;
    const page = await doc.getPage(pageModel.sourceIndex);
    const viewport = page.getViewport({ scale, rotation: pageModel.rotation });
    const dpr = window.devicePixelRatio || 1;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable.');

    canvas.width = Math.ceil(viewport.width * dpr);
    canvas.height = Math.ceil(viewport.height * dpr);
    canvas.style.width = `${Math.ceil(viewport.width)}px`;
    canvas.style.height = `${Math.ceil(viewport.height)}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, viewport.width, viewport.height);
    await page.render({ canvasContext: context, viewport }).promise;
  };

  /** Redraw only the annotation layer (used while dragging). */
  const drawOverlays = (overlays: PageOverlay[], extra: StrokeOverlay | null) => {
    const overlay = overlayCanvasRef.current;
    const base = pageCanvasRef.current;
    if (!overlay || !base) return;
    const dpr = window.devicePixelRatio || 1;
    const context = overlay.getContext('2d');
    if (!context) return;
    overlay.width = base.width;
    overlay.height = base.height;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, overlay.width / dpr, overlay.height / dpr);

    const paint = (item: PageOverlay) => {
      if (item.kind === 'text') {
        context.font = `${item.size}px system-ui, sans-serif`;
        context.fillStyle = item.color;
        context.textBaseline = 'top';
        context.fillText(item.text, item.x, item.y);
      } else {
        context.strokeStyle = item.color;
        context.lineWidth = item.size;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.globalCompositeOperation = item.kind === 'highlight' ? 'multiply' : 'source-over';
        context.globalAlpha = item.kind === 'highlight' ? 0.4 : 1;
        context.beginPath();
        item.points.forEach((point, index) => {
          if (index === 0) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        });
        context.stroke();
        context.globalAlpha = 1;
        context.globalCompositeOperation = 'source-over';
      }
    };

    for (const item of overlays) paint(item);
    if (extra) paint(extra);
  };

  const redrawPage = async () => {
    const pageModel = pages[currentIndex];
    if (!pageModel || !docRef.current) return;
    try {
      await drawBasePage(pageModel);
      drawOverlays(pageModel.overlays, draftRef.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to render the page.');
    }
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void redrawPage();
    });
    return () => window.cancelAnimationFrame(frame);
    // redrawPage is intentionally excluded: it is recreated each render and
    // reads the latest state via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, currentIndex, fileName, isOpen]);


  const loadFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setError('Please choose a PDF file.');
      return;
    }
    const previousTask = loadingTaskRef.current;
    loadingTaskRef.current = null;
    if (previousTask) void previousTask.destroy().catch(() => undefined);
    docRef.current = null;
    setError('');
    setLoading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()).slice();
      setSourceBytes(bytes.buffer);
      const task = pdfjsLib.getDocument({
        data: bytes.slice(),
        isEvalSupported: false,
        cMapUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/standard_fonts/',
      });
      task.onPassword = () => {
        setError('This PDF is password-protected. Password entry is not supported here.');
      };
      loadingTaskRef.current = task;
      const document = await task.promise;
      docRef.current = document;
      setFileName(file.name);
      setPages(
        Array.from({ length: document.numPages }, (_, index) => ({
          sourceIndex: index,
          rotation: 0 as const,
          overlays: [] as PageOverlay[],
        }))
      );
      setCurrentIndex(0);
      setIsOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The PDF could not be opened.');
      setIsOpen(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const task = loadingTaskRef.current;
    return () => {
      if (task) void task.destroy().catch(() => undefined);
    };
  }, []);

  const getPoint = (event: React.PointerEvent): Point => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const commitOverlay = (overlay: PageOverlay) => {
    setPages((previous) =>
      previous.map((page, index) =>
        index === currentIndex ? { ...page, overlays: [...page.overlays, overlay] } : page
      )
    );
  };

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!current || current.rotation !== 0 || mode === 'select') return;
    event.preventDefault();
    const point = getPoint(event);
    if (mode === 'text') {
      const text = textContent.trim();
      if (!text) return;
      commitOverlay({
        kind: 'text',
        x: point.x,
        y: point.y,
        text,
        size: textSize,
        color: textColor,
      });
      setTextContent('');
      return;
    }
    const stroke: StrokeOverlay = {
      kind: mode === 'highlight' ? 'highlight' : 'pen',
      points: [point],
      color: mode === 'highlight' ? highlightColor : penColor,
      size: mode === 'highlight' ? brushSize * 4 : brushSize,
    };
    draftRef.current = stroke;
    drawOverlays(current?.overlays ?? [], stroke);
    (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const draft = draftRef.current;
    if (!draft || !current || current.rotation !== 0) return;
    event.preventDefault();
    draft.points = [...draft.points, getPoint(event)];
    drawOverlays(current?.overlays ?? [], draft);
  };

  const handlePointerUp = () => {
    const draft = draftRef.current;
    if (!draft) return;
    draftRef.current = null;
    const points =
      draft.points.length === 1 ? [draft.points[0], draft.points[0]] : draft.points;
    commitOverlay({ ...draft, points });
  };

  const undoLast = () => {
    if (!current || current.overlays.length === 0) return;
    setPages((previous) =>
      previous.map((page, index) =>
        index === currentIndex
          ? { ...page, overlays: page.overlays.slice(0, -1) }
          : page
      )
    );
  };

  const rotatePage = (index: number) => {
    const target = pages[index];
    if (!target) return;
    if (target.overlays.length > 0) {
      toast.error('Clear this page’s annotations before rotating it.');
      return;
    }
    setPages((previous) =>
      previous.map((page, pageIndex) =>
        pageIndex === index ? { ...page, rotation: nextRotation(page.rotation) } : page
      )
    );
  };

  const deletePage = (index: number) => {
    if (!pages[index]) return;
    setPages((previous) => previous.filter((_, pageIndex) => pageIndex !== index));
    setCurrentIndex((value) =>
      Math.max(0, Math.min(pages.length - 2, value))
    );
  };

  const movePage = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= pages.length) return;
    setPages((previous) => {
      const next = [...previous];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
    setCurrentIndex(target);
  };

  const exportEdited = async () => {
    if (!sourceBytes || pages.length === 0 || exporting) return;
    if (!canStartAction()) return;
    setExporting(true);
    try {
      const bytes = await buildEditedPdf(
        sourceBytes,
        pages,
        watermarkText,
        watermarkEnabled,
        stamp
      );
      incrementUsage();
      const base = fileName.replace(/\.pdf$/i, '');
      downloadPdf(bytes, `${base || 'document'}-edited.pdf`);
      toast.success('Edited PDF exported successfully.');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to export the edited PDF.'
      );
    } finally {
      setExporting(false);
    }
  };


  if (!isOpen) {
    return (
      <div className="space-y-4">
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void loadFile(file);
            event.target.value = '';
          }}
        />
        <div
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            const file = event.dataTransfer.files?.[0];
            if (file) void loadFile(file);
          }}
          className={`rounded-2xl border-2 border-dashed p-10 text-center transition ${
            isDragging
              ? 'border-indigo-400 bg-indigo-500/10'
              : 'border-slate-700 bg-slate-900/60'
          }`}
        >
          <Upload className="mx-auto h-10 w-10 text-indigo-400/80" />
          <p className="mt-3 text-sm font-medium text-slate-200">
            Drop a PDF here to start editing
          </p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="mt-3 rounded-lg border border-indigo-500/50 px-4 py-2 text-xs font-semibold text-indigo-300 transition hover:bg-indigo-500/10"
          >
            Choose a PDF…
          </button>
        </div>
        {loading && <p className="text-center text-xs text-slate-400">Opening PDF…</p>}
        {error && (
          <p className="rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-300">
            {error}
          </p>
        )}
      </div>
    );
  }

  const toolButton = (value: ToolMode, label: string, icon: React.ReactNode) => (
    <button
      key={value}
      type="button"
      title={label}
      onClick={() => setMode(value)}
      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
        mode === value
          ? 'bg-indigo-600 text-white'
          : 'text-slate-300 hover:bg-slate-800 hover:text-white'
      }`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-2">
        <div className="flex items-center gap-1">
          {toolButton('select', 'Select', <MousePointer2 className="h-4 w-4" />)}
          {toolButton('pen', 'Pen', <PenLine className="h-4 w-4" />)}
          {toolButton('highlight', 'Highlight', <Highlighter className="h-4 w-4" />)}
          {toolButton('text', 'Text', <Type className="h-4 w-4" />)}
        </div>

        <span className="h-5 w-px bg-slate-700" aria-hidden="true" />

        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          Pen
          <input
            type="color"
            value={penColor}
            onChange={(event) => setPenColor(event.target.value)}
            className="h-7 w-8 cursor-pointer rounded border-0 bg-transparent"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          Hi
          <input
            type="color"
            value={highlightColor}
            onChange={(event) => setHighlightColor(event.target.value)}
            className="h-7 w-8 cursor-pointer rounded border-0 bg-transparent"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          Width
          <input
            type="range"
            min={1}
            max={8}
            step={0.5}
            value={brushSize}
            onChange={(event) => setBrushSize(Number(event.target.value))}
            className="w-20 accent-indigo-500"
          />
        </label>
        <button
          type="button"
          onClick={undoLast}
          disabled={!current || current.overlays.length === 0}
          title="Undo last annotation"
          className="rounded-lg p-1.5 text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-40"
        >
          <Undo2 className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={() => void exportEdited()}
          disabled={exporting || pages.length === 0}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-60"
        >
          {exporting ? (
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {exporting ? 'Exporting…' : 'Export edited PDF'}
        </button>
      </div>


      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <div className="overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-4">
          <div
            ref={wrapperRef}
            className="relative mx-auto w-fit cursor-crosshair"
            onPointerDown={(event) => handlePointerDown(event)}
            onPointerMove={(event) => handlePointerMove(event)}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            style={{ touchAction: 'none' }}
          >
            <canvas ref={pageCanvasRef} className="block bg-white shadow-2xl" />
            <canvas
              ref={overlayCanvasRef}
              className="pointer-events-none absolute inset-0"
            />
          </div>
          <p className="mt-2 text-center text-xs text-slate-500">
            Page {currentIndex + 1} of {pages.length} · {fileName}
            {current && current.rotation !== 0
              ? ' · rotated pages cannot be annotated'
              : mode !== 'select'
                ? ` · ${mode === 'text' ? 'click to place text' : 'draw with the pointer'}`
                : ''}
          </p>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Add text
            </p>
            <div className="mt-2 space-y-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={textContent}
                  onChange={(event) => setTextContent(event.target.value)}
                  placeholder="Text to place"
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <input
                  type="color"
                  value={textColor}
                  onChange={(event) => setTextColor(event.target.value)}
                  title="Text color"
                  aria-label="Text color"
                  className="h-8 w-9 cursor-pointer rounded border-0 bg-transparent"
                />
              </div>
              <input
                type="range"
                min={8}
                max={64}
                value={textSize}
                onChange={(event) => setTextSize(Number(event.target.value))}
                className="w-full accent-indigo-500"
              />
            </div>
          </div>


          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Watermark / stamp
            </p>
            <label className="mt-2 flex items-center justify-between text-xs text-slate-300">
              <span>Text watermark</span>
              <input
                type="checkbox"
                checked={watermarkEnabled}
                onChange={(event) => setWatermarkEnabled(event.target.checked)}
                className="accent-indigo-500"
              />
            </label>
            {watermarkEnabled && (
              <input
                type="text"
                value={watermarkText}
                onChange={(event) => setWatermarkText(event.target.value)}
                placeholder="CONFIDENTIAL"
                className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-100"
              />
            )}
            <button
              type="button"
              onClick={() => stampInputRef.current?.click()}
              className="mt-3 w-full rounded-lg border border-slate-700 px-2 py-1.5 text-xs text-slate-300 transition hover:border-indigo-500"
            >
              {stamp ? 'Replace image stamp' : 'Add image stamp'}
            </button>
            <input
              ref={stampInputRef}
              type="file"
              accept=".png,.jpg,.jpeg,image/png,image/jpeg"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                void file.arrayBuffer().then((bytes) =>
                  setStamp({ bytes, kind: /\.png$/i.test(file.name) ? 'png' : 'jpg' })
                );
              }}
            />
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Pages ({pages.length})
            </p>
            <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto">
              {pages.map((page, index) => (
                <li
                  key={`${page.sourceIndex}-${index}`}
                  className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs ${
                    index === currentIndex
                      ? 'bg-indigo-600/25 text-indigo-200'
                      : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <button
                    type="button"
                    className="flex-1 text-left"
                    onClick={() => setCurrentIndex(index)}
                  >
                    Page {index + 1} {page.rotation !== 0 && `· ${page.rotation}°`}
                    {page.overlays.length > 0 && ' · edited'}
                  </button>
                  <button
                    type="button"
                    title="Move up"
                    disabled={index === 0}
                    onClick={() => movePage(index, -1)}
                    className="rounded p-0.5 text-slate-400 transition hover:text-white disabled:opacity-30"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    disabled={index === pages.length - 1}
                    onClick={() => movePage(index, 1)}
                    className="rounded p-0.5 text-slate-400 transition hover:text-white disabled:opacity-30"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Rotate 90°"
                    onClick={() => rotatePage(index)}
                    className="rounded p-0.5 text-slate-400 transition hover:text-white"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Delete page"
                    onClick={() => deletePage(index)}
                    className="rounded p-0.5 text-slate-400 transition hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

