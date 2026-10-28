// frontend/src/components/PdfEditor.tsx
// Full PDF editor suite: three-column workspace (page manager / canvas /
// inspector), continuous vertical page stack with per-page text + annotation
// layers, and a pdf-lib export pipeline that applies page order/rotation and
// every overlay type (text, pen, highlight, shapes, whiteout, stamps).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Download,
  FilePlus,
  Maximize2,
  Minus,
  Plus,
  RotateCw,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { PDFImage, PDFPage } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { loadPdfDocument } from '../lib/pdfjs';
import { sanitizeWinAnsiText } from '../lib/pdfRenderer';
import { useToast } from './toast-context';

interface PdfEditorProps {
  canStartAction: () => boolean;
  incrementUsage: () => void;
  /**
   * Document to open on mount / when a new file arrives (OS file handler).
   * `null` keeps the editor on its empty "choose a PDF" state.
   */
  initialFile?: File | null;
}

type ToolMode =
  | 'select'
  | 'pen'
  | 'highlight'
  | 'text'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'eraser'
  | 'whiteout'
  | 'stamp';

interface Point {
  x: number;
  y: number;
}

/** A generic annotation bounding box in normalized PDF units (y down). */
interface Overlay {
  id: string;
  kind:
    | 'text'
    | 'pen'
    | 'highlight'
    | 'rect'
    | 'ellipse'
    | 'line'
    | 'arrow'
    | 'whiteout'
    | 'stamp';
  x: number;
  y: number;
  w: number;
  h: number;
  /** pen / highlight path in PDF units. */
  points?: Point[];
  text?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  textAlign?: 'left' | 'center' | 'right';
  color?: string;
  fill?: string;
  strokeWidth?: number;
  opacity?: number;
  image?: { bytes: ArrayBuffer; kind: 'png' | 'jpg'; name: string };
}

interface PageModel {
  /** Index into the original pdf.js/pdflib document, or -1 for a blank page. */
  sourceIndex: number;
  rotation: 0 | 90 | 180 | 270;
  overlays: Overlay[];
  blankWidth?: number;
  blankHeight?: number;
}

let overlaySequence = 0;
function nextId(): string {
  overlaySequence += 1;
  return `ov-${overlaySequence}`;
}

function hexToRgbTuple(hex: string): { r: number; g: number; b: number } {
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
  link.rel = 'noopener';
  // The anchor must be in the document for the click to be treated as a user
  // download by every browser (and by Electron's file:// renderer).
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking synchronously can abort the download before it starts.
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const rotateCw = (value: PageModel['rotation']): PageModel['rotation'] =>
  ((value + 90) % 360) as PageModel['rotation'];
const rotateCcw = (value: PageModel['rotation']): PageModel['rotation'] =>
  ((value + 270) % 360) as PageModel['rotation'];

function makeBlankPage(width = 595.28, height = 841.89): PageModel {
  return {
    sourceIndex: -1,
    rotation: 0,
    overlays: [],
    blankWidth: width,
    blankHeight: height,
  };
}

/** Where a page actually lives on the printed sheet, as pdf.js lays it out. */
interface PageGeometry {
  /** CropBox lower-left corner in unrotated user space. */
  x: number;
  y: number;
  /** CropBox size in unrotated user space. */
  width: number;
  height: number;
  /** Clockwise rotation applied by the viewer (file /Rotate + editor rotation). */
  rotation: number;
}

function normalizeRotation(value: number): 0 | 90 | 180 | 270 {
  const snapped = (Math.round(value / 90) * 90) % 360;
  return ((snapped + 360) % 360) as 0 | 90 | 180 | 270;
}

/**
 * pdf.js lays a page out in "view" space: origin at the top-left corner, y
 * pointing down, one unit per PDF point at scale 1. pdf-lib writes into
 * unrotated user space (origin bottom-left, y up).
 *
 * Converting between the two keeps an annotation exactly where it was drawn,
 * even when the source page carries a /Rotate flag or a non-zero CropBox
 * origin — both are common in scanned and print-ready files, and ignoring them
 * made saved overlays land outside the visible page.
 */
function displayToUser(geometry: PageGeometry, point: Point): Point {
  switch (normalizeRotation(geometry.rotation)) {
    case 90:
      return { x: geometry.x + point.y, y: geometry.y + point.x };
    case 180:
      return { x: geometry.x + geometry.width - point.x, y: geometry.y + point.y };
    case 270:
      return {
        x: geometry.x + geometry.width - point.y,
        y: geometry.y + geometry.height - point.x,
      };
    default:
      return { x: geometry.x + point.x, y: geometry.y + geometry.height - point.y };
  }
}

/** Maps a display-space box onto an axis-aligned box in user space. */
function displayBoxToUser(
  geometry: PageGeometry,
  box: { x: number; y: number; w: number; h: number }
): { x: number; y: number; width: number; height: number } {
  const topLeft = displayToUser(geometry, { x: box.x, y: box.y });
  const bottomRight = displayToUser(geometry, { x: box.x + box.w, y: box.y + box.h });
  return {
    x: Math.min(topLeft.x, bottomRight.x),
    y: Math.min(topLeft.y, bottomRight.y),
    width: Math.abs(bottomRight.x - topLeft.x),
    height: Math.abs(bottomRight.y - topLeft.y),
  };
}

/** Sniffs the real image format; file extensions lie far too often. */
function detectImageKind(bytes: ArrayBuffer | Uint8Array): 'png' | 'jpg' | null {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.length >= 8 && view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47) {
    return 'png';
  }
  if (view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) {
    return 'jpg';
  }
  return null;
}

/** Embeds a stamp, falling back to the other decoder before failing an export. */
async function embedStampImage(out: PDFDocument, image: NonNullable<Overlay['image']>): Promise<PDFImage> {
  const kind = detectImageKind(image.bytes) ?? image.kind;
  try {
    return kind === 'png' ? await out.embedPng(image.bytes) : await out.embedJpg(image.bytes);
  } catch {
    return kind === 'png' ? await out.embedJpg(image.bytes) : await out.embedPng(image.bytes);
  }
}

const clampZoom = (value: number) => Math.min(3, Math.max(0.25, Math.round(value * 100) / 100));

async function buildEditedPdf(originalPdfBytes: Uint8Array, pages: PageModel[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const src = await PDFDocument.load(originalPdfBytes.slice(0), { ignoreEncryption: true });
  const [font, boldFont, italicFont, boldItalicFont] = await Promise.all([
    out.embedFont(StandardFonts.Helvetica),
    out.embedFont(StandardFonts.HelveticaBold),
    out.embedFont(StandardFonts.HelveticaOblique),
    out.embedFont(StandardFonts.HelveticaBoldOblique),
  ]);

  for (const pageModel of pages) {
    const blankWidth = pageModel.blankWidth ?? 595.28;
    const blankHeight = pageModel.blankHeight ?? 841.89;
    let page: PDFPage;
    let geometry: PageGeometry;

    if (pageModel.sourceIndex < 0) {
      page = out.addPage([blankWidth, blankHeight]);
      geometry = {
        x: 0,
        y: 0,
        width: blankWidth,
        height: blankHeight,
        rotation: normalizeRotation(pageModel.rotation),
      };
      page.setRotation(degrees(geometry.rotation));
    } else {
      const srcPage = await src.getPage(pageModel.sourceIndex);
      const box = srcPage.getCropBox();
      // Viewers apply the file's own /Rotate on top of the editor's rotation,
      // so both are folded into the exported page instead of one replacing the
      // other (which re-oriented pages the user never touched).
      const rotation = normalizeRotation(srcPage.getRotation().angle + pageModel.rotation);
      const [copied] = await out.copyPages(src, [pageModel.sourceIndex]);
      copied.setRotation(degrees(rotation));
      page = out.addPage(copied);
      geometry = { x: box.x, y: box.y, width: box.width, height: box.height, rotation };
    }

    const bounds = (overlay: Overlay) => displayBoxToUser(geometry, overlay);
    const point = (x: number, y: number) => displayToUser(geometry, { x, y });
    const textRotation = degrees(geometry.rotation);
    const pdfColor = (value: string | undefined, fallback: string) => {
      const color = hexToRgbTuple(value ?? fallback);
      return rgb(color.r, color.g, color.b);
    };

    for (const overlay of pageModel.overlays) {
      switch (overlay.kind) {
        case 'text': {
          const label = sanitizeWinAnsiText(overlay.text ?? '');
          if (!label.trim()) break;
          if (overlay.fill) {
            page.drawRectangle({ ...bounds(overlay), color: pdfColor(overlay.fill, '#ffffff'), opacity: overlay.opacity ?? 0.85 });
          }
          const size = overlay.fontSize ?? 16;
          const textFont = overlay.italic
            ? overlay.bold ? boldItalicFont : italicFont
            : overlay.bold ? boldFont : font;
          const textWidth = textFont.widthOfTextAtSize(label, size);
          const x = overlay.textAlign === 'center'
            ? overlay.x + (overlay.w - textWidth) / 2
            : overlay.textAlign === 'right' ? overlay.x + overlay.w - textWidth : overlay.x;
          // pdf-lib rotates a label about its baseline origin, which is exactly
          // what keeps text upright on /Rotate 90 / 180 / 270 pages.
          const origin = point(x, overlay.y + size);
          page.drawText(label, {
            x: origin.x,
            y: origin.y,
            size,
            font: textFont,
            color: pdfColor(overlay.color, '#111111'),
            rotate: textRotation,
          });
          break;
        }
        case 'rect':
          page.drawRectangle({
            ...bounds(overlay),
            borderColor: pdfColor(overlay.color, '#000000'),
            borderWidth: overlay.strokeWidth ?? 2,
            ...(overlay.fill ? { color: pdfColor(overlay.fill, '#ffffff'), opacity: overlay.opacity ?? 0.15 } : {}),
          });
          break;
        case 'ellipse': {
          // pdf-lib takes an ellipse's *centre* plus x/y *radii*. It used to be
          // handed a top-left box, so the call silently drew pdf-lib's default
          // 200pt circle around the corner and the real oval was never saved.
          const box = bounds(overlay);
          page.drawEllipse({
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
            xScale: Math.max(box.width / 2, 0.5),
            yScale: Math.max(box.height / 2, 0.5),
            borderColor: pdfColor(overlay.color, '#000000'),
            borderWidth: overlay.strokeWidth ?? 2,
            ...(overlay.fill ? { color: pdfColor(overlay.fill, '#ffffff'), opacity: overlay.opacity ?? 0.15 } : {}),
          });
          break;
        }
        case 'whiteout':
          // Whiteout is a redaction: keep the colour the user picked (white by
          // default) instead of always stamping a black block over the page.
          page.drawRectangle({ ...bounds(overlay), color: pdfColor(overlay.color, '#ffffff') });
          break;
        case 'line':
        case 'arrow': {
          const color = pdfColor(overlay.color, '#111111');
          const thickness = overlay.strokeWidth ?? 2;
          const start = point(overlay.x, overlay.y);
          const end = point(overlay.x + overlay.w, overlay.y + overlay.h);
          page.drawLine({ start, end, thickness, color });
          if (overlay.kind === 'arrow') {
            // Build the head in user space so it follows the mapped direction.
            const angle = Math.atan2(end.y - start.y, end.x - start.x);
            for (const side of [1, -1]) {
              const headAngle = angle + side * (Math.PI / 6) + Math.PI;
              page.drawLine({
                start: end,
                end: { x: end.x + Math.cos(headAngle) * 10, y: end.y + Math.sin(headAngle) * 10 },
                thickness,
                color,
              });
            }
          }
          break;
        }
        case 'pen':
        case 'highlight': {
          const points = (overlay.points ?? []).map((strokePoint) => point(strokePoint.x, strokePoint.y));
          const thickness = (overlay.strokeWidth ?? 2) * (overlay.kind === 'highlight' ? 4 : 1);
          const opacity = overlay.kind === 'highlight' ? 0.35 : 1;
          for (let index = 1; index < points.length; index += 1) {
            page.drawLine({
              start: points[index - 1],
              end: points[index],
              thickness,
              color: pdfColor(overlay.color, '#111111'),
              opacity,
            });
          }
          break;
        }
        case 'stamp':
          if (overlay.image) {
            const image = await embedStampImage(out, overlay.image);
            // drawImage rotates about (x, y), so anchor the bitmap's display
            // bottom-left corner and rotate the whole image with the page.
            const origin = point(overlay.x, overlay.y + overlay.h);
            page.drawImage(image, {
              x: origin.x,
              y: origin.y,
              width: overlay.w,
              height: overlay.h,
              opacity: overlay.opacity ?? 1,
              rotate: textRotation,
            });
          }
          break;
      }
    }
  }
  return out.save();
}

const HANDLE_SIZE = 7;


export const PdfEditor: React.FC<PdfEditorProps> = ({
  canStartAction,
  incrementUsage,
  initialFile = null,
}) => {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const stampInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pageElRefs = useRef<Array<HTMLDivElement | null>>([]);
  const baseRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const overlayRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const textLayerRefs = useRef<Array<HTMLDivElement | null>>([]);
  const thumbRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const stampUrlsRef = useRef<Map<string, string>>(new Map());

  const proxiesRef = useRef<Array<pdfjsLib.PDFPageProxy | null>>([]);
  const tasksRef = useRef<Map<number, ReturnType<pdfjsLib.PDFPageProxy['render']>>>(new Map());
  const loadingTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null);
  const renderVersionRef = useRef(0);
  const draftRef = useRef<{ index: number; overlay: Overlay } | null>(null);
  const eraserRef = useRef<{ index: number; points: Point[] } | null>(null);
  const dragRef = useRef<{
    index: number;
    mode: 'move' | 'resize' | 'draw';
    overlayIndex: number;
    start: Point;
  } | null>(null);
  const startPagesRef = useRef<PageModel[]>([]);
  const historyPastRef = useRef<PageModel[][]>([]);
  const historyFutureRef = useRef<PageModel[][]>([]);

  const [fileName, setFileName] = useState('');
  const [originalPdfBytes, setOriginalPdfBytes] = useState<Uint8Array | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [showThumbs, setShowThumbs] = useState(true);

  const [pages, setPages] = useState<PageModel[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<ToolMode>('select');
  const [pendingStamp, setPendingStamp] = useState<{ bytes: ArrayBuffer; kind: 'png' | 'jpg' } | null>(null);
  const [selection, setSelection] = useState<{ pageIndex: number; overlayIndex: number } | null>(null);

  const [penColor] = useState('#f59e0b');
  const [brushSize, setBrushSize] = useState(2.5);
  const [highlightColor, setHighlightColor] = useState('#ebeb3b');
  const [textColor, setTextColor] = useState('#111827');
  const [textContent, setTextContent] = useState('Note');
  const [textSize, setTextSize] = useState(18);
  const [textBold, setTextBold] = useState(false);
  const [textItalic, setTextItalic] = useState(false);
  const [textAlign, setTextAlign] = useState<'left' | 'center' | 'right'>('left');
  const [textFill, setTextFill] = useState('#00000000');
  const [shapeStroke, setShapeStroke] = useState('#0f172a');
  const [shapeFill, setShapeFill] = useState('#facc15');
  const [shapeWidth] = useState(2.5);
  const [whiteoutColor, setWhiteoutColor] = useState('#ffffff');

  const commitPages = (next: PageModel[]) => {
    historyPastRef.current.push(pages);
    historyFutureRef.current = [];
    setPages(next);
    setSelection(null);
  };

  const undo = () => {
    const previous = historyPastRef.current.pop();
    if (!previous) return;
    historyFutureRef.current.push(pages);
    setPages(previous);
    setSelection(null);
  };

  const redo = () => {
    const next = historyFutureRef.current.pop();
    if (!next) return;
    historyPastRef.current.push(pages);
    setPages(next);
    setSelection(null);
  };

  /** Native pdf.js text layer on top of each page. */
  const renderTextLayer = async (pageModel: PageModel, index: number) => {
    const layer = textLayerRefs.current[index];
    const proxy = pageModel.sourceIndex >= 0 ? proxiesRef.current[pageModel.sourceIndex] : null;
    if (!layer) return;
    if (!proxy) {
      layer.innerHTML = '';
      return;
    }
    const viewport = proxy.getViewport({ scale: zoom, rotation: pageModel.rotation });
    layer.style.width = `${viewport.width}px`;
    layer.style.height = `${viewport.height}px`;
    layer.innerHTML = '';
    const textContent = await proxy.getTextContent();
    const task = pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: layer,
      viewport,
      textDivs: [],
    }) as { promise?: Promise<void> } | undefined;
    if (task?.promise) await task.promise.catch(() => undefined);
  };

  const drawSelectionBox = (ctx: CanvasRenderingContext2D, overlay: Overlay, scale: number) => {
    const s = HANDLE_SIZE / scale;
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([5 / scale, 4 / scale]);
    ctx.strokeRect(overlay.x - 2 / scale, overlay.y - 2 / scale, overlay.w + 4 / scale, overlay.h + 4 / scale);
    ctx.setLineDash([]);
    ctx.fillStyle = '#2563eb';
    const corners = [
      [overlay.x, overlay.y],
      [overlay.x + overlay.w, overlay.y],
      [overlay.x, overlay.y + overlay.h],
      [overlay.x + overlay.w, overlay.y + overlay.h],
    ];
    for (const [hx, hy] of corners) ctx.fillRect((hx as number) - s / 2, (hy as number) - s / 2, s, s);
    ctx.restore();
  };


  const paintOverlay = (ctx: CanvasRenderingContext2D, scale: number, item: Overlay, withSelection: boolean) => {
    ctx.save();
    if (item.kind === 'text') {
      ctx.font = `${item.italic ? 'italic ' : ''}${item.bold ? '700 ' : ''}${item.fontSize ?? 16}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      if (item.fill && item.fill !== '#00000000') { ctx.fillStyle = item.fill; ctx.globalAlpha = item.opacity ?? 0.85; ctx.fillRect(item.x, item.y, item.w, item.h); ctx.globalAlpha = 1; }
      ctx.fillStyle = item.color ?? '#111827';
      const text = item.text ?? '';
      const m = ctx.measureText(text).width;
      const x = item.textAlign === 'center' ? item.x + (item.w - m) / 2 : item.textAlign === 'right' ? item.x + item.w - m : item.x;
      ctx.fillText(text, x, item.y + 1 / scale);
    } else if (item.kind === 'pen' || item.kind === 'highlight') {
      const hl = item.kind === 'highlight';
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = item.color ?? '#111827';
      ctx.globalCompositeOperation = hl ? 'multiply' : 'source-over';
      ctx.globalAlpha = hl ? 0.35 : 1;
      ctx.lineWidth = (item.strokeWidth ?? 2) * (hl ? 4 : 1);
      ctx.beginPath();
      (item.points ?? []).forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    } else if (item.kind === 'whiteout') {
      ctx.fillStyle = item.color ?? '#ffffff';
      ctx.fillRect(item.x, item.y, item.w, item.h);
    } else if (item.kind === 'rect' || item.kind === 'ellipse') {
      ctx.beginPath();
      if (item.kind === 'rect') ctx.rect(item.x, item.y, item.w, item.h);
      else ctx.ellipse(item.x + item.w / 2, item.y + item.h / 2, item.w / 2, item.h / 2, 0, 0, Math.PI * 2);
      if (item.fill) { ctx.fillStyle = item.fill; ctx.globalAlpha = item.opacity ?? 0.2; ctx.fill(); ctx.globalAlpha = 1; }
      ctx.strokeStyle = item.color ?? '#0f172a'; ctx.lineWidth = item.strokeWidth ?? 2; ctx.stroke();
    } else if (item.kind === 'line' || item.kind === 'arrow') {
      ctx.strokeStyle = item.color ?? '#0f172a'; ctx.lineWidth = item.strokeWidth ?? 2;
      ctx.beginPath(); ctx.moveTo(item.x, item.y); ctx.lineTo(item.x + item.w, item.y + item.h); ctx.stroke();
      if (item.kind === 'arrow') {
        const angle = Math.atan2(item.h, item.w); const tail = 10 / scale;
        for (const side of [1, -1]) {
          const a = angle + side * (Math.PI / 6);
          ctx.beginPath(); ctx.moveTo(item.x + item.w, item.y + item.h); ctx.lineTo(item.x + item.w - Math.cos(a) * tail, item.y + item.h - Math.sin(a) * tail); ctx.stroke();
        }
      }
    } else if (item.kind === 'stamp' && item.image) {
      const url = stampUrlsRef.current.get(item.id);
      if (url) { const img = new Image(); img.onload = () => ctx.drawImage(img, item.x, item.y, item.w, item.h); img.src = url; }
    }
    if (withSelection) drawSelectionBox(ctx, item, scale);
    ctx.restore();
  };


  const renderOnePage = async (index: number) => {
    const pm = pages[index];
    const canvas = baseRefs.current[index];
    const overlay = overlayRefs.current[index];
    if (!pm || !canvas || !overlay) return;
    const dpr = window.devicePixelRatio || 1;
    const scale = zoom * dpr;
    const version = renderVersionRef.current;
    if (pm.sourceIndex < 0) {
      // Blank pages have no pdf.js viewport, so their display size has to be
      // derived here — including the 90°/270° swap the export writes as /Rotate.
      const baseWidth = pm.blankWidth ?? 595;
      const baseHeight = pm.blankHeight ?? 842;
      const swaps = pm.rotation === 90 || pm.rotation === 270;
      const displayWidth = swaps ? baseHeight : baseWidth;
      const displayHeight = swaps ? baseWidth : baseHeight;
      canvas.width = Math.ceil(displayWidth * scale);
      canvas.height = Math.ceil(displayHeight * scale);
      canvas.style.width = `${displayWidth * zoom}px`;
      canvas.style.height = `${displayHeight * zoom}px`;
      const bg = canvas.getContext('2d');
      if (bg) { bg.fillStyle = '#ffffff'; bg.fillRect(0, 0, canvas.width, canvas.height); }
    } else {
      const proxy = proxiesRef.current[pm.sourceIndex];
      if (!proxy) return;
      const viewport = proxy.getViewport({ scale, rotation: pm.rotation });
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${Math.ceil(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.ceil(viewport.height / dpr)}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      tasksRef.current.get(index)?.cancel();
      const task = proxy.render({ canvasContext: ctx, viewport });
      tasksRef.current.set(index, task);
      try {
        await task.promise;
        if (version !== renderVersionRef.current) return;
      } catch { /* cancelled */ } finally {
        if (tasksRef.current.get(index) === task) tasksRef.current.delete(index);
      }
    }
    overlay.width = canvas.width; overlay.height = canvas.height;
    overlay.style.width = canvas.style.width; overlay.style.height = canvas.style.height;
    const octx = overlay.getContext('2d');
    if (!octx) return;
    octx.setTransform(scale, 0, 0, scale, 0, 0);
    octx.clearRect(0, 0, canvas.width / scale, canvas.height / scale);
    for (let oi = 0; oi < pm.overlays.length; oi += 1) {
      paintOverlay(octx, scale, pm.overlays[oi], selection?.pageIndex === index && selection.overlayIndex === oi);
    }
    const draft = draftRef.current;
    if (draft && draft.index === index) paintOverlay(octx, scale, draft.overlay, false);
    if (version !== renderVersionRef.current) return;
    await renderTextLayer(pm, index);
  };

  const renderAllPages = async () => {
    const version = ++renderVersionRef.current;
    tasksRef.current.forEach((t) => t.cancel());
    tasksRef.current.clear();
    for (let i = 0; i < pages.length; i += 1) {
      if (version !== renderVersionRef.current) return;
      await renderOnePage(i);
    }
  };

  const handleRenderError = (error: unknown) => {
    if (error instanceof Error && /cancel/i.test(error.message)) return;
    setError(error instanceof Error ? error.message : 'PDF rendering failed.');
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void renderAllPages().catch(handleRenderError);
    });
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, fileName, zoom, isOpen, selection]);

  const renderThumb = async (pm: PageModel, index: number) => {
    const thumb = thumbRefs.current[index];
    if (!thumb) return;
    const ctx = thumb.getContext('2d');
    if (!ctx) return;
    if (pm.sourceIndex < 0) {
      thumb.width = 100; thumb.height = 140;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 100, 140); return;
    }
    const proxy = proxiesRef.current[pm.sourceIndex];
    if (!proxy) return;
    const base = proxy.getViewport({ scale: 1, rotation: 0 });
    const scale = 120 / Math.max(base.width, 1);
    const vp = proxy.getViewport({ scale, rotation: pm.rotation });
    thumb.width = Math.ceil(vp.width); thumb.height = Math.ceil(vp.height);
    await proxy.render({ canvasContext: ctx, viewport: vp }).promise;
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void (async () => {
        for (let i = 0; i < pages.length; i += 1) await renderThumb(pages[i], i);
      })().catch(handleRenderError);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pages, fileName, isOpen, showThumbs]);


  const loadFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setError('Please choose a PDF file.');
      return;
    }
    renderVersionRef.current += 1;
    tasksRef.current.forEach((t) => t.cancel());
    const old = loadingTaskRef.current;
    loadingTaskRef.current = null;
    proxiesRef.current = [];
    if (old) void old.destroy().catch(() => undefined);
    setError('');
    setLoading(true);
    try {
      const raw = await file.arrayBuffer();
      const fileBytes = new Uint8Array(raw);
      setOriginalPdfBytes(fileBytes.slice());
      const task = loadPdfDocument(fileBytes);
      task.onPassword = () => setError('This PDF is password-protected. Password entry is not supported here.');
      loadingTaskRef.current = task;
      const document = await task.promise;
      proxiesRef.current = await Promise.all(
        Array.from({ length: document.numPages }, (_, i) => document.getPage(i + 1))
      );
      setFileName(file.name);
      historyPastRef.current = [];
      historyFutureRef.current = [];
      setPages(
        Array.from({ length: document.numPages }, (_, i) => ({
          sourceIndex: i,
          rotation: 0 as const,
          overlays: [],
        }))
      );
      setActiveIndex(0);
      setIsOpen(true);
      setZoom(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The PDF could not be opened.');
      setIsOpen(false);
    } finally {
      setLoading(false);
    }
    // Every dependency above is a ref or a stable setter.
  }, []);

  // Open documents handed over by the OS file handler (installed PWA).
  // The load is deferred one task: `loadFile` sets state immediately, which
  // must not happen inside the effect body itself.
  useEffect(() => {
    if (!initialFile) return;
    const handle = window.setTimeout(() => void loadFile(initialFile), 0);
    return () => window.clearTimeout(handle);
  }, [initialFile, loadFile]);

  useEffect(() => {
    const stampUrls = stampUrlsRef.current;
    return () => {
      stampUrls.forEach((url) => URL.revokeObjectURL(url));
      stampUrls.clear();
    };
  }, []);

  useEffect(() => {
    const renderTasks = tasksRef.current;
    return () => {
      renderVersionRef.current += 1;
      renderTasks.forEach((t) => t.cancel());
      renderTasks.clear();

      const task = loadingTaskRef.current;
      loadingTaskRef.current = null;
      if (task) void task.destroy().catch(() => undefined);

      proxiesRef.current.forEach((page) => page?.cleanup());
      proxiesRef.current = [];
    };
  }, []);

  const updatePage = (index: number, fn: (page: PageModel) => PageModel) =>
    commitPages(pages.map((page, i) => (i === index ? fn(page) : page)));

  const rotatePage = (index: number, cw: boolean) => {
    const page = pages[index];
    if (!page) return;
    if (page.overlays.length > 0) {
      toast.error('Clear this page’s annotations before rotating it.');
      return;
    }
    updatePage(index, (p) => ({ ...p, rotation: cw ? rotateCw(p.rotation) : rotateCcw(p.rotation) }));
  };

  const deletePage = (index: number) => {
    if (!pages[index]) return;
    pages[index].overlays.forEach((overlay) => {
      if (overlay.kind === 'stamp') {
        const url = stampUrlsRef.current.get(overlay.id);
        if (url) {
          URL.revokeObjectURL(url);
          stampUrlsRef.current.delete(overlay.id);
        }
      }
    });
    const next = pages.filter((_, i) => i !== index);
    commitPages(next);
    setActiveIndex(Math.max(0, Math.min(pages.length - 2, activeIndex)));
  };

  const duplicatePage = (index: number) => {
    const next = [...pages];
    const overlays = pages[index].overlays.map((overlay) => {
      const id = nextId();
      if (overlay.kind === 'stamp' && overlay.image) {
        const url = URL.createObjectURL(new Blob([overlay.image.bytes as unknown as BlobPart]));
        stampUrlsRef.current.set(id, url);
      }
      return { ...overlay, id };
    });
    next.splice(index + 1, 0, { ...pages[index], overlays });
    commitPages(next);
  };

  const insertBlank = (index: number) => {
    const next = [...pages];
    next.splice(index + 1, 0, makeBlankPage());
    commitPages(next);
  };

  const movePage = (from: number, to: number) => {
    if (to < 0 || to >= pages.length) return;
    const next = [...pages];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    commitPages(next);
    setActiveIndex(to);
  };

  const removeOverlay = (pageIndex: number, overlayIndex: number) => {
    const removed = pages[pageIndex]?.overlays[overlayIndex];
    if (removed?.kind === 'stamp') {
      const url = stampUrlsRef.current.get(removed.id);
      if (url) {
        URL.revokeObjectURL(url);
        stampUrlsRef.current.delete(removed.id);
      }
    }
    const next = pages.map((p, i) =>
      i === pageIndex ? { ...p, overlays: p.overlays.filter((_, oi) => oi !== overlayIndex) } : p
    );
    commitPages(next);
  };

  const clearActivePage = () => {
    if (!pages[activeIndex]) return;
    pages[activeIndex].overlays.forEach((overlay) => {
      if (overlay.kind === 'stamp') {
        const url = stampUrlsRef.current.get(overlay.id);
        if (url) {
          URL.revokeObjectURL(url);
          stampUrlsRef.current.delete(overlay.id);
        }
      }
    });
    commitPages(pages.map((p, i) => (i === activeIndex ? { ...p, overlays: [] } : p)));
  };

  const hitTest = (pageIndex: number, point: Point): number => {
    const overlays = pages[pageIndex]?.overlays ?? [];
    for (let i = overlays.length - 1; i >= 0; i -= 1) {
      const o = overlays[i];
      if (o.kind === 'pen' || o.kind === 'highlight') {
        const tol = Math.max(6, o.strokeWidth ?? 3);
        if ((o.points ?? []).some((p) => Math.hypot(p.x - point.x, p.y - point.y) <= tol)) return i;
      } else if (point.x >= o.x && point.x <= o.x + o.w && point.y >= o.y && point.y <= o.y + o.h) {
        return i;
      }
    }
    return -1;
  };

  const getPoint = (e: React.PointerEvent, index: number): Point => {
    const el = pageElRefs.current[index];
    const rect = el?.getBoundingClientRect();
    return { x: (e.clientX - (rect?.left ?? 0)) / zoom, y: (e.clientY - (rect?.top ?? 0)) / zoom };
  };

  const normalizedBox = (a: Point, b: Point, min = 1) => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.max(min, Math.abs(b.x - a.x)),
    h: Math.max(min, Math.abs(b.y - a.y)),
  });

  const makeStampOverlay = (p: Point): Overlay => {
    if (!pendingStamp) return { id: '', kind: 'stamp', x: 0, y: 0, w: 0, h: 0 };
    const bytes = pendingStamp.bytes;
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
    const id = nextId();
    stampUrlsRef.current.set(id, url);
    return {
      id,
      kind: 'stamp',
      x: p.x,
      y: p.y,
      w: 150,
      h: 100,
      opacity: 1,
      image: { bytes, kind: pendingStamp.kind, name: 'stamp' },
    };
  };


  const onPointerDown = (event: React.PointerEvent, index: number) => {
    const point = getPoint(event, index);
    const page = pages[index];
    if (!page) return;
    setActiveIndex(index);
    startPagesRef.current = pages;

    if (tool === 'select') {
      const hit = hitTest(index, point);
      if (hit >= 0) {
        const o = page.overlays[hit];
        const nearBR = Math.abs(point.x - (o.x + o.w)) <= HANDLE_SIZE / zoom && Math.abs(point.y - (o.y + o.h)) <= HANDLE_SIZE / zoom;
        const resizable = nearBR && o.kind !== 'pen' && o.kind !== 'highlight';
        dragRef.current = { index, mode: resizable ? 'resize' : 'move', overlayIndex: hit, start: point };
        historyPastRef.current.push(pages);
        historyFutureRef.current = [];
        setSelection({ pageIndex: index, overlayIndex: hit });
        (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
      } else {
        dragRef.current = null;
        setSelection(null);
      }
      return;
    }
    if (page.rotation !== 0) return;
    event.preventDefault();

    if (tool === 'eraser') {
      eraserRef.current = { index, points: [point] };
      (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
      return;
    }
    if (tool === 'text') {
      const text = textContent.trim();
      if (!text) return;
      const overlay: Overlay = {
        id: nextId(), kind: 'text', x: point.x, y: point.y,
        w: Math.max(text.length * textSize * 0.6, 40), h: textSize * 1.5,
        text, fontSize: textSize, bold: textBold, italic: textItalic, textAlign,
        color: textColor, fill: textFill === '#00000000' ? undefined : textFill,
      };
      commitPages(pages.map((p, pi) => (pi === index ? { ...p, overlays: [...p.overlays, overlay] } : p)));
      setTextContent('');
      return;
    }
    if (tool === 'stamp') {
      if (!pendingStamp) { toast.error('Upload a PNG/JPG stamp image first.'); return; }
      commitPages(pages.map((p, pi) => (pi === index ? { ...p, overlays: [...p.overlays, makeStampOverlay(point)] } : p)));
      return;
    }
    if (tool === 'pen' || tool === 'highlight') {
      draftRef.current = {
        index,
        overlay: { id: nextId(), kind: tool, x: point.x, y: point.y, w: 1, h: 1, points: [point], color: tool === 'highlight' ? highlightColor : penColor, strokeWidth: brushSize },
      };
      void renderOnePage(index).catch(handleRenderError);
      (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
      return;
    }
    draftRef.current = {
      index,
      overlay:
        tool === 'whiteout'
          ? { id: nextId(), kind: 'whiteout', x: point.x, y: point.y, w: 0, h: 0, color: whiteoutColor }
          : { id: nextId(), kind: tool as Overlay['kind'], x: point.x, y: point.y, w: 0, h: 0, color: shapeStroke, fill: shapeFill === 'transparent' ? undefined : shapeFill, strokeWidth: shapeWidth, opacity: 0.25 },
    };
    dragRef.current = { index, mode: 'draw', overlayIndex: -1, start: point };
    void renderOnePage(index).catch(handleRenderError);
    (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const eraser = eraserRef.current;
    if (eraser) {
      event.preventDefault();
      eraser.points = [...eraser.points, getPoint(event, eraser.index)];
      return;
    }
    const drag = dragRef.current;
    const draft = draftRef.current;
    if (draft && (!drag || drag.mode === 'draw')) {
      if (draft.overlay.kind === 'pen' || draft.overlay.kind === 'highlight') {
        draft.overlay.points = [...(draft.overlay.points ?? []), getPoint(event, draft.index)];
        void renderOnePage(draft.index).catch(handleRenderError);
        return;
      }
      const cur = getPoint(event, draft.index);
      const start = drag?.start ?? { x: draft.overlay.x, y: draft.overlay.y };
      if (draft.overlay.kind === 'line' || draft.overlay.kind === 'arrow') {
        draft.overlay.w = cur.x - start.x;
        draft.overlay.h = cur.y - start.y;
      } else {
        const box = normalizedBox(start, cur, 2);
        draft.overlay.x = box.x; draft.overlay.y = box.y; draft.overlay.w = box.w; draft.overlay.h = box.h;
      }
      void renderOnePage(draft.index).catch(handleRenderError);
      return;
    }
    if (!drag) return;
    const cur = getPoint(event, drag.index);
    const dx = cur.x - drag.start.x;
    const dy = cur.y - drag.start.y;
    setPages((previous) =>
      previous.map((p, pi) =>
        pi !== drag.index
          ? p
          : {
              ...p,
              overlays: p.overlays.map((o, oi) => {
                if (oi !== drag.overlayIndex) return o;
                if (drag.mode === 'move') {
                  if (o.kind === 'pen' || o.kind === 'highlight') {
                    return { ...o, x: o.x + dx, y: o.y + dy, points: (o.points ?? []).map((pt) => ({ x: pt.x + dx, y: pt.y + dy })) };
                  }
                  return { ...o, x: o.x + dx, y: o.y + dy };
                }
                return { ...o, w: Math.max(8, o.w + dx), h: Math.max(8, o.h + dy) };
              }),
            }
      )
    );
  };


  const onPointerUp = () => {
    const eraser = eraserRef.current;
    if (eraser) {
      eraserRef.current = null;
      const radius = Math.max(6, brushSize * 3);
      const next = startPagesRef.current.map((p, pi) =>
        pi !== eraser.index
          ? p
          : {
              ...p,
              overlays: p.overlays.filter((o) => {
                if (o.kind !== 'pen' && o.kind !== 'highlight') return true;
                return !eraser.points.some((ep) =>
                  (o.points ?? []).some((pp) => Math.hypot(pp.x - ep.x, pp.y - ep.y) <= radius)
                );
              }),
            }
      );
      commitPages(next);
      return;
    }
    const draft = draftRef.current;
    if (draft) {
      const overlay = draft.overlay;
      const valid =
        overlay.kind === 'pen' || overlay.kind === 'highlight'
          ? (overlay.points?.length ?? 0) > 1
          : overlay.w > 2 && overlay.h > 2;
      if (valid) {
        const next = startPagesRef.current.map((p, pi) =>
          pi !== draft.index ? p : { ...p, overlays: [...p.overlays, { ...overlay }] }
        );
        commitPages(next);
      }
    }
    draftRef.current = null;
    dragRef.current = null;
  };

  // Keyboard: Delete/Backspace removes the selection; Ctrl+Z / Ctrl+Y history.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selection) { event.preventDefault(); removeOverlay(selection.pageIndex, selection.overlayIndex); }
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); return; }
      if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  const fitToWidth = () => {
    const container = scrollRef.current;
    const first = proxiesRef.current[pages[0]?.sourceIndex >= 0 ? pages[0].sourceIndex : 0];
    if (!container || !first) return;
    const vp = first.getViewport({ scale: 1, rotation: pages[0]?.rotation ?? 0 });
    setZoom(clampZoom((container.clientWidth - 96) / vp.width));
  };

  const exportEdited = async () => {
    if (!originalPdfBytes || pages.length === 0 || exporting) return;
    if (!canStartAction()) return;
    setExporting(true);
    try {
      const bytes = await buildEditedPdf(originalPdfBytes, pages);
      incrementUsage();
      downloadPdf(bytes, `${fileName.replace(/\.pdf$/i, '') || 'document'}-edited.pdf`);
      toast.success('Edited PDF exported successfully.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to export the edited PDF.');
    } finally {
      setExporting(false);
    }
  };


  const selectedOverlay = selection
    ? pages[selection.pageIndex]?.overlays[selection.overlayIndex] ?? null
    : null;

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
          onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            event.preventDefault(); setIsDragging(false);
            const file = event.dataTransfer.files?.[0];
            if (file) void loadFile(file);
          }}
          className={`rounded-2xl border-2 border-dashed p-10 text-center transition ${isDragging ? 'border-indigo-400 bg-indigo-500/10' : 'border-slate-700 bg-slate-900/60'}`}
        >
          <Upload className="mx-auto h-10 w-10 text-indigo-400/80" />
          <p className="mt-3 text-sm font-medium text-slate-200">Drop a PDF here to edit</p>
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
          <p className="rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-300">{error}</p>
        )}
      </div>
    );
  }

  const toolButtons: Array<{ id: ToolMode; label: string }> = [
    { id: 'select', label: 'Select' },
    { id: 'pen', label: 'Pen' },
    { id: 'highlight', label: 'Highlighter' },
    { id: 'text', label: 'Text' },
    { id: 'rect', label: 'Rect' },
    { id: 'ellipse', label: 'Oval' },
    { id: 'line', label: 'Line' },
    { id: 'arrow', label: 'Arrow' },
    { id: 'eraser', label: 'Eraser' },
    { id: 'whiteout', label: 'Redact' },
    { id: 'stamp', label: 'Stamp' },
  ];

  return (
    <div className="flex h-[78vh] flex-col gap-3">
      {/* Top toolbar */}
      <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-800 bg-slate-950/60 p-1.5">
        {toolButtons.map((tb) => (
          <button
            key={tb.id}
            type="button"
            onClick={() => setTool(tb.id)}
            className={`rounded-md px-2 py-1 text-xs font-medium transition ${
              tool === tb.id ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
          >
            {tb.label}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-slate-700" aria-hidden="true" />
        <button type="button" onClick={undo} title="Undo (Ctrl+Z)" className="rounded p-1 text-slate-300 hover:bg-slate-800 hover:text-white">
          <Undo2 className="h-4 w-4" />
        </button>
        <button type="button" onClick={redo} title="Redo (Ctrl+Y)" className="rounded p-1 text-slate-300 hover:bg-slate-800 hover:text-white">
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={clearActivePage}
          disabled={!pages[activeIndex]?.overlays.length}
          className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-red-500/60 hover:text-red-300 disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" /> Clear Page
        </button>
        <span className="mx-1 h-5 w-px bg-slate-700" aria-hidden="true" />
        <button type="button" onClick={() => setZoom((v) => clampZoom(v - 0.1))} className="rounded p-1 text-slate-300 hover:bg-slate-800"><Minus className="h-4 w-4" /></button>
        <span className="w-12 text-center text-xs text-slate-400">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom((v) => clampZoom(v + 0.1))} className="rounded p-1 text-slate-300 hover:bg-slate-800"><Plus className="h-4 w-4" /></button>
        <button type="button" onClick={fitToWidth} className="rounded p-1 text-slate-300 hover:bg-slate-800"><Maximize2 className="h-4 w-4" /></button>
        <span className="text-xs text-slate-400">
          Page {activeIndex + 1} of {pages.length}
        </span>
        <button
          type="button"
          onClick={() => void exportEdited()}
          disabled={exporting}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
        >
          <Download className="h-4 w-4" />
          {exporting ? 'Exporting…' : 'Export Edited PDF'}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">

        {/* Left: page manager / thumbnails */}
        {showThumbs && (
          <aside className="w-44 shrink-0 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/70 p-2">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Pages</p>
              <button type="button" onClick={() => setShowThumbs(false)} title="Hide thumbnails" className="rounded p-0.5 text-slate-500 hover:text-white">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <ul className="space-y-3">
              {pages.map((page, index) => (
                <li
                  key={`${index}-${page.sourceIndex}`}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', String(index))}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = Number(e.dataTransfer.getData('text/plain'));
                    if (Number.isFinite(from)) movePage(from, index);
                  }}
                  className={`rounded-lg border p-1.5 transition ${index === activeIndex ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-700 hover:border-slate-500'}`}
                >
                  <button type="button" className="block w-full" onClick={() => setActiveIndex(index)}>
                    <canvas ref={(el) => { thumbRefs.current[index] = el; }} className="mx-auto block max-h-28 max-w-full bg-white shadow" />
                  </button>
                  <p className="mt-1 text-center text-[10px] text-slate-400">Page {index + 1}</p>
                  <div className="mt-1 flex justify-center gap-0.5">
                    <button type="button" title="Rotate counter-clockwise" onClick={() => rotatePage(index, false)} className="rounded p-0.5 text-slate-400 hover:text-white"><RotateCw className="h-3 w-3 -scale-x-100" /></button>
                    <button type="button" title="Rotate clockwise" onClick={() => rotatePage(index, true)} className="rounded p-0.5 text-slate-400 hover:text-white"><RotateCw className="h-3 w-3" /></button>
                    <button type="button" title="Duplicate page" onClick={() => duplicatePage(index)} className="rounded p-0.5 text-slate-400 hover:text-white"><FilePlus className="h-3 w-3" /></button>
                    <button type="button" title="Insert blank page after" onClick={() => insertBlank(index)} className="rounded p-0.5 text-slate-400 hover:text-white"><Plus className="h-3 w-3" /></button>
                    <button type="button" title="Delete page" onClick={() => deletePage(index)} className="rounded p-0.5 text-slate-400 hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
                  </div>
                  <div className="mt-1 flex justify-center gap-1">
                    <button type="button" disabled={index === 0} onClick={() => movePage(index, index - 1)} className="rounded p-0.5 text-slate-500 disabled:opacity-30"><ArrowUp className="h-3 w-3" /></button>
                    <button type="button" disabled={index === pages.length - 1} onClick={() => movePage(index, index + 1)} className="rounded p-0.5 text-slate-500 disabled:opacity-30"><ArrowDown className="h-3 w-3" /></button>
                  </div>
                </li>
              ))}
            </ul>
          </aside>
        )}
        {!showThumbs && (
          <button type="button" onClick={() => setShowThumbs(true)} title="Show thumbnails" className="self-start rounded border border-slate-700 p-1.5 text-slate-400 hover:text-white">
            <FilePlus className="h-4 w-4" />
          </button>
        )}

        {/* Center: continuous vertical canvas workspace */}
        <main className="min-w-0 flex-1">
          <div
            ref={scrollRef}
            className="flex max-h-full flex-col items-center gap-8 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900 p-8"
          >
            {pages.map((page, index) => (
              <div key={`${index}-${page.sourceIndex}`} className="shrink-0">
                <div className="mb-1.5 text-center text-[11px] text-slate-500">
                  Page {index + 1} · {page.rotation !== 0 ? `${page.rotation}°` : 'portrait'}
                  {page.overlays.length > 0 ? ` · ${page.overlays.length} annotation${page.overlays.length === 1 ? '' : 's'}` : ''}
                </div>
                <div
                  ref={(el) => { pageElRefs.current[index] = el; }}
                  onPointerDown={(e) => onPointerDown(e, index)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                  className={`relative cursor-crosshair ${index === activeIndex ? 'ring-2 ring-indigo-500/70' : ''}`}
                  style={{ touchAction: 'none' }}
                >
                  <canvas ref={(el) => { baseRefs.current[index] = el; }} className="block bg-white shadow-xl" />
                  <div ref={(el) => { textLayerRefs.current[index] = el; }} className="textLayer pointer-events-none" aria-hidden="true" />
                  <canvas ref={(el) => { overlayRefs.current[index] = el; }} className="pointer-events-auto absolute inset-0" />
                </div>
              </div>
            ))}
          </div>
        </main>

        {/* Right: contextual inspector */}
        <aside className="w-64 shrink-0 space-y-3 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-xs text-slate-300">
          {selection && selectedOverlay ? (
            <div className="rounded-lg border border-slate-800 p-2">
              <div className="mb-2 flex items-center justify-between">
                <p className="font-semibold uppercase tracking-wide text-slate-400">Selected</p>
                <button
                  type="button"
                  onClick={() => removeOverlay(selection.pageIndex, selection.overlayIndex)}
                  className="flex items-center gap-1 rounded bg-red-600 px-2 py-1 font-semibold text-white hover:bg-red-500"
                >
                  <Trash2 className="h-3 w-3" /> Delete
                </button>
              </div>
              <p className="text-slate-500">{selectedOverlay.kind} at ({Math.round(selectedOverlay.x)}, {Math.round(selectedOverlay.y)})</p>
              <p className="mt-1 text-slate-500">Drag to move · bottom-right handle resizes · Delete key removes.</p>
            </div>
          ) : (
            <p className="rounded-lg border border-slate-800 p-2 text-slate-500">Select an annotation to manage it, or pick a tool and click a page.</p>
          )}

          {(tool === 'text' || (selection && selectedOverlay?.kind === 'text')) && (
            <div className="space-y-2 rounded-lg border border-slate-800 p-2">
              <p className="font-semibold uppercase tracking-wide text-slate-400">Text</p>
              <input type="text" value={textContent} onChange={(e) => setTextContent(e.target.value)} placeholder="Text content" className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-100" />
              <div className="flex items-center justify-between">
                <span>Size</span>
                <input type="number" min={8} max={96} value={textSize} onChange={(e) => setTextSize(Number(e.target.value))} className="w-20 rounded border border-slate-700 bg-slate-800 px-2 py-1" />
              </div>
              <div className="flex items-center justify-between">
                <span>Color</span>
                <input type="color" value={textColor} onChange={(e) => setTextColor(e.target.value)} className="h-7 w-9 cursor-pointer rounded border border-slate-700 bg-slate-800 p-0.5" />
              </div>
              <div className="flex items-center justify-between">
                <span>Highlight bg</span>
                <input type="color" value={textFill === '#00000000' ? '#ffe9a8' : textFill} onChange={(e) => setTextFill(e.target.value)} className="h-7 w-9 cursor-pointer rounded border border-slate-700 bg-slate-800 p-0.5" />
                <button type="button" onClick={() => setTextFill('#00000000')} className="text-[10px] text-slate-500 underline">none</button>
              </div>
              <div className="flex gap-3">
                <label className="flex items-center gap-1"><input type="checkbox" checked={textBold} onChange={(e) => setTextBold(e.target.checked)} /> Bold</label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={textItalic} onChange={(e) => setTextItalic(e.target.checked)} /> Italic</label>
              </div>
              <select value={textAlign} onChange={(e) => setTextAlign(e.target.value as 'left' | 'center' | 'right')} className="w-full rounded border border-slate-700 bg-slate-800 px-1 py-1">
                <option value="left">Align left</option>
                <option value="center">Align center</option>
                <option value="right">Align right</option>
              </select>
            </div>
          )}

          {(tool === 'pen' || tool === 'highlight' || tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'arrow') && (
            <div className="space-y-2 rounded-lg border border-slate-800 p-2">
              <p className="font-semibold uppercase tracking-wide text-slate-400">Stroke</p>
              <div className="flex items-center justify-between">
                <span>Color</span>
                <input type="color" value={tool === 'highlight' ? highlightColor : shapeStroke} onChange={(e) => { if (tool === 'highlight') setHighlightColor(e.target.value); else setShapeStroke(e.target.value); }} className="h-7 w-9 cursor-pointer rounded border border-slate-700 bg-slate-800 p-0.5" />
              </div>
              <div className="flex items-center justify-between">
                <span>Width</span>
                <input type="range" min={1} max={20} step={0.5} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} className="w-32 accent-indigo-500" />
              </div>
              {(tool === 'rect' || tool === 'ellipse') && (
                <div className="flex items-center justify-between">
                  <span>Fill</span>
                  <div className="flex items-center gap-1">
                    <input type="color" value={shapeFill === 'transparent' ? '#ffffff' : shapeFill} onChange={(e) => setShapeFill(e.target.value)} className="h-7 w-9 cursor-pointer rounded border border-slate-700 bg-slate-800 p-0.5" />
                    <button type="button" onClick={() => setShapeFill('transparent')} className="text-[10px] text-slate-500 underline">none</button>
                  </div>
                </div>
              )}
            </div>
          )}


          {tool === 'whiteout' && (
            <div className="space-y-2 rounded-lg border border-slate-800 p-2">
              <p className="font-semibold uppercase tracking-wide text-slate-400">Redact</p>
              <p className="text-slate-500">Drag a box over text to cover it permanently in the exported PDF.</p>
              <div className="flex items-center justify-between">
                <span>Fill</span>
                <input type="color" value={whiteoutColor} onChange={(e) => setWhiteoutColor(e.target.value)} className="h-7 w-9 cursor-pointer rounded border border-slate-700 bg-slate-800 p-0.5" />
              </div>
            </div>
          )}

          {tool === 'stamp' && (
            <div className="space-y-2 rounded-lg border border-slate-800 p-2">
              <p className="font-semibold uppercase tracking-wide text-slate-400">Stamp image</p>
              <input
                ref={stampInputRef}
                type="file"
                accept=".png,.jpg,.jpeg,image/png,image/jpeg"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  const kind = /\.png$/i.test(file.name) ? 'png' : 'jpg';
                  void file.arrayBuffer().then((bytes) =>
                    setPendingStamp({ bytes: new Uint8Array(bytes).slice().buffer, kind })
                  );
                }}
              />
              <button type="button" onClick={() => stampInputRef.current?.click()} className="w-full rounded border border-slate-700 px-2 py-1.5 hover:border-indigo-500">
                {pendingStamp ? 'Replace stamp image' : 'Upload stamp image'}
              </button>
              {pendingStamp && <p className="text-slate-500">Click a page to place the stamp.</p>}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};

