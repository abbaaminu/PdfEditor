import React, { useState } from 'react';
import type { ComponentType } from 'react';
import {
  Archive,
  ArrowLeft,
  FileText,
  FileType,
  Image as ImageIcon,
  Layers,
  LoaderCircle,
  Play,
  Scissors,
  SquarePen,
} from 'lucide-react';
import { WordToPdfPanel } from './WordToPdfPanel';
import { PdfEditor } from './PdfEditor';
import { FREE_TRIAL_LIMIT_MESSAGE, MAX_FREE_USES, useAuthStore } from '../store/auth-context';
import { FileQueue } from './FileQueue';
import type { QueuedFile } from './FileQueue';
import { convertPdfToImages } from '../lib/pdfRenderer';

export type PdfToolId =
  | 'split-pdf'
  | 'compress-pdf'
  | 'merge-pdf'
  | 'convert-pdf-images'
  | 'images-to-pdf'
  | 'word-to-pdf'
  | 'edit-pdf';

interface PdfToolDef {
  id: PdfToolId;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

const PDF_TOOLS: PdfToolDef[] = [
  {
    id: 'split-pdf',
    label: 'Split PDF',
    description: 'Extract page ranges, split every N pages, or save every page separately.',
    icon: Scissors,
  },
  {
    id: 'compress-pdf',
    label: 'Compress PDF',
    description: 'Re-compress raster images with quality, DPI and JPEG controls.',
    icon: Archive,
  },
  {
    id: 'merge-pdf',
    label: 'Merge PDFs',
    description: 'Queue PDFs from any folders, reorder, then combine into one file.',
    icon: Layers,
  },
  {
    id: 'convert-pdf-images',
    label: 'PDF to Images',
    description: 'Extract pages from one or many PDFs as PNG/JPEG with DPI + quality.',
    icon: ImageIcon,
  },
  {
    id: 'images-to-pdf',
    label: 'Images to PDF',
    description: 'Assemble images from any folders with page size, orientation & margins.',
    icon: FileText,
  },
  {
    id: 'word-to-pdf',
    label: 'Word to PDF',
    description: 'Convert .docx files into clean PDF documents.',
    icon: FileType,
  },
  {
    id: 'edit-pdf',
    label: 'PDF Editor',
    description: 'Annotate, watermark, rotate, reorder and delete pages, then export.',
    icon: SquarePen,
  },
];

type SplitMode = 'extract' | 'every-n' | 'all';
type CompressionPreset = 'low' | 'medium' | 'high';
type DpiSelection = 72 | 150 | 300 | 'auto';
type PageSizeKey = 'a4' | 'letter' | 'fit';
type OrientationKey = 'auto' | 'portrait' | 'landscape';
type MarginKey = 'none' | 'small' | 'large';
type ImageFormat = 'png' | 'jpeg';

interface SegOption<T extends string | number> {
  value: T;
  label: string;
}

/** Small segmented-button group used across the option rows. */
function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-slate-950/60 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:opacity-60 ${
            value === option.value
              ? 'bg-indigo-600 text-white'
              : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface PdfToolsProps {
  /** Which tools are currently processing (drives run-button spinners). */
  busy: Partial<Record<PdfToolId, boolean>>;
  /** Executes a tool after applying the app's trial gating. */
  onRunTool: (opId: PdfToolId, files: QueuedFile[], options: Record<string, unknown>) => void;
  /** Opens the upgrade modal when a free-trial gate blocks a client-side tool. */
  onRequireUpgrade?: (message?: string) => void;
}

const COMPRESSION_PRESETS: SegOption<CompressionPreset>[] = [
  { value: 'low', label: 'Low (High Quality)' },
  { value: 'medium', label: 'Medium (Balanced)' },
  { value: 'high', label: 'High (Max Compression)' },
];

/** Front-end compression presets used by the browser-side tool flow. */
const COMPRESSION_TO_PRESET: Record<CompressionPreset, string> = {
  low: 'printer',
  medium: 'ebook',
  high: 'screen',
};

const DPI_OPTIONS: SegOption<DpiSelection>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 72, label: '72 DPI' },
  { value: 150, label: '150 DPI' },
  { value: 300, label: '300 DPI' },
];

const PAGE_SIZE_OPTIONS: SegOption<PageSizeKey>[] = [
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: 'US Letter' },
  { value: 'fit', label: 'Fit to Image' },
];

const ORIENTATION_OPTIONS: SegOption<OrientationKey>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
];

const MARGIN_OPTIONS: SegOption<MarginKey>[] = [
  { value: 'none', label: 'None' },
  { value: 'small', label: 'Small' },
  { value: 'large', label: 'Large' },
];

const FORMAT_OPTIONS: SegOption<ImageFormat>[] = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
];

const OUTPUT_DPI_OPTIONS: SegOption<number>[] = [
  { value: 72, label: '72 DPI' },
  { value: 150, label: '150 DPI' },
  { value: 300, label: '300 DPI' },
];

/** Shared file-queue + run plumbing handed to each tool panel. */
interface QueuePanelProps {
  files: QueuedFile[];
  processing: boolean;
  onAddFiles: (files: QueuedFile[]) => void;
  onRemoveFile: (index: number) => void;
  onClear: () => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onRun: (options: Record<string, unknown>) => void;
}

function ActionRunButton({
  label,
  processing,
  disabled,
  onClick,
}: {
  label: string;
  processing: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || processing}
      className="flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {processing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
      {processing ? 'Processing…' : label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Split PDF                                                            */
/* ------------------------------------------------------------------ */
function SplitPanel({
  files,
  processing,
  onAddFiles,
  onRemoveFile,
  onClear,
  onMove,
  onRun,
}: QueuePanelProps) {
  const [mode, setMode] = useState<SplitMode>('all');
  const [rangesText, setRangesText] = useState('1-3, 5, 8-12');
  const [everyN, setEveryN] = useState(2);

  const options: Record<string, unknown> =
    mode === 'extract'
      ? { mode: 'extract', rangesText: rangesText.trim() || undefined }
      : mode === 'every-n'
        ? { mode: 'every-n', everyN }
        : { mode: 'all' };

  return (
    <div className="space-y-4">
      <FileQueue
        title="Source PDF"
        accept=".pdf,application/pdf"
        files={files}
        onAddFiles={onAddFiles}
        onRemoveFile={onRemoveFile}
        onClear={onClear}
        onMove={onMove}
        multiple={false}
        emptyHint="Select the PDF you want to split."
        disabled={processing}
      />

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Split mode</p>
        <Segmented<SplitMode>
          options={[
            { value: 'extract', label: 'Extract Page Ranges' },
            { value: 'every-n', label: 'Split Every N Pages' },
            { value: 'all', label: 'Split All Pages' },
          ]}
          value={mode}
          onChange={setMode}
        />
      </div>

      {mode === 'extract' && (
        <div className="space-y-1.5">
          <label
            htmlFor="split-ranges"
            className="block text-xs font-semibold uppercase tracking-wide text-slate-400"
          >
            Page ranges (e.g. 1-3, 5, 8-12)
          </label>
          <input
            id="split-ranges"
            type="text"
            value={rangesText}
            onChange={(event) => setRangesText(event.target.value)}
            placeholder="1-3, 5, 8-12"
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      )}

      {mode === 'every-n' && (
        <div className="space-y-1.5">
          <label
            htmlFor="split-every"
            className="block text-xs font-semibold uppercase tracking-wide text-slate-400"
          >
            Pages per chunk
          </label>
          <input
            id="split-every"
            type="number"
            min={1}
            max={999}
            value={everyN}
            onChange={(event) => setEveryN(Math.max(1, Number(event.target.value) || 1))}
            className="w-32 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      )}

      <ActionRunButton
        label="Split PDF"
        processing={processing}
        disabled={files.length === 0}
        onClick={() => onRun(options)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Compress PDF                                                         */
/* ------------------------------------------------------------------ */
function CompressPanel({
  files,
  processing,
  onAddFiles,
  onRemoveFile,
  onClear,
  onMove,
  onRun,
}: QueuePanelProps) {
  const [preset, setPreset] = useState<CompressionPreset>('medium');
  const [dpi, setDpi] = useState<DpiSelection>('auto');
  const [quality, setQuality] = useState(70);

  const options: Record<string, unknown> = {
    preset: COMPRESSION_TO_PRESET[preset],
    dpi: dpi === 'auto' ? undefined : dpi,
    quality,
  };

  return (
    <div className="space-y-4">
      <FileQueue
        title="Source PDF"
        accept=".pdf,application/pdf"
        files={files}
        onAddFiles={onAddFiles}
        onRemoveFile={onRemoveFile}
        onClear={onClear}
        onMove={onMove}
        multiple={false}
        emptyHint="Select the PDF to compress (the first queued file is used)."
        disabled={processing}
      />

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Quality preset
        </p>
        <Segmented<CompressionPreset>
          options={COMPRESSION_PRESETS}
          value={preset}
          onChange={setPreset}
        />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Downsample embedded images to
        </p>
        <Segmented<DpiSelection> options={DPI_OPTIONS} value={dpi} onChange={setDpi} />
        {dpi !== 'auto' && (
          <p className="text-[11px] text-slate-500">
            Force color/gray raster images to {dpi} DPI before re-encoding.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label
          htmlFor="compress-quality"
          className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-400"
        >
          <span>JPEG quality</span>
          <span className="rounded bg-slate-800 px-2 py-0.5 text-indigo-300">{quality}%</span>
        </label>
        <input
          id="compress-quality"
          type="range"
          min={10}
          max={90}
          step={5}
          value={quality}
          onChange={(event) => setQuality(Number(event.target.value))}
          className="w-full accent-indigo-500"
        />
        <p className="text-[11px] text-slate-500">
          Lower values compress more aggressively (10% smallest, 90% highest fidelity).
        </p>
      </div>

      <ActionRunButton
        label="Compress PDF"
        processing={processing}
        disabled={files.length === 0}
        onClick={() => onRun(options)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Merge PDFs                                                           */
/* ------------------------------------------------------------------ */
function MergePanel({
  files,
  processing,
  onAddFiles,
  onRemoveFile,
  onClear,
  onMove,
  onRun,
}: QueuePanelProps) {
  return (
    <div className="space-y-4">
      <FileQueue
        title="Merge queue (in page order)"
        accept=".pdf,application/pdf"
        files={files}
        onAddFiles={onAddFiles}
        onRemoveFile={onRemoveFile}
        onClear={onClear}
        onMove={onMove}
        emptyHint="Pick at least two PDFs. Add files from several folders, then drag them into order."
        disabled={processing}
      />
      <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-500">
        Files are merged top-to-bottom. Each “Add More Files…” dialog can come from a
        completely different folder.
      </div>
      <ActionRunButton
        label="Merge PDFs"
        processing={processing}
        disabled={files.length < 2}
        onClick={() => onRun({})}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PDF to Images                                                        */
/* ------------------------------------------------------------------ */
function PdfToImagePanel({
  files,
  processing,
  onAddFiles,
  onRemoveFile,
  onClear,
  onMove,
}: QueuePanelProps) {
  const [format, setFormat] = useState<ImageFormat>('png');
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(80);

  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, file: 0, files: 0 });
  const [conversionError, setConversionError] = useState('');

  const downloadImage = async (dataUrl: string, fileName: string, pageNumber: number) => {
    let outputUrl = dataUrl;
    let extension = 'png';

    if (format === 'jpeg') {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas rendering is unavailable in this environment.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      outputUrl = canvas.toDataURL('image/jpeg', quality / 100);
      extension = 'jpg';
    }

    const link = document.createElement('a');
    link.href = outputUrl;
    link.download = `${fileName.replace(/\.pdf$/i, '')}-page-${pageNumber}.${extension}`;
    link.click();
  };

  const handleConvert = async () => {
    const sourceFiles = files
      .map((queuedFile) => queuedFile.file)
      .filter((file): file is File => Boolean(file));
    if (sourceFiles.length !== files.length) {
      setConversionError('Please select the PDFs again so they can be processed in the browser.');
      return;
    }

    setConverting(true);
    setConversionError('');
    setProgress({ current: 0, total: 0, file: 0, files: sourceFiles.length });

    try {
      for (let fileIndex = 0; fileIndex < sourceFiles.length; fileIndex += 1) {
        const sourceFile = sourceFiles[fileIndex];
        const images = await convertPdfToImages(sourceFile, dpi / 72, (current, total) => {
          setProgress({ current, total, file: fileIndex + 1, files: sourceFiles.length });
        });
        for (let pageIndex = 0; pageIndex < images.length; pageIndex += 1) {
          await downloadImage(images[pageIndex], sourceFile.name, pageIndex + 1);
        }
      }
    } catch (error) {
      setConversionError(error instanceof Error ? error.message : 'The PDF could not be converted.');
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="space-y-4">
      <FileQueue
        title="PDFs to convert"
        accept=".pdf,application/pdf"
        files={files}
        onAddFiles={onAddFiles}
        onRemoveFile={onRemoveFile}
        onClear={onClear}
        onMove={onMove}
        emptyHint="Pick one or several PDFs from any folders. Every page is exported."
        disabled={processing}
      />

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Target format
        </p>
        <Segmented<ImageFormat> options={FORMAT_OPTIONS} value={format} onChange={setFormat} />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Resolution</p>
        <Segmented<number>
          options={OUTPUT_DPI_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          value={dpi}
          onChange={(value) => setDpi(value)}
        />
      </div>

      {format === 'jpeg' && (
        <div className="space-y-2">
          <label
            htmlFor="pdf-image-quality"
            className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-400"
          >
            <span>JPEG quality</span>
            <span className="rounded bg-slate-800 px-2 py-0.5 text-indigo-300">{quality}%</span>
          </label>
          <input
            id="pdf-image-quality"
            type="range"
            min={10}
            max={90}
            step={5}
            value={quality}
            onChange={(event) => setQuality(Number(event.target.value))}
            className="w-full accent-indigo-500"
          />
        </div>
      )}

      <ActionRunButton
        label="Convert to Images"
        processing={processing || converting}
        disabled={files.length === 0}
        onClick={() => void handleConvert()}
      />

      {converting && progress.total > 0 && (
        <div className="space-y-1.5" aria-live="polite">
          <div className="flex justify-between text-xs text-slate-400">
            <span>
              Rendering file {progress.file} of {progress.files}
            </span>
            <span>
              Page {progress.current} of {progress.total}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full bg-indigo-500 transition-[width] duration-150"
              style={{ width: `${(progress.current / progress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {conversionError && <p className="text-sm text-red-300">{conversionError}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Images to PDF                                                        */
/* ------------------------------------------------------------------ */
function ImagesToPdfPanel({
  files,
  processing,
  onAddFiles,
  onRemoveFile,
  onClear,
  onMove,
  onRun,
}: QueuePanelProps) {
  const [pageSize, setPageSize] = useState<PageSizeKey>('a4');
  const [orientation, setOrientation] = useState<OrientationKey>('auto');
  const [margin, setMargin] = useState<MarginKey>('small');

  const options: Record<string, unknown> = { pageSize, orientation, margin };

  return (
    <div className="space-y-4">
      <FileQueue
        title="Images to assemble (in page order)"
        accept=".png,.jpg,.jpeg,image/png,image/jpeg"
        files={files}
        onAddFiles={onAddFiles}
        onRemoveFile={onRemoveFile}
        onClear={onClear}
        onMove={onMove}
        emptyHint="Add PNG/JPG images from any folders, then drag them into page order."
        disabled={processing}
      />

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Page size</p>
        <Segmented<PageSizeKey>
          options={PAGE_SIZE_OPTIONS}
          value={pageSize}
          onChange={setPageSize}
        />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Orientation
        </p>
        <Segmented<OrientationKey>
          options={ORIENTATION_OPTIONS}
          value={orientation}
          onChange={setOrientation}
        />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Page margins
        </p>
        <Segmented<MarginKey> options={MARGIN_OPTIONS} value={margin} onChange={setMargin} />
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-500">
        Each image is fitted and centered on its page. Choose “Fit to Image” to make the page
        match the picture exactly.
      </div>

      <ActionRunButton
        label="Assemble PDF"
        processing={processing}
        disabled={files.length === 0}
        onClick={() => onRun(options)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PdfTools container: tool grid + active configuration panel           */
/* ------------------------------------------------------------------ */
export const PdfTools: React.FC<PdfToolsProps> = ({ busy, onRunTool, onRequireUpgrade }) => {
  const { isProUser, usageCount, incrementUsage } = useAuthStore();
  const [active, setActive] = useState<PdfToolId | null>(null);
  const [queues, setQueues] = useState<Record<PdfToolId, QueuedFile[]>>({
    'split-pdf': [],
    'compress-pdf': [],
    'merge-pdf': [],
    'convert-pdf-images': [],
    'images-to-pdf': [],
    'word-to-pdf': [],
    'edit-pdf': [],
  });

  /** Trial gate shared by the client-side tools (Word→PDF, PDF Editor). */
  const canStartAction = (): boolean => {
    if (isProUser || usageCount < MAX_FREE_USES) return true;
    onRequireUpgrade?.(FREE_TRIAL_LIMIT_MESSAGE);
    return false;
  };

  const addFiles = (id: PdfToolId, incoming: QueuedFile[]) =>
    setQueues((current) => {
      const known = new Set(current[id].map((file) => file.name));
      const added = incoming.filter((file) => !known.has(file.name));
      return { ...current, [id]: [...current[id], ...added] };
    });

  const removeFile = (id: PdfToolId, index: number) =>
    setQueues((current) => ({
      ...current,
      [id]: current[id].filter((_, itemIndex) => itemIndex !== index),
    }));

  const clearQueue = (id: PdfToolId) =>
    setQueues((current) => ({ ...current, [id]: [] }));

  const moveFile = (id: PdfToolId, from: number, to: number) =>
    setQueues((current) => {
      const list = [...current[id]];
      if (from < 0 || from >= list.length || to < 0 || to >= list.length) return current;
      const [item] = list.splice(from, 1);
      list.splice(to, 0, item);
      return { ...current, [id]: list };
    });

  const activeDef = PDF_TOOLS.find((tool) => tool.id === active);

  const panelProps = (id: PdfToolId): QueuePanelProps => ({
    files: queues[id],
    processing: Boolean(busy[id]),
    onAddFiles: (incoming) => addFiles(id, incoming),
    onRemoveFile: (index) => removeFile(id, index),
    onClear: () => clearQueue(id),
    onMove: (from, to) => moveFile(id, from, to),
    onRun: (options) => onRunTool(id, queues[id], options),
  });

  // ---- Tool grid (nothing selected) ---------------------------------
  if (!active || !activeDef) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-bold">PDF Desktop Actions</h2>
          <p className="mt-1 text-sm text-slate-400">
            Pick a tool to configure its options and build its file queue.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {PDF_TOOLS.map((tool) => {
            const running = Boolean(busy[tool.id]);
            return (
              <button
                key={tool.id}
                type="button"
                onClick={() => setActive(tool.id)}
                className="group relative flex flex-col items-start gap-3 rounded-xl border border-slate-800 bg-slate-900 p-5 text-left transition hover:border-indigo-500"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-400">
                  {running ? (
                    <LoaderCircle className="h-5 w-5 animate-spin" />
                  ) : (
                    <tool.icon className="h-5 w-5" />
                  )}
                </span>
                <span>
                  <span className="block font-semibold">
                    {running ? 'Processing…' : tool.label}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-slate-400">
                    {tool.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ---- Active tool configuration panel -------------------------------
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setActive(null)}
          className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to all tools
        </button>
        <div className="flex items-center gap-2 text-slate-200">
          {(() => {
            const Icon = activeDef.icon;
            return <Icon className="h-4 w-4 text-indigo-400" />;
          })()}
          <h2 className="text-lg font-bold">{activeDef.label}</h2>
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5">
        {active === 'split-pdf' && <SplitPanel {...panelProps('split-pdf')} />}
        {active === 'compress-pdf' && <CompressPanel {...panelProps('compress-pdf')} />}
        {active === 'merge-pdf' && <MergePanel {...panelProps('merge-pdf')} />}
        {active === 'convert-pdf-images' && (
          <PdfToImagePanel {...panelProps('convert-pdf-images')} />
        )}
        {active === 'images-to-pdf' && (
          <ImagesToPdfPanel {...panelProps('images-to-pdf')} />
        )}
        {active === 'word-to-pdf' && (
          <WordToPdfPanel
            canStartAction={canStartAction}
            incrementUsage={incrementUsage}
          />
        )}
        {active === 'edit-pdf' && (
          <PdfEditor
            canStartAction={canStartAction}
            incrementUsage={incrementUsage}
          />
        )}
      </div>
    </div>
  );
};

