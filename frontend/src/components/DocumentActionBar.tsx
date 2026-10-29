// frontend/src/components/DocumentActionBar.tsx
// Shared top action bar for the PDF reader (`PdfViewer`) and the PDF editor
// (`PdfEditor`): back navigation, "choose another PDF", page bookmarking with
// localStorage persistence, and a strip of recommended PDF tools.
//
// Layout notes: every row is `flex` + `min-w-0` + horizontal scrolling, so the
// bar stays a single compact band on a 360 px Android phone and still shows
// labels from `sm` upwards on tablets/desktop.

import type { ComponentType } from 'react';
import {
  Archive,
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
  FileText,
  FolderOpen,
  Images,
  Layers,
  Scissors,
  SquarePen,
  Trash2,
} from 'lucide-react';

/** Subset of the dashboard's tools offered as quick links next to a document. */
export type RecommendedToolId =
  | 'split-pdf'
  | 'compress-pdf'
  | 'merge-pdf'
  | 'convert-pdf-images'
  | 'edit-pdf';

interface RecommendedTool {
  id: RecommendedToolId;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

const RECOMMENDED_TOOLS: RecommendedTool[] = [
  { id: 'split-pdf', label: 'Split', icon: Scissors },
  { id: 'compress-pdf', label: 'Compress', icon: Archive },
  { id: 'merge-pdf', label: 'Merge', icon: Layers },
  { id: 'convert-pdf-images', label: 'PDF → Images', icon: Images },
  { id: 'edit-pdf', label: 'Edit', icon: SquarePen },
];

export interface DocumentActionBarProps {
  /** Open document name — bookmarks are stored per file name. */
  fileName: string;
  /** Page currently in view (1-based). */
  currentPage: number;
  /** Total pages of the open document; `0` disables the bookmark controls. */
  pageCount: number;
  /** Bookmarked pages of the open document, ascending. */
  bookmarks: number[];
  /** Adds/removes the current page as a bookmark. */
  onToggleBookmark: (page: number) => void;
  /** Removes every bookmark of the open document. */
  onClearBookmarks?: () => void;
  /** Opens the host's PDF file picker. */
  onChooseFile: () => void;
  /** Returns to the dashboard/tools view; the button is hidden when omitted. */
  onBack?: () => void;
  /** Jumps to a bookmarked page; chips are rendered disabled when omitted. */
  onJumpToPage?: (page: number) => void;
  /** Opens one of the dashboard's PDF tools; the strip is hidden when omitted. */
  onOpenTool?: (toolId: RecommendedToolId) => void;
  className?: string;
}

export const DocumentActionBar: React.FC<DocumentActionBarProps> = ({
  fileName,
  currentPage,
  pageCount,
  bookmarks,
  onToggleBookmark,
  onClearBookmarks,
  onChooseFile,
  onBack,
  onJumpToPage,
  onOpenTool,
  className = '',
}) => {
  const totalPages = Math.max(0, Math.trunc(pageCount));
  const hasDocument = totalPages > 0;
  const page = hasDocument ? Math.min(Math.max(Math.trunc(currentPage) || 1, 1), totalPages) : 1;
  const isMarked = hasDocument && bookmarks.includes(page);
  const showFooter = bookmarks.length > 0 || Boolean(onOpenTool);

  return (
    <div
      role="toolbar"
      aria-label="Document actions"
      className={`space-y-2 rounded-xl border border-slate-800 bg-slate-950/70 p-2 sm:p-2.5 ${className}`}
    >
      <div className="flex items-center gap-1.5 sm:gap-2">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            title="Back to the tools dashboard"
            aria-label="Back to the tools dashboard"
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-2 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-white sm:px-2.5"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Back</span>
          </button>
        )}

        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <FileText className="hidden h-4 w-4 shrink-0 text-indigo-400 sm:block" />
          <span
            className="min-w-0 truncate text-xs font-medium text-slate-200"
            title={fileName || undefined}
          >
            {fileName || 'No document open'}
          </span>
          {hasDocument && (
            <span className="shrink-0 rounded-full border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400">
              {page}/{totalPages}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onToggleBookmark(page)}
            disabled={!hasDocument}
            aria-pressed={isMarked}
            title={
              hasDocument
                ? isMarked
                  ? `Remove the bookmark on page ${page}`
                  : `Bookmark page ${page}`
                : 'Open a PDF to bookmark pages'
            }
            aria-label={isMarked ? `Remove bookmark on page ${page}` : `Bookmark page ${page}`}
            className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 sm:px-2.5 ${
              isMarked
                ? 'border-amber-400/60 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20'
                : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white'
            }`}
          >
            {isMarked ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
            <span className="hidden sm:inline">{isMarked ? 'Bookmarked' : 'Bookmark'}</span>
          </button>

          <button
            type="button"
            onClick={onChooseFile}
            title="Choose another PDF"
            aria-label="Choose another PDF"
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 sm:px-2.5"
          >
            <FolderOpen className="h-4 w-4" />
            <span className="hidden sm:inline">Choose another PDF</span>
          </button>
        </div>
      </div>

      {showFooter && (
        <div className="flex flex-col gap-2 border-t border-slate-800/80 pt-2 lg:flex-row lg:items-center lg:gap-3">
          {bookmarks.length > 0 && (
            <div className="flex min-w-0 items-center gap-1.5 lg:max-w-[45%]">
              <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-400/80">
                <Bookmark className="h-3 w-3" /> Marks
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pb-0.5">
                {bookmarks.map((bookmark) => (
                  <button
                    key={bookmark}
                    type="button"
                    onClick={() => onJumpToPage?.(bookmark)}
                    disabled={!onJumpToPage}
                    title={
                      onJumpToPage ? `Go to page ${bookmark}` : `Page ${bookmark} is bookmarked`
                    }
                    aria-label={`Go to bookmarked page ${bookmark}`}
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition disabled:opacity-70 ${
                      bookmark === page
                        ? 'border-amber-400/70 bg-amber-400/15 text-amber-200'
                        : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-amber-400/50 hover:text-white'
                    }`}
                  >
                    {bookmark}
                  </button>
                ))}
              </div>
              {onClearBookmarks && (
                <button
                  type="button"
                  onClick={onClearBookmarks}
                  title="Remove every bookmark on this document"
                  aria-label="Remove every bookmark on this document"
                  className="shrink-0 rounded p-1 text-slate-500 transition hover:bg-slate-800 hover:text-red-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}

          {onOpenTool && (
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Tools
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pb-0.5">
                {RECOMMENDED_TOOLS.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => onOpenTool(tool.id)}
                    title={`Open ${tool.label}`}
                    className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:border-indigo-500/60 hover:text-white"
                  >
                    <tool.icon className="h-3 w-3 text-indigo-400" />
                    {tool.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

