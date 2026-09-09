import React, { useRef, useState } from 'react';
import { CloudUpload, FileText, X } from 'lucide-react';

export interface DroppedPdfFile {
  name: string;
  path?: string;
}

interface PdfDropZoneProps {
  files: DroppedPdfFile[];
  onAddFiles: (files: DroppedPdfFile[]) => void;
  onRemoveFile: (index: number) => void;
  onClearFiles: () => void;
}

type ElectronBridge = { getPathForFile?: (file: File) => string };

function resolvePathForFile(file: File): string | undefined {
  const bridge = (window as unknown as { electron?: ElectronBridge }).electron;
  if (bridge?.getPathForFile) {
    try {
      return bridge.getPathForFile(file);
    } catch {
      /* fall back to the legacy File.path below */
    }
  }
  return (file as unknown as { path?: string }).path;
}

const hasFiles = (event: React.DragEvent): boolean =>
  Boolean(event.dataTransfer?.types?.includes('Files'));

export const PdfDropZone: React.FC<PdfDropZoneProps> = ({
  files,
  onAddFiles,
  onRemoveFile,
  onClearFiles,
}) => {
  const [isDragActive, setIsDragActive] = useState(false);
  const dragDepth = useRef(0);

  const setDragActive = (active: boolean) => {
    dragDepth.current = Math.max(0, dragDepth.current + (active ? 1 : -1));
    setIsDragActive(dragDepth.current > 0);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);

    const dropped = Array.from(event.dataTransfer.files || [])
      .filter((file) => file.name.toLowerCase().endsWith('.pdf'))
      .map((file) => ({
        name: file.name,
        path: resolvePathForFile(file),
      }));
    if (dropped.length === 0) return;
    onAddFiles(dropped);
  };

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        if (hasFiles(event)) setDragActive(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        setDragActive(false);
      }}
      onDrop={handleDrop}
      className={`rounded-2xl border-2 border-dashed p-6 transition ${
        isDragActive
          ? 'border-indigo-400 bg-indigo-500/10'
          : 'border-slate-700 bg-slate-900/60 hover:border-slate-500'
      }`}
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <span
          className={`flex h-12 w-12 items-center justify-center rounded-full transition ${
            isDragActive ? 'bg-indigo-500/30 text-indigo-300' : 'bg-slate-800 text-slate-400'
          }`}
        >
          <CloudUpload className="h-6 w-6" />
        </span>
        <div>
          <p className="text-sm font-semibold text-slate-200">
            {isDragActive ? 'Release to add the PDFs' : 'Drag & drop PDF files here'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            No file dialog needed. Drop one or several PDFs, then run an action below.
          </p>
        </div>
      </div>

      {files.length > 0 && (
        <div className="mt-5 space-y-2 border-t border-slate-800 pt-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {files.length} PDF{files.length === 1 ? '' : 's'} ready
            </p>
            <button
              type="button"
              onClick={onClearFiles}
              className="text-xs font-medium text-slate-400 transition hover:text-red-400"
            >
              Clear all
            </button>
          </div>

          <ul className="max-h-32 space-y-1.5 overflow-y-auto">
            {files.map((file, index) => (
              <li
                key={`${file.path ?? file.name}-${index}`}
                className="flex items-center gap-2 rounded-lg bg-slate-800/70 px-3 py-2 text-xs text-slate-300"
              >
                <FileText className="h-4 w-4 shrink-0 text-indigo-400" />
                <span className="flex-1 truncate" title={file.name}>
                  {file.name}
                </span>
                {!file.path && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400">
                    path unavailable
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => onRemoveFile(index)}
                  className="rounded p-0.5 text-slate-500 transition hover:bg-slate-700 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>

          <p className="pt-1 text-[11px] leading-relaxed text-slate-500">
            Split, Compress and PDF→Images act on the first dropped file. Merge
            combines every dropped PDF in the listed order.
          </p>
        </div>
      )}
    </div>
  );
};
