import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FC, ReactNode } from 'react';
import { CircleCheck, CircleX, LoaderCircle, X } from 'lucide-react';
import { ToastContext } from './toast-context';
import type { ToastApi, ToastKind, ToastOptions } from './toast-context';

interface ToastRecord {
  id: number;
  kind: ToastKind;
  message: string;
  key?: string;
  duration: number | null;
}

const DEFAULT_DURATION: Record<ToastKind, number | null> = {
  success: 5000,
  error: 9000,
  processing: null, // stays until the operation reports success/error or is closed
};

let toastSequence = 0;
function nextToastId(): number {
  toastSequence += 1;
  return toastSequence;
}

const TOAST_STYLES: Record<
  ToastKind,
  { card: string; icon: ReactNode; iconClass: string }
> = {
  success: {
    card: 'border-emerald-500/40 bg-emerald-950/90 text-emerald-100',
    iconClass: 'text-emerald-400',
    icon: <CircleCheck className="h-5 w-5" />,
  },
  error: {
    card: 'border-red-500/40 bg-red-950/90 text-red-100',
    iconClass: 'text-red-400',
    icon: <CircleX className="h-5 w-5" />,
  },
  processing: {
    card: 'border-indigo-500/40 bg-slate-900/95 text-slate-100',
    iconClass: 'text-indigo-400',
    icon: <LoaderCircle className="h-5 w-5 animate-spin" />,
  },
};

export const ToastProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timersRef = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const dismissKey = useCallback((key: string) => {
    setToasts((current) => current.filter((toast) => toast.key !== key));
  }, []);

  const show = useCallback((kind: ToastKind, message: string, options?: ToastOptions) => {
    const toastKey = options?.key;
    setToasts((current) => {
      const next = toastKey
        ? current.filter((toast) => toast.key !== toastKey)
        : current;
      return [
        ...next,
        {
          id: nextToastId(),
          kind,
          message,
          key: toastKey,
          duration: options?.duration ?? DEFAULT_DURATION[kind],
        },
      ];
    });
  }, []);

  const success = useCallback(
    (message: string, options?: ToastOptions) => show('success', message, options),
    [show]
  );
  const error = useCallback(
    (message: string, options?: ToastOptions) => show('error', message, options),
    [show]
  );
  const processing = useCallback(
    (message: string, key?: string) => show('processing', message, { key, duration: null }),
    [show]
  );

  // Schedule auto-dismissal for finite-duration toasts.
  useEffect(() => {
    const timers = timersRef.current;
    for (const toast of toasts) {
      if (toast.duration === null || toast.duration <= 0) continue;
      const existing = timers.get(toast.id);
      if (existing) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        dismiss(toast.id);
        timers.delete(toast.id);
      }, toast.duration);
      timers.set(toast.id, timer);
    }
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, [toasts, dismiss]);

  const api = useMemo<ToastApi>(
    () => ({ show, success, error, processing, dismiss, dismissKey }),
    [show, success, error, processing, dismiss, dismissKey]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}

      {/* Global floating viewport */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="fixed right-4 top-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {toasts.map((toast) => {
          const styles = TOAST_STYLES[toast.kind];
          return (
            <div
              key={toast.id}
              role={toast.kind === 'error' ? 'alert' : 'status'}
              className={`toast-pop relative flex items-start gap-3 overflow-hidden rounded-xl border p-3 pl-3.5 text-sm shadow-xl backdrop-blur ${styles.card}`}
            >
              <span className={`mt-0.5 shrink-0 ${styles.iconClass}`}>{styles.icon}</span>
              <span className="flex-1 break-words py-0.5">{toast.message}</span>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismiss(toast.id)}
                className="absolute right-1.5 top-1.5 rounded p-1 text-current opacity-60 transition hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>

              {toast.kind === 'processing' && (
                <span className="absolute bottom-0 left-0 h-0.5 w-full overflow-hidden bg-slate-700/40">
                  <span className="toast-progress-bar block h-full w-2/5 bg-indigo-400" />
                </span>
              )}
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

