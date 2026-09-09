import { createContext, useContext } from 'react';

export type ToastKind = 'success' | 'error' | 'processing';

export interface ToastOptions {
  /** Optional stable key: notifying with the same key replaces the old toast. */
  key?: string;
  /** Auto-dismiss delay in ms, or null to keep it until dismissed. */
  duration?: number | null;
}

export interface ToastApi {
  show: (kind: ToastKind, message: string, options?: ToastOptions) => void;
  success: (message: string, options?: ToastOptions) => void;
  error: (message: string, options?: ToastOptions) => void;
  processing: (message: string, key?: string) => void;
  dismiss: (id: number) => void;
  dismissKey: (key: string) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used inside a <ToastProvider>.');
  }
  return context;
}
