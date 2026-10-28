// frontend/src/lib/launchQueue.ts
// Bridge between the OS file handlers (declared in the PWA manifest) and the
// React UI.
//
// Once the app is installed as the default handler for `.pdf`/`.docx` files,
// Chromium delivers every launch through `window.launchQueue`. The consumer is
// registered exactly once per page load, so this module keeps the plumbing
// (matching + launch ids) in one place and lets `App` only deal with "a file
// arrived, open the right tab".

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Which of the app's viewers can display a launched file. */
export type LaunchedFileKind = 'pdf' | 'docx';

/** A file handed to the app by the operating system. */
export interface LaunchedFile {
  /** Monotonic id so re-launching the same path still triggers a reload. */
  id: number;
  file: File;
  kind: LaunchedFileKind;
}

let launchCounter = 0;

/** Maps a launched file onto the viewer that should open it. */
export function classifyLaunchedFile(file: File): LaunchedFileKind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
  if (name.endsWith('.docx') || file.type === DOCX_MIME) return 'docx';
  return null;
}

/**
 * Subscribes to OS file launches.
 *
 * @returns A disposer, or `undefined` when the browser has no Launch Queue
 *   support (Safari, Firefox, or an Electron shell).
 */
export function subscribeToLaunchedFiles(
  handler: (launched: LaunchedFile) => void
): (() => void) | undefined {
  const queue = typeof window === 'undefined' ? undefined : window.launchQueue;
  if (!queue || typeof queue.setConsumer !== 'function') return undefined;

  let disposed = false;
  queue.setConsumer((params) => {
    void (async () => {
      // The manifest only advertises single-file launches; take the first one.
      const handle = params.files?.[0];
      if (!handle || disposed) return;
      const file = await handle.getFile();
      const kind = classifyLaunchedFile(file);
      if (!kind || disposed) return;
      launchCounter += 1;
      handler({ id: launchCounter, file, kind });
    })().catch(() => {
      // A denied/revoked file handle simply means nothing is opened.
    });
  });

  // The Launch Queue has no "unsubscribe", so neutralise the consumer instead.
  return () => {
    disposed = true;
  };
}
