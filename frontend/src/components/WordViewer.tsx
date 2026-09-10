import React, { useRef, useState } from 'react';
import { CircleAlert, FileText, LoaderCircle, Upload } from 'lucide-react';
import mammoth from 'mammoth';
import DOMPurify from 'dompurify';

/**
 * Sanitize mammoth-generated HTML before it is injected with
 * dangerouslySetInnerHTML. DOMPurify strips active content (scripts, event
 * handlers, embedded objects…); the post-pass below additionally restricts
 * every URL attribute to a strict allow-list of schemes — http/https/mailto
 * or inline base64 PNG/JPEG images — so nothing unsanitized is ever returned.
 */
const SAFE_LINK_SCHEMES = ['http:', 'https:', 'mailto:'];
const SAFE_IMAGE_DATA_PREFIXES = [
  'data:image/png;base64,',
  'data:image/jpeg;base64,',
  'data:image/jpg;base64,',
];
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href']);

function isAllowedUrl(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('#')) return true; // in-page anchors
  if (SAFE_LINK_SCHEMES.some((scheme) => normalized.startsWith(scheme))) return true;
  return SAFE_IMAGE_DATA_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function sanitizeWordHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
  });

  const parsed = new DOMParser().parseFromString(clean, 'text/html');
  parsed.querySelectorAll('*').forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (URL_ATTRIBUTES.has(name) && !isAllowedUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    });
  });

  return parsed.body ? parsed.body.innerHTML : '';
}

export const WordViewer: React.FC = () => {
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [pageCount, setPageCount] = useState(0);
  const [activePage, setActivePage] = useState(1);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const updatePageTracking = (hasContent = Boolean(content)) => {
    const container = previewRef.current;
    if (!container) return;
    const sections = Array.from(
      container.querySelectorAll<HTMLElement>('.docx-wrapper > section')
    );
    const total = sections.length || (hasContent ? 1 : 0);
    setPageCount(total);
    if (total === 0) {
      setActivePage(1);
      return;
    }

    const viewportTop = container.scrollTop + 24;
    let current = 0;
    sections.forEach((section, index) => {
      if (section.offsetTop <= viewportTop) current = index;
    });
    setActivePage(Math.min(current + 1, total));
  };

  const renderDocument = async (arrayBuffer: ArrayBuffer) => {
    const isolatedBytes = new Uint8Array(arrayBuffer).slice();
    const result = await mammoth.convertToHtml({ arrayBuffer: isolatedBytes.buffer });
    setContent(sanitizeWordHtml(result.value));
    requestAnimationFrame(() => {
      previewRef.current?.scrollTo({ top: 0 });
      updatePageTracking(true);
    });
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
        ref={previewRef}
        onScroll={() => updatePageTracking()}
        className="max-h-[68vh] min-h-[400px] overflow-y-auto rounded-xl border border-slate-800 bg-slate-900 p-6 text-slate-200"
      >
        {pageCount > 0 && (
          <div className="sticky top-0 z-10 mb-4 border-b border-slate-700 bg-slate-900/95 px-2 py-2 text-xs font-semibold text-slate-300 backdrop-blur">
            Page {activePage} of {pageCount}
          </div>
        )}
        {isLoading ? (
          <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-3 text-slate-400">
            <LoaderCircle className="h-8 w-8 animate-spin text-indigo-400" />
            <p className="text-sm">Parsing document contents…</p>
          </div>
        ) : content ? (
          <div className="docx-wrapper wv-content" dangerouslySetInnerHTML={{ __html: content }} />
        ) : (
          <p className="text-slate-500 italic">Select a .docx file to view its contents.</p>
        )}
      </div>
    </div>
  );
};

