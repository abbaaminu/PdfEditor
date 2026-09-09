import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import {
  Archive,
  BadgeCheck,
  FilePlus,
  FileText,
  Image as ImageIcon,
  Layers,
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

type TabId = 'pdf-tools' | 'pdf-viewer' | 'viewer' | 'creator';

interface ElectronBridge {
  send?: (channel: string, data?: unknown) => void;
  on?: (channel: string, listener: (...args: unknown[]) => void) => () => void;
  invoke?: (channel: string, data?: unknown) => Promise<unknown>;
  getPathForFile?: (file: File) => string;
}

interface LegacyRenderer {
  on: (channel: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, listener: (...args: unknown[]) => void) => void;
  send: (channel: string, data?: unknown) => void;
}

function getBridge(): ElectronBridge | null {
  return (window as unknown as { electron?: ElectronBridge }).electron ?? null;
}

function getLegacyRenderer(): LegacyRenderer | null {
  const withRequire = window as unknown as {
    require?: (module: string) => { ipcRenderer?: LegacyRenderer };
  };
  try {
    return withRequire.require?.('electron').ipcRenderer ?? null;
  } catch {
    return null;
  }
}

/** PDF-tool ids shared with <PdfTools/>. Only the IPC subset runs in main. */
type ToolId = PdfToolId;

interface ToolDefinition {
  id: ToolId;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  busyLabel: string;
}

const TOOLS: ToolDefinition[] = [
  {
    id: 'split-pdf',
    label: 'Split PDF',
    description: 'Extract page ranges into a new document',
    icon: Scissors,
    busyLabel: 'Splitting…',
  },
  {
    id: 'compress-pdf',
    label: 'Compress PDF',
    description: 'Optimize and shrink document file size',
    icon: Archive,
    busyLabel: 'Compressing…',
  },
  {
    id: 'merge-pdf',
    label: 'Merge PDFs',
    description: 'Combine multiple PDF files into one',
    icon: Layers,
    busyLabel: 'Merging…',
  },
  {
    id: 'convert-pdf-images',
    label: 'PDF to Images',
    description: 'Convert document pages into image files',
    icon: ImageIcon,
    busyLabel: 'Extracting…',
  },
  {
    id: 'images-to-pdf',
    label: 'Images to PDF',
    description: 'Assemble selected images into a PDF file',
    icon: FileText,
    busyLabel: 'Assembling…',
  },
];

type BusyMap = Partial<Record<ToolId, boolean>>;

/**
 * Tools that may emit a `*-cancelled` event: they open their output picker
 * (save dialog / folder dialog) *after* the `*-processing` event, so a cancel
 * there must clear the processing state. The other tools finish all dialogs
 * before emitting `*-processing` and therefore never send `*-cancelled`.
 */
const CANCEL_AWARE_TOOLS: ReadonlySet<ToolId> = new Set([
  'split-pdf',
  'compress-pdf',
  'merge-pdf',
]);

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

  // Tracks how many in-flight PDF-tool actions were started on the free trial,
  // per tool, so each *success* event increments the device counter exactly
  // once — errors/cancels only release their reservation and never count.
  const pendingTrialRef = useRef<Partial<Record<ToolId, number>>>({});

  const openUpgradeModal = (message?: string) => {
    setUpgradeMessage(message);
    setIsUpgradeOpen(true);
  };

  const closeUpgradeModal = () => {
    setUpgradeMessage(undefined);
    setIsUpgradeOpen(false);
  };

  // ---- IPC events -> toasts + in-context busy indicators --------------------
  useEffect(() => {
    const bridge = getBridge();
    const legacy = getLegacyRenderer();

    const markRunning = (opId: ToolId, running: boolean) =>
      setBusy((current) => ({ ...current, [opId]: running }));

    // A trial action only consumes a use when its success event arrives; errors
    // and user-cancels never count against the 3-use budget.
    const settleTrialOp = (opId: ToolId, success: boolean) => {
      const pending = pendingTrialRef.current[opId] ?? 0;
      if (pending <= 0) return;
      pendingTrialRef.current[opId] = pending - 1;
      if (success) incrementUsage();
    };

    const registerTool = (opId: ToolId): (() => void) => {
      const subscribe = (
        suffix: 'processing' | 'success' | 'error' | 'cancelled',
        handler: (message: string) => void
      ) => {
        const channel = `${opId}-${suffix}`;
        if (bridge?.on) {
          return bridge.on(channel, (msg: unknown) => handler(String(msg)));
        }
        if (legacy) {
          const listener = (_event: unknown, msg: unknown) => handler(String(msg));
          legacy.on(channel, listener);
          return () => legacy.removeListener(channel, listener);
        }
        return () => undefined;
      };

      const removeProcessing = subscribe('processing', (message) => {
        toast.processing(message, `${opId}:processing`);
        markRunning(opId, true);
      });
      const removeSuccess = subscribe('success', (message) => {
        settleTrialOp(opId, true);
        toast.dismissKey(`${opId}:processing`);
        toast.success(message || 'Operation completed successfully.', {
          key: `${opId}:result`,
        });
        markRunning(opId, false);
      });
      const removeError = subscribe('error', (message) => {
        settleTrialOp(opId, false);
        toast.dismissKey(`${opId}:processing`);
        toast.error(message || 'The operation failed.', {
          key: `${opId}:result`,
        });
        markRunning(opId, false);
      });
      const removeCancelled = CANCEL_AWARE_TOOLS.has(opId)
        ? subscribe('cancelled', () => {
            settleTrialOp(opId, false);
            toast.dismissKey(`${opId}:processing`);
            markRunning(opId, false);
          })
        : () => undefined;

      return () => {
        removeProcessing();
        removeSuccess();
        removeError();
        removeCancelled();
      };
    };

    const removeAll = TOOLS.map((tool) => registerTool(tool.id));
    return () => removeAll.forEach((remove) => remove());
  }, [toast, incrementUsage]);

  // ---- Tool invocation -------------------------------------------------------
  // Runs a PDF tool with the queue + options collected in <PdfTools/>.
  const executeTool = (opId: ToolId, files: QueuedFile[], options: Record<string, unknown>) => {
    // Word-to-PDF and the PDF Editor run entirely in the renderer; they use
    // their own panels and never need the Electron IPC pipeline.
    if (opId === 'word-to-pdf' || opId === 'edit-pdf') {
      toast.error('This tool runs in your browser — open its panel and use its built-in action.');
      return;
    }

    // Trial gate: non-Pro users are locked out on their 4th attempt (i.e. after
    // 3 successful uses have been completed on this device). Pro bypasses it.
    if (!isProUser && usageCount >= MAX_FREE_USES) {
      openUpgradeModal(FREE_TRIAL_LIMIT_MESSAGE);
      return;
    }

    const filePaths = files
      .map((file) => file.path)
      .filter((filePath): filePath is string => Boolean(filePath));

    const minimumFiles = opId === 'merge-pdf' ? 2 : 1;
    if (filePaths.length < minimumFiles) {
      toast.error(
        opId === 'merge-pdf'
          ? 'Add at least two PDF files to merge.'
          : 'Add at least one file to run this tool.'
      );
      return;
    }

    const payload = { files: filePaths, options: options ?? {} };
    const startedOnTrial = !isProUser;

    const bridge = getBridge();
    if (bridge?.send) {
      bridge.send(opId, payload);
      if (startedOnTrial) {
        pendingTrialRef.current[opId] = (pendingTrialRef.current[opId] ?? 0) + 1;
      }
      return;
    }
    const legacy = getLegacyRenderer();
    if (legacy) {
      legacy.send(opId, payload);
      if (startedOnTrial) {
        pendingTrialRef.current[opId] = (pendingTrialRef.current[opId] ?? 0) + 1;
      }
      return;
    }
    toast.error(
      'Electron IPC is unavailable in browser mode. Open this page inside the Electron desktop app.'
    );
  };


  return (
    <div className="min-h-screen bg-slate-950 font-sans text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
        <div className="flex items-center gap-6">
          <h1 className="text-xl font-bold tracking-tight text-indigo-400">PDF & Doc Suite</h1>
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
        {/* PdfTools stays mounted (hidden) so file queues/options survive tab switches. */}
        <div className={activeTab === 'pdf-tools' ? '' : 'hidden'}>
          <PdfTools
            busy={busy}
            onRunTool={(opId, files, options) => executeTool(opId, files, options)}
            onRequireUpgrade={(message) => openUpgradeModal(message)}
          />
        </div>

        {activeTab === 'pdf-viewer' && <PdfViewer />}
        {activeTab === 'viewer' && (
          <WordViewer />
        )}
        {activeTab === 'creator' && (
          <DocumentCreator onFreeTrialExhausted={() => openUpgradeModal(FREE_TRIAL_LIMIT_MESSAGE)} />
        )}
      </main>

      <UpgradeModal isOpen={isUpgradeOpen} onClose={closeUpgradeModal} message={upgradeMessage} />
    </div>
  );
}

