// frontend/src/types/file-handling.d.ts
// Minimal typings for the File Handling / Launch Queue API (Chromium only).
// These interfaces are not part of TypeScript's DOM lib yet, so they are
// declared here instead of casting `window` to `any` at every call site.

interface LaunchParams {
  /** Files the OS handed to the app, in launch order. */
  readonly files?: readonly FileSystemFileHandle[];
  /** The `action` URL of the matched `file_handlers` manifest entry. */
  readonly targetURL?: string;
}

interface LaunchQueue {
  /** Registers the single consumer that receives every queued launch. */
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

interface Window {
  /** Only present in browsers that support the File Handling API. */
  launchQueue?: LaunchQueue;
}
