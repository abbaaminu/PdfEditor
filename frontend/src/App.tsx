import { useState } from 'react';
import {
  BadgeCheck,
  FilePlus,
  FileText,
  Scissors,
  Sparkles,
} from 'lucide-react';
import { DocumentCreator } from './components/DocumentCreator';
import type { QueuedFile } from './components/FileQueue';
import { PdfTools } from './components/PdfTools';
import type { PdfToolId } from './components/PdfTools';
import { PdfViewer } from './components/PdfViewer';
import { ToastProvider } from './components/Toast';
import { useToast } from './components/toast-context';
import { UpgradeModal } from './components/UpgradeModal';
import { WordViewer } from './components/WordViewer';
import { AuthProvider } from './store/AuthProvider';
import { FREE_TRIAL_LIMIT_MESSAGE, MAX_FREE_USES, useAuthStore } from './store/auth-context';
import { PDFDocument } from 'pdf-lib';

type TabId = 'pdf-tools' | 'pdf-viewer' | 'viewer' | 'creator';

type ToolId = PdfToolId;

type BusyMap = Partial<Record<ToolId, boolean>>;

function downloadPdf(bytes: Uint8Array, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function parsePageRanges(value: string, total: number): number[] {
  const pages = new Set<number>();
  value.split(',').forEach((part) => {
    const [startText, endText] = part.trim().split('-');
    const start = Math.max(1, Number.parseInt(startText, 10));
    const end = Math.min(total, Number.parseInt(endText ?? startText, 10));
    if (Number.isFinite(start) && Number.isFinite(end)) {
      for (let page = Math.min(start, end); page <= Math.max(start, end); page += 1) pages.add(page);
    }
  });
  return [...pages].sort((a, b) => a - b);
}

async function mergePdfFiles(files: File[]): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  for (const file of files) {
    const source = await PDFDocument.load(await file.arrayBuffer());
    const pages = await output.copyPages(source, source.getPageIndices());
    pages.forEach((page) => output.addPage(page));
  }
  return output.save();
}

async function imagesToPdf(files: File[]): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png')
      ? await output.embedPng(bytes)
      : await output.embedJpg(bytes);
    const page = output.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  return output.save();
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Dashboard />
      </AuthProvider>
    </ToastProvider>
  );
}

function Dashboard() {
  const toast = useToast();
  const { isProUser, usageCount, remainingUses, incrementUsage, resetUsage } = useAuthStore();
  const [activeTab, setActiveTab] = useState<TabId>('pdf-tools');
  const [isUpgradeOpen, setIsUpgradeOpen] = useState(false);
  const [upgradeMessage, setUpgradeMessage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<BusyMap>({});

  const openUpgradeModal = (message?: string) => {
    setUpgradeMessage(message);
    setIsUpgradeOpen(true);
  };

  const closeUpgradeModal = () => {
    setUpgradeMessage(undefined);
    setIsUpgradeOpen(false);
  };

  // Tool invocation
  const executeTool = async (opId: ToolId, files: QueuedFile[], options: Record<string, unknown>) => {
    if (opId === 'word-to-pdf' || opId === 'edit-pdf') {
      toast.error('This tool runs in your browser — open its panel and use its built-in action.');
      return;
    }

    if (!isProUser && usageCount >= MAX_FREE_USES) {
      openUpgradeModal(FREE_TRIAL_LIMIT_MESSAGE);
      return;
    }

    const sourceFiles = files
      .map((file) => file.file)
      .filter((file): file is File => Boolean(file));

    const minimumFiles = opId === 'merge-pdf' ? 2 : 1;
    if (sourceFiles.length < minimumFiles) {
      toast.error(
        opId === 'merge-pdf'
          ? 'Add at least two PDF files to merge.'
          : 'Add at least one file to run this tool.'
      );
      return;
    }

    setBusy((current) => ({ ...current, [opId]: true }));
    toast.processing('Processing in your browser…', `${opId}:processing`);
    try {
      if (opId === 'merge-pdf') {
        downloadPdf(await mergePdfFiles(sourceFiles), 'merged.pdf');
      } else if (opId === 'images-to-pdf') {
        downloadPdf(await imagesToPdf(sourceFiles), 'images.pdf');
      } else if (opId === 'compress-pdf') {
        const source = await PDFDocument.load(await sourceFiles[0].arrayBuffer());
        downloadPdf(
          await source.save({ useObjectStreams: true }),
          `${sourceFiles[0].name.replace(/\.pdf$/i, '')}-compressed.pdf`
        );
      } else if (opId === 'split-pdf') {
        const source = await PDFDocument.load(await sourceFiles[0].arrayBuffer());
        const mode = String(options.mode ?? 'all');
        const groups: number[][] = [];
        if (mode === 'extract') groups.push(parsePageRanges(String(options.rangesText ?? ''), source.getPageCount()).map((page) => page - 1));
        else if (mode === 'every-n') {
          const size = Math.max(1, Number(options.everyN) || 1);
          for (let start = 0; start < source.getPageCount(); start += size) {
            groups.push(Array.from({ length: Math.min(size, source.getPageCount() - start) }, (_, index) => start + index));
          }
        } else groups.push(...Array.from({ length: source.getPageCount() }, (_, index) => [index]));
        for (let index = 0; index < groups.length; index += 1) {
          const output = await PDFDocument.create();
          const pages = await output.copyPages(source, groups[index]);
          pages.forEach((page) => output.addPage(page));
          downloadPdf(await output.save(), `${sourceFiles[0].name.replace(/\.pdf$/i, '')}-part-${index + 1}.pdf`);
        }
      }
      if (!isProUser) incrementUsage();
      toast.dismissKey(`${opId}:processing`);
      toast.success('Operation completed in your browser.', { key: `${opId}:result` });
    } catch (error) {
      toast.dismissKey(`${opId}:processing`);
      toast.error(error instanceof Error ? error.message : 'The browser operation failed.', { key: `${opId}:result` });
    } finally {
      setBusy((current) => ({ ...current, [opId]: false }));
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 font-sans text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
        <div className="flex items-center gap-6">
          {/* Logo + Title Section */}
          <div className="flex items-center gap-3">
            <img
              src="/icon.png"
              alt="PDF & Doc Suite Logo"
              className="h-9 w-9 object-contain drop-shadow-md"
            />
            <h1 className="text-xl font-bold tracking-tight text-indigo-400">
              PDF & Doc Suite
            </h1>
          </div>

          <nav className="flex gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('pdf-tools')}
              className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                activeTab === 'pdf-tools'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Scissors className="h-4 w-4" /> PDF Tools
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('pdf-viewer')}
              className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                activeTab === 'pdf-viewer'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <FileText className="h-4 w-4" /> PDF Viewer
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('viewer')}
              className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                activeTab === 'viewer'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <FileText className="h-4 w-4" /> Word Viewer
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('creator')}
              className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                activeTab === 'creator'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <FilePlus className="h-4 w-4" /> Doc Creator
            </button>
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {!isProUser && (
            <span
              className="flex items-center rounded-full border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs font-semibold text-slate-300"
              title="Free-trial uses remaining on this device"
            >
              {remainingUses} / {MAX_FREE_USES} Free Uses
            </span>
          )}

          {import.meta.env.DEV && (
            <button
              type="button"
              onClick={resetUsage}
              title="Dev only: reset the per-device 3-use trial counter"
              className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-400 transition hover:border-amber-400/60 hover:text-amber-300"
            >
              Reset Uses
            </button>
          )}

          <button
            type="button"
            onClick={() => openUpgradeModal()}
            className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium transition hover:bg-emerald-500"
          >
            {isProUser ? (
              <BadgeCheck className="h-4 w-4" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {isProUser ? 'Pro Active' : 'Upgrade Pro'}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-8">
        <div className={activeTab === 'pdf-tools' ? '' : 'hidden'}>
          <PdfTools
            busy={busy}
            onRunTool={(opId, files, options) => executeTool(opId, files, options)}
            onRequireUpgrade={(message) => openUpgradeModal(message)}
          />
        </div>

        {activeTab === 'pdf-viewer' && <PdfViewer />}
        {activeTab === 'viewer' && <WordViewer />}
        {activeTab === 'creator' && (
          <DocumentCreator onFreeTrialExhausted={() => openUpgradeModal(FREE_TRIAL_LIMIT_MESSAGE)} />
        )}
      </main>

      <UpgradeModal isOpen={isUpgradeOpen} onClose={closeUpgradeModal} message={upgradeMessage} />
    </div>
  );
}