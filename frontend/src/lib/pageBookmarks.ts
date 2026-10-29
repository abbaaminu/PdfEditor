// frontend/src/lib/pageBookmarks.ts
// Per-document page bookmarks, persisted in `localStorage`.
//
// Everything is stored in one JSON object (`{ "report.pdf": [2, 7] }`) so a
// document can be reopened later — in the browser, in Electron or in the
// Android WebView — and still show the pages the reader marked. All reads and
// writes are defensive: private mode, a full quota or corrupt JSON degrade to
// "no bookmarks" instead of breaking the viewer/editor.

import { useCallback, useEffect, useMemo, useState } from 'react';

/** Versioned key so a future schema change can ignore (or migrate) old data. */
export const BOOKMARK_STORAGE_KEY = 'pdf-suite:page-bookmarks:v1';

type BookmarkStore = Record<string, number[]>;

/** Keeps only unique, positive, whole page numbers, sorted ascending. */
function sanitizePages(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const pages = new Set<number>();
  value.forEach((entry) => {
    if (typeof entry === 'number' && Number.isInteger(entry) && entry > 0) pages.add(entry);
  });
  return [...pages].sort((a, b) => a - b);
}

function readStore(): BookmarkStore {
  try {
    const raw = window.localStorage.getItem(BOOKMARK_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.entries(parsed as Record<string, unknown>).reduce<BookmarkStore>(
      (store, [name, value]) => {
        const pages = sanitizePages(value);
        if (name && pages.length > 0) store[name] = pages;
        return store;
      },
      {}
    );
  } catch {
    // Storage disabled/blocked or corrupt JSON → start from an empty store.
    return {};
  }
}

function writeStore(store: BookmarkStore): void {
  try {
    window.localStorage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota exceeded: the in-memory state still works for this session.
  }
}

export interface PageBookmarks {
  /** Sorted, de-duplicated 1-based page numbers bookmarked in this document. */
  bookmarks: number[];
  isBookmarked: (page: number) => boolean;
  /** Adds the page, or removes it when it is already bookmarked. */
  toggleBookmark: (page: number) => void;
  /** Removes every bookmark of this document (other documents are untouched). */
  clearBookmarks: () => void;
}

/**
 * Bookmarks for `fileName`, kept in sync with `localStorage` so they survive
 * reloads, tab switches and app restarts.
 */
export function usePageBookmarks(fileName: string): PageBookmarks {
  const [store, setStore] = useState<BookmarkStore>(readStore);

  // Another window/tab editing the same store should be reflected here.
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === BOOKMARK_STORAGE_KEY) setStore(readStore());
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const key = fileName.trim();
  const bookmarks = useMemo(() => (key ? store[key] ?? [] : []), [key, store]);

  const commit = useCallback((next: BookmarkStore) => {
    setStore(next);
    writeStore(next);
  }, []);

  const toggleBookmark = useCallback(
    (page: number) => {
      if (!key || !Number.isInteger(page) || page < 1) return;
      // Read the persisted value instead of closing over `store` so two quick
      // toggles can never write a stale snapshot back.
      const current = readStore();
      const pages = current[key] ?? [];
      const nextPages = pages.includes(page)
        ? pages.filter((entry) => entry !== page)
        : [...pages, page].sort((a, b) => a - b);

      const next = { ...current };
      if (nextPages.length > 0) next[key] = nextPages;
      else delete next[key];
      commit(next);
    },
    [key, commit]
  );

  const clearBookmarks = useCallback(() => {
    if (!key) return;
    const current = readStore();
    if (!current[key]) return;
    const next = { ...current };
    delete next[key];
    commit(next);
  }, [key, commit]);

  const isBookmarked = useCallback((page: number) => bookmarks.includes(page), [bookmarks]);

  return { bookmarks, isBookmarked, toggleBookmark, clearBookmarks };
}
