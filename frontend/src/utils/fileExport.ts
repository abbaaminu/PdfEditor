// frontend/src/utils/fileExport.ts
// Single entry point for "give this generated file to the user".
//
// Web / Electron / PWA: behaves like the previous per-component helpers — a
// blob URL behind an anchor with the `download` attribute.
//
// Android / iOS (Capacitor): an anchor download is either ignored or dropped in
// the WebView's private cache, so the bytes are base64-encoded and written with
// @capacitor/filesystem instead. `Directory.Documents` is tried first (visible
// to the user and other apps); if the platform refuses that write — Android 11+
// scoped storage, denied public-storage permission, iOS sandbox quirks — the
// file is retried in `Directory.External` (app shared folder, no permission) and
// finally `Directory.Cache` so the export still succeeds.

import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

/** File contents accepted by {@link saveFile}. */
export type FileContents = Blob | Uint8Array | ArrayBuffer | string;

export interface SaveFileOptions {
  data: FileContents;
  /** File name including the extension, e.g. `merged.pdf`. */
  fileName: string;
  /** Defaults to `application/octet-stream` for the web download path. */
  mimeType?: string;
  /**
   * Native only: directory to write into. Defaults to `Directory.Documents`
   * with `Directory.Cache` as the automatic fallback.
   */
  directory?: Directory;
}

export interface SaveFileResult {
  /** Sanitised name of the file that was produced. */
  fileName: string;
  /** `true` when the bytes were written through Capacitor. */
  native: boolean;
  /** Directory used on native, `null` for browser downloads. */
  directory: Directory | null;
  /** `file://` / `content://` URI reported by the plugin (native only). */
  uri: string | null;
  /** Error message when a native write failed and the anchor fallback ran. */
  fallbackReason?: string;
}

const DEFAULT_MIME_TYPE = 'application/octet-stream';
/** Encode in slices so `String.fromCharCode` never sees a huge argument list. */
const BASE64_CHUNK_SIZE = 0x8000;

/** True inside the Capacitor Android/iOS shell, false in browsers and Electron. */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Removes path separators and characters Android/iOS reject in file names,
 * collapsing whitespace and trimming dots/spaces that would create hidden or
 * untitled files.
 */
export function sanitizeFileName(value: string, fallback = 'download'): string {
  const cleaned = Array.from(value)
    .filter((char) => char.charCodeAt(0) >= 32)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned || fallback;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

/** `Filesystem.writeFile` only accepts raw base64, never a `data:` prefix. */
function stripDataUrlPrefix(value: string): string {
  if (!value.startsWith('data:')) return value;
  const comma = value.indexOf(',');
  return comma === -1 ? '' : value.slice(comma + 1);
}

async function toBase64(data: FileContents): Promise<string> {
  if (typeof data === 'string') return stripDataUrlPrefix(data);
  if (data instanceof Uint8Array) return bytesToBase64(data);
  if (data instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(data));
  return bytesToBase64(new Uint8Array(await data.arrayBuffer()));
}

function toBlob(data: FileContents, mimeType: string): Blob {
  if (typeof data === 'string') return new Blob([data], { type: mimeType });
  if (data instanceof Blob) {
    return data.type ? data : new Blob([data], { type: mimeType });
  }
  return new Blob([data as unknown as BlobPart], { type: mimeType });
}

/**
 * Classic browser/Electron download: anchor in the DOM, `download` attribute,
 * blob URL revoked after the navigation has started.
 */
export function downloadInBrowser(
  data: FileContents,
  fileName: string,
  mimeType: string = DEFAULT_MIME_TYPE
): void {
  const objectUrl =
    typeof data === 'string' && data.startsWith('data:') ? null : URL.createObjectURL(toBlob(data, mimeType));
  const link = document.createElement('a');
  link.href = objectUrl ?? (data as string);
  link.download = fileName;
  link.rel = 'noopener';
  // The anchor must be in the document for the click to be treated as a user
  // download by every browser (and by Electron's file:// renderer).
  document.body.appendChild(link);
  link.click();
  link.remove();
  if (objectUrl) {
    // Revoking synchronously can abort the download before it starts.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
  }
}

/**
 * Saves `data` for the user, choosing the right strategy per platform.
 *
 * Always resolves; a native write failure falls back to the anchor download and
 * reports the reason on the result instead of throwing.
 */
export async function saveFile(options: SaveFileOptions): Promise<SaveFileResult> {
  const fileName = sanitizeFileName(options.fileName);
  const mimeType = options.mimeType ?? DEFAULT_MIME_TYPE;

  if (!isNativePlatform()) {
    downloadInBrowser(options.data, fileName, mimeType);
    return { fileName, native: false, directory: null, uri: null };
  }

  const preferredDirectory = options.directory ?? Directory.Documents;
  // Android 11+ restricts public Documents writes unless the platform can route
  // them through MediaStore, so fall back to the app's shared external folder
  // (no permission needed, reachable over USB) and finally to the cache.
  const directories: Directory[] =
    preferredDirectory === Directory.Cache
      ? [Directory.Cache]
      : [preferredDirectory, Directory.External, Directory.Cache];

  const base64 = await toBase64(options.data);
  let lastError: unknown = null;

  for (const directory of directories) {
    try {
      const { uri } = await Filesystem.writeFile({
        path: fileName,
        data: base64,
        directory,
        recursive: true,
      });
      return { fileName, native: true, directory, uri };
    } catch (error) {
      // Try the next directory: the cache directory needs no storage
      // permission on any supported Android/iOS version.
      lastError = error;
    }
  }

  downloadInBrowser(options.data, fileName, mimeType);
  return {
    fileName,
    native: false,
    directory: null,
    uri: null,
    fallbackReason:
      lastError instanceof Error ? lastError.message : 'The device file could not be written.',
  };
}

/** Convenience wrapper for PDF exports (`saveFile` + `application/pdf`). */
export function savePdf(
  bytes: Uint8Array | ArrayBuffer | Blob,
  fileName: string
): Promise<SaveFileResult> {
  return saveFile({ data: bytes, fileName, mimeType: 'application/pdf' });
}

/**
 * Human-readable confirmation for a save result, e.g.
 * `merged.pdf saved to Documents.`, `page-1.png saved to the app cache folder.`
 */
export function describeSavedFile(result: SaveFileResult): string {
  if (!result.native) {
    if (result.fallbackReason) {
      return `${result.fileName} downloaded (device storage unavailable: ${result.fallbackReason}).`;
    }
    return `${result.fileName} downloaded.`;
  }
  if (result.directory === Directory.Cache) {
    return `${result.fileName} saved to the app cache folder.`;
  }
  if (result.directory === Directory.External) {
    return `${result.fileName} saved to the app storage folder.`;
  }
  if (result.directory === Directory.Documents) {
    return `${result.fileName} saved to Documents.`;
  }
  return `${result.fileName} saved.`;
}
