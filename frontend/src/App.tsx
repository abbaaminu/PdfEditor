import { useEffect, useRef, useState } from 'react';
import {
  BadgeCheck,
  Download,
  FilePlus,
  FileText,
  Monitor,
  Scissors,
  Smartphone,
  Sparkles,
  X,
  Laptop,
  CheckCircle2,
} from 'lucide-react';
import { DocumentCreator } from './components/DocumentCreator';
import type { QueuedFile } from './components/FileQueue';
import { PdfTools } from './components/PdfTools';
import type { PdfToolId, PdfToolRequest } from './components/PdfTools';
import { PdfViewer } from './components/PdfViewer';
import { ToastProvider } from './components/Toast';
import { useToast } from './components/toast-context';
import { UpgradeModal } from './components/UpgradeModal';
import { WordViewer } from './components/WordViewer';
import { AuthProvider } from './store/AuthProvider';
import { FREE_TRIAL_LIMIT_MESSAGE, MAX_FREE_USES, useAuthStore } from './store/auth-context';
import { PDFDocument } from 'pdf-lib';
import { subscribeToLaunchedFiles } from './lib/launchQueue';
import type { LaunchedFile } from './lib/launchQueue';
import { compressPdfToPdf } from './lib/pdfRenderer';
import type { CompressionPresetKey } from './lib/pdfRenderer';
import { describeSavedFile, savePdf } from './utils/fileExport';
import logo from '../../assets/icon.png';

type TabId = 'pdf-tools' | 'pdf-viewer' | 'viewer' | 'creator';

type ToolId = PdfToolId;

type BusyMap = Partial<Record<ToolId, boolean>>;

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
  const { isProUser, usageCount, remainingUses, incrementUsage, resetUsage, signOut } =
    useAuthStore();
  const [activeTab, setActiveTab] = useState<TabId>('pdf-tools');
  const [isUpgradeOpen, setIsUpgradeOpen] = useState(false);
  const [isDownloadOpen, setIsDownloadOpen] = useState(false);
  const [upgradeMessage, setUpgradeMessage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<BusyMap>({});
  
  const [launchedFile, setLaunchedFile] = useState<LaunchedFile | null>(null);
  const [toolRequest, setToolRequest] = useState<PdfToolRequest | null>(null);
  const toolRequestCounterRef = useRef(0);

  useEffect(
    () =>
      subscribeToLaunchedFiles((launched) => {
        setLaunchedFile(launched);
        setActiveTab(launched.kind === 'docx' ? 'viewer' : 'pdf-tools');
      }),
    []
  );

  const openUpgradeModal = (message?: string) => {
    setUpgradeMessage(message);
    setIsUpgradeOpen(true);
  };

  const closeUpgradeModal = () => {
    setUpgradeMessage(undefined);
    setIsUpgradeOpen(false);
  };

  const openPdfTool = (toolId: PdfToolId) => {
    toolRequestCounterRef.current += 1;
    setToolRequest({ id: toolId, requestId: toolRequestCounterRef.current });
    setActiveTab('pdf-tools');
  };

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
    const savedMessages: string[] = [];
    try {
      if (opId === 'merge-pdf') {
        savedMessages.push(describeSavedFile(await savePdf(await mergePdfFiles(sourceFiles), 'merged.pdf')));
      } else if (opId === 'images-to-pdf') {
        savedMessages.push(describeSavedFile(await savePdf(await imagesToPdf(sourceFiles), 'images.pdf')));
      } else if (opId === 'compress-pdf') {
        const presetInput = typeof options.preset === 'string' ? options.preset : '';
        const preset: CompressionPresetKey =
          presetInput === 'printer' || presetInput === 'screen' ? presetInput : 'ebook';
        const quality =
          typeof options.quality === 'number' ? options.quality / 100 : undefined;
        savedMessages.push(
          describeSavedFile(
            await savePdf(
              await compressPdfToPdf(sourceFiles[0], { preset, quality }),
              `${sourceFiles[0].name.replace(/\.pdf$/i, '')}-compressed.pdf`
            )
          )
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
          savedMessages.push(
            describeSavedFile(
              await savePdf(
                await output.save(),
                `${sourceFiles[0].name.replace(/\.pdf$/i, '')}-part-${index + 1}.pdf`
              )
            )
          );
        }
      }
      if (!isProUser) incrementUsage();
      toast.dismissKey(`${opId}:processing`);
      const successMessage =
        savedMessages.length > 3
          ? `${savedMessages.length} files exported. ${savedMessages[0]}`
          : savedMessages.join(' ') || 'Operation completed in your browser.';
      toast.success(successMessage, { key: `${opId}:result` });
    } catch (error) {
      toast.dismissKey(`${opId}:processing`);
      toast.error(error instanceof Error ? error.message : 'The browser operation failed.', { key: `${opId}:result` });
    } finally {
      setBusy((current) => ({ ...current, [opId]: false }));
    }
  };

  return (
    <div className="min-h-screen w-full bg-slate-950 font-sans text-slate-100">
      <header className="flex flex-col gap-3 border-b border-slate-800 px-4 py-3 sm:px-6 sm:py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3 lg:gap-6">
          <div className="flex items-center gap-3">
            <img
              src={logo}
              alt="PDF & Doc Suite Logo"
              className="h-8 w-8 object-contain drop-shadow-md sm:h-9 sm:w-9"
            />
            <h1 className="text-lg font-bold tracking-tight text-indigo-400 sm:text-xl">
              PDF & Doc Suite
            </h1>
          </div>

          <nav className="flex flex-wrap items-center gap-1.5 sm:gap-2">
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
              <FileText className="h-4 w-4" /> PDF Viewer <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[10px] text-emerald-400">Free</span>
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
              <FileText className="h-4 w-4" /> Word Viewer <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[10px] text-emerald-400">Free</span>
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
              <FilePlus className="h-4 w-4" /> Doc Creator <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[10px] text-emerald-400">Free</span>
            </button>

            {/* Download Modal Trigger & Microsoft Store */}
            <div className="ml-2 hidden items-center gap-2 border-l border-slate-800 pl-3 sm:flex">
              <a
                href="https://apps.microsoft.com/store/detail/9NFXGFVZG41Z?cid=DevShareMCLPCS"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-slate-700 hover:bg-slate-800 hover:text-white"
                title="Get PDF & Doc Suite on Microsoft Store"
              >
                <Monitor className="h-3.5 w-3.5 text-sky-400" />
                <span>Store App</span>
              </a>

              <button
                type="button"
                onClick={() => setIsDownloadOpen(true)}
                className="flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-600/20 px-3 py-1.5 text-xs font-medium text-indigo-300 transition hover:bg-indigo-600 hover:text-white"
                title="Choose your OS and download directly"
              >
                <Download className="h-3.5 w-3.5 text-indigo-400" />
                <span>Download App</span>
              </button>
            </div>
          </nav>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
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
            className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium transition hover:bg-emerald-500 shadow-lg shadow-emerald-900/20"
          >
            {isProUser ? (
              <BadgeCheck className="h-4 w-4" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {isProUser ? 'Pro Active' : 'Upgrade Pro'}
          </button>
          {isProUser && (
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-300 transition hover:border-red-400/60 hover:text-red-300"
            >
              Log Out
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
        <div className={activeTab === 'pdf-tools' ? 'space-y-6' : 'hidden'}>
          {/* Marketing & Value Proposition Banner */}
          <div className="relative overflow-hidden rounded-2xl border border-indigo-500/30 bg-gradient-to-r from-indigo-950/90 via-slate-900 to-purple-950/90 p-6 shadow-2xl sm:p-8">
            <div className="absolute -right-12 -top-12 h-48 w-48 rounded-full bg-indigo-500/15 blur-3xl"></div>
            <div className="absolute -left-12 -bottom-12 h-48 w-48 rounded-full bg-emerald-500/10 blur-3xl"></div>
            
            <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
              <div className="space-y-3">
                <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1 text-xs font-semibold text-emerald-400">
                  <Sparkles className="h-3.5 w-3.5" /> 100% Free Core Features &middot; Cross-Platform
                </div>
                <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
                  Your Ultimate PDF & Document Workspace
                </h2>
                <p className="max-w-2xl text-sm text-slate-300 sm:text-base leading-relaxed">
                  Enjoy our <span className="font-semibold text-emerald-400">PDF Viewer</span>, <span className="font-semibold text-emerald-400">Word/Doc Viewer</span>, and <span className="font-semibold text-emerald-400">Doc Creator</span> completely free with zero limits. Advanced PDF manipulation tools include <span className="font-semibold text-amber-300">3 free trial uses</span>, after which you can unlock unlimited Pro power for just <span className="font-semibold text-indigo-300">$2/month</span> or <span className="font-semibold text-indigo-300">$20/year</span>.
                </p>
              </div>

              <div className="flex flex-shrink-0 flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => openUpgradeModal()}
                  className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/30 transition hover:from-indigo-500 hover:to-purple-500"
                >
                  <Sparkles className="h-4 w-4" /> Go Pro — $2/mo or $20/yr
                </button>
                <button
                  type="button"
                  onClick={() => setIsDownloadOpen(true)}
                  className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/90 px-5 py-3 text-sm font-semibold text-slate-200 transition hover:bg-slate-700 hover:text-white"
                >
                  <Download className="h-4 w-4" /> Download App
                </button>
              </div>
            </div>
          </div>

          <PdfTools
            key={launchedFile ? launchedFile.id : 'initial'}
            busy={busy}
            initialPdfFile={launchedFile?.kind === 'pdf' ? launchedFile : null}
            requestedTool={toolRequest}
            onRunTool={(opId, files, options) => executeTool(opId, files, options)}
            onRequireUpgrade={(message) => openUpgradeModal(message)}
          />
        </div>

        {activeTab === 'pdf-viewer' && (
          <PdfViewer onBack={() => setActiveTab('pdf-tools')} onOpenTool={openPdfTool} />
        )}
        {activeTab === 'viewer' && (
          <WordViewer initialFile={launchedFile?.kind === 'docx' ? launchedFile.file : null} />
        )}
        {activeTab === 'creator' && (
          <DocumentCreator onFreeTrialExhausted={() => openUpgradeModal(FREE_TRIAL_LIMIT_MESSAGE)} />
        )}
      </main>

      <UpgradeModal isOpen={isUpgradeOpen} onClose={closeUpgradeModal} message={upgradeMessage} />
      <DownloadOSModal isOpen={isDownloadOpen} onClose={() => setIsDownloadOpen(false)} />
    </div>
  );
}

/** Direct OS Download Modal Component */
function DownloadOSModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  if (!isOpen) return null;

  const repoBase = 'https://github.com/abbaaminu/PdfEditor/releases/latest/download';

  const platforms = [
    {
      name: 'Windows',
      desc: 'Windows 10 / 11 (64-bit)',
      icon: Monitor,
      color: 'text-sky-400 border-sky-500/30 bg-sky-500/10',
      url: `${repoBase}/PDF.and.Doc.Suite.Setup.1.0.0.exe`,
    },
    {
      name: 'Android',
      desc: 'Android Mobile App (APK)',
      icon: Smartphone,
      color: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
      url: `${repoBase}/app-debug.apk`,
    },
    {
      name: 'macOS',
      desc: 'Apple Silicon & Intel (.dmg)',
      icon: Laptop,
      color: 'text-purple-400 border-purple-500/30 bg-purple-500/10',
      url: `${repoBase}/PDF.and.Doc.Suite-1.0.0-arm64.dmg`,
    },
    {
      name: 'Linux',
      desc: 'Ubuntu, Fedora, Debian (.deb)',
      icon: FileText,
      color: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
      url: `${repoBase}/pdfeditor_1.0.0_amd64.deb`,
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-fade-in">
      <div className="relative w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl sm:p-8">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="space-y-2 mb-6">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-400 border border-indigo-500/20">
            <Download className="h-3.5 w-3.5" /> Direct Downloads
          </div>
          <h3 className="text-xl font-bold text-white">Download PDF & Doc Suite</h3>
          <p className="text-sm text-slate-400">
            Select your operating system to start downloading the installer instantly.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          {platforms.map((p) => {
            const Icon = p.icon;
            return (
              <a
                key={p.name}
                href={p.url}
                onClick={onClose}
                className="group flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-950/60 p-4 transition hover:border-indigo-500/50 hover:bg-slate-800/80"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className={`rounded-lg border p-2.5 ${p.color}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <Download className="h-4 w-4 text-slate-500 group-hover:text-indigo-400 transition transform group-hover:-translate-y-0.5" />
                </div>
                <div>
                  <h4 className="font-semibold text-white group-hover:text-indigo-300 transition">
                    {p.name}
                  </h4>
                  <p className="text-xs text-slate-400 mt-0.5">{p.desc}</p>
                </div>
              </a>
            );
          })}
        </div>

        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-slate-400 border-t border-slate-800/80 pt-4">
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          <span>Secure direct downloads from official GitHub Releases</span>
        </div>
      </div>
    </div>
  );
}
