// frontend/src/components/WordViewer.tsx
// .docx reader built on docx-preview.
//
// The rendered markup is a stack of `<section class="docx">` pages inside a
// `.docx-wrapper` container. The scroll container measures those page nodes
// directly (via getBoundingClientRect, so it does not matter which ancestor is
// the offset parent) to keep the "Page X of Y" indicator in sync.

import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, FileText, LoaderCircle, Upload } from 'lucide-react';
import { renderAsync } from 'docx-preview';

/** Page nodes emitted by docx-preview (`section.docx`) plus docxjs fallback. */
const PAGE_SELECTOR = '.docx-wrapper > section, .docx-wrapper .docx-page';

/** Pixels of tolerance used when deciding which page is "current". */
const PAGE_TOLERANCE = 24;

function collectPageNodes(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(PAGE_SELECTOR));
}

export const WordViewer: React.FC = () => {
  const [fileName, setFileName] = useState('');
  const [hasContent, setHasContent] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);

  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Scroll container that holds the rendered pages. */
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Container docx-preview renders the document body into. */
  const containerRef = useRef<HTMLDivElement>(null);
  /** Dedicated host for the stylesheet docx-preview injects. */
  const styleRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef(0);

  /**
   * Counts the rendered pages and works out which one the user is looking at
   * from the offset of each page relative to the scroll viewport.
   */
  const syncPageTracking = useCallback(() => {
    const pages = collectPageNodes(containerRef.current);
    setTotalPages(pages.length);

    const scroll = scrollRef.current;
    if (!scroll || pages.length === 0) {
      setCurrentPage(1);
      return;
    }

    const viewportTop = scroll.getBoundingClientRect().top + PAGE_TOLERANCE;
    let active = 1;
    pages.forEach((page, index) => {
      if (page.getBoundingClientRect().top <= viewportTop) active = index + 1;
    });
    setCurrentPage(active);
  }, []);

  /** Throttled scroll listener: page indexes are measured once per frame. */
  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      syncPageTracking();
    });
  }, [syncPageTracking]);

  // Re-measure when the window (and therefore each page's width) changes.
  useEffect(() => {
    const onResize = () => syncPageTracking();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.cancelAnimationFrame(scrollFrameRef.current);
    };
  }, [syncPageTracking]);

  const renderDocument = async (arrayBuffer: ArrayBuffer) => {
    const container = containerRef.current;
    if (!container) return;

    // Always clear the previously rendered document first.
    container.innerHTML = '';

    await renderAsync(arrayBuffer, container, styleRef.current ?? undefined, {
      breakPages: true,
      experimental: true,
      inWrapper: true,
      ignoreLastRenderedPageBreak: false,
      renderHeaders: true,
      renderFooters: true,
    });

    setHasContent(true);
    // Wait a frame so the pages have real geometry, then reset scroll and
    // re-count the pages.
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    syncPageTracking();
  };

  const handleOpenClick = () => {
    setError('');
    fileInputRef.current?.click();
  };

  const handleFileInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setError('');
    setFileName(file.name);
    setHasContent(false);
    setTotalPages(0);
    setCurrentPage(1);
    containerRef.current?.replaceChildren();

    try {
      setIsLoading(true);
      const bytes = new Uint8Array(await file.arrayBuffer()).slice();
      await renderDocument(bytes.buffer);
    } catch (err) {
      setError(
        `Could not parse "${file.name}": ${
          err instanceof Error ? err.message : 'the file is not a valid .docx document'
        }`
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-6 text-slate-100">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-6 w-6 text-indigo-400" />
          <h2 className="text-xl font-bold">Word Document Viewer</h2>
        </div>
        <button
          type="button"
          onClick={handleOpenClick}
          disabled={isLoading}
          className="flex cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Upload className="h-4 w-4" />
          Choose .docx File
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".docx"
          onChange={handleFileInput}
          className="hidden"
        />
      </div>

      {fileName && (
        <p className="mb-4 text-xs font-semibold text-indigo-300">Viewing: {fileName}</p>
      )}

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-300">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="max-h-[80vh] min-h-[400px] overflow-y-auto rounded-xl border border-slate-800 bg-slate-900 p-6 text-slate-200"
      >
        {totalPages > 0 && (
          <div className="sticky top-0 z-10 mb-4 border-b border-slate-700 bg-slate-900/95 px-2 py-2 text-xs font-semibold text-slate-300 backdrop-blur">
            Page {currentPage} of {totalPages}
          </div>
        )}
        {isLoading && (
          <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-3 text-slate-400">
            <LoaderCircle className="h-8 w-8 animate-spin text-indigo-400" />
            <p className="text-sm">Parsing document contents…</p>
          </div>
        )}
        {!isLoading && !hasContent && (
          <p className="text-slate-500 italic">Select a .docx file to view its contents.</p>
        )}

        {/* docx-preview writes its generated stylesheet into this host. */}
        <div ref={styleRef} className="hidden" aria-hidden="true" />
        {/* Document pages are rendered here as `.docx-wrapper > section`. */}
        <div ref={containerRef} className="wv-pages" />
      </div>
    </div>
  );
};

