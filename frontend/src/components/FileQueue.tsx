import React, { useRef } from 'react';
import {
  ChevronDown,
  ChevronUp,
  FileText,
  FolderOpen,
  GripVertical,
  Plus,
  Trash2,
  X,
} from 'lucide-react';

export interface QueuedFile {
  name: string;
  /** Absolute OS-native path (from Electron webUtils) or undefined in a browser. */
  path?: string;
}

interface FileQueueProps {
  title: string;
  /** Native `<input accept>` string, e.g. ".pdf,application/pdf". */
  accept: string;
  files: QueuedFile[];
  onAddFiles: (files: QueuedFile[]) => void;
  onRemoveFile: (index: number) => void;
  onClear: () => void;
  /** Move one row to another index (clamped). Also used by drag & drop. */
  onMove: (fromIndex: number, toIndex: number) => void;
  multiple?: boolean;
  emptyHint?: string;
  disabled?: boolean;
}

/** Last path segment helper that understands both Windows and POSIX separators. */
function dirName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash) : filePath;
}

function resolvePathForFile(file: File): string | undefined {
  const bridge = (window as unknown as { electron?: { getPathForFile?: (f: File) => string } }).electron;
  if (bridge?.getPathForFile) {
    try {
      return bridge.getPathForFile(file);
    } catch {
      /* fall back to the legacy File.path below */
    }
  }
  return (file as unknown as { path?: string }).path;
}

/** Allowed extensions extracted from an `accept` attribute (e.g. ".pdf"). */
function allowedExtensions(accept: string): string[] {
  return accept
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.startsWith('.'));
}

/**
 * Appendable, reorderable file queue used by the PDF suite. Clicking "Add More
 * Files…" opens the OS picker again without clearing existing entries, so users
 * can assemble files from several folders before running an action.
 */
export const FileQueue: React.FC<FileQueueProps> = ({
  title,
  accept,
  files,
  onAddFiles,
  onRemoveFile,
  onClear,
  onMove,
  multiple = true,
  emptyHint = 'No files selected yet.',
  disabled = false,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragIndexRef = useRef<number | null>(null);

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (picked.length === 0) return;

    const extensions = allowedExtensions(accept);
    const added = picked
      .filter(
        (file) =>
          extensions.length === 0 ||
          extensions.includes(`.${file.name.split('.').pop()?.toLowerCase()}`)
      )
      .map((file) => ({
        name: file.name,
        path: resolvePathForFile(file),
      }));
    onAddFiles(added);
  };

  const openPicker = () => {
    if (disabled) return;
    inputRef.current?.click();
  };

  const move = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    onMove(fromIndex, toIndex);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</p>
        {files.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            className="flex items-center gap-1 text-xs font-medium text-slate-400 transition hover:text-red-400 disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" /> Clear all
          </button>
        )}
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
        {files.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <FolderOpen className="h-8 w-8 text-indigo-400/80" />
            <p className="text-sm text-slate-400">{emptyHint}</p>
            <button
              type="button"
              onClick={openPicker}
              disabled={disabled}
              className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
            >
              <Plus className="h-4 w-4" /> Select Files…
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <ul className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
              {files.map((file, index) => (
                <li
                  key={`${file.path ?? file.name}-${index}`}
                  draggable={!disabled}
                  onDragStart={(event) => {
                    dragIndexRef.current = index;
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const from = dragIndexRef.current;
                    dragIndexRef.current = null;
                    if (from !== null) move(from, index);
                  }}
                  className={`group flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs ${
                    disabled ? '' : 'cursor-grab hover:border-indigo-500/60'
                  }`}
                >
                  <GripVertical className="h-4 w-4 shrink-0 text-slate-600" />
                  <FileText className="h-4 w-4 shrink-0 text-indigo-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-slate-200" title={file.name}>
                      <span className="mr-1.5 text-slate-500">{index + 1}.</span>
                      {file.name}
                    </p>
                    {file.path ? (
                      <p className="truncate text-[10px] text-slate-500" title={file.path}>
                        {dirName(file.path)}
                      </p>
                    ) : (
                      <p className="text-[10px] italic text-amber-400/80">
                        path unavailable in browser mode
                      </p>
                    )}
                  </div>
                  <span className="hidden items-center gap-0.5 group-hover:flex">
                    <button
                      type="button"
                      title="Move up"
                      aria-label={`Move ${file.name} up`}
                      onClick={() => move(index, index - 1)}
                      disabled={disabled || index === 0}
                      className="rounded p-1 text-slate-500 transition hover:bg-slate-700 hover:text-white disabled:opacity-30"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Move down"
                      aria-label={`Move ${file.name} down`}
                      onClick={() => move(index, index + 1)}
                      disabled={disabled || index === files.length - 1}
                      className="rounded p-1 text-slate-500 transition hover:bg-slate-700 hover:text-white disabled:opacity-30"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Remove"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => onRemoveFile(index)}
                      disabled={disabled}
                      className="rounded p-1 text-slate-500 transition hover:bg-red-500/20 hover:text-red-400 disabled:opacity-30"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2 border-t border-slate-800 pt-2">
              <button
                type="button"
                onClick={openPicker}
                disabled={disabled}
                className="flex items-center gap-1.5 rounded-lg border border-indigo-500/50 bg-indigo-500/10 px-3 py-1.5 text-xs font-semibold text-indigo-300 transition hover:bg-indigo-500/20 disabled:opacity-60"
              >
                <Plus className="h-3.5 w-3.5" />
                Add More Files…
              </button>
              <span className="text-[11px] text-slate-500">
                {multiple
                  ? 'Drag rows to change the order. Files from any folder can be appended.'
                  : 'Keep adding until your list is complete.'}
              </span>
            </div>
          </div>
        )}

        {/* Hidden native picker; clicking the buttons re-opens it every time. */}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={handleInputChange}
          className="hidden"
          tabIndex={-1}
        />
      </div>
    </div>
  );
};
