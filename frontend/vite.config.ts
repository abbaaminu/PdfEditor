import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

function findProjectRoot(): string | null {
  const candidates = [process.cwd(), resolve(process.cwd(), '..')];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'node_modules', 'pdfjs-dist', 'package.json'))) {
      return candidate;
    }
  }
  return null;
}

function syncPdfjsAssets(): void {
  const projectRoot = findProjectRoot();
  if (!projectRoot) {
    console.warn('[vite] node_modules/pdfjs-dist not found; skipping pdf.js asset staging.');
    return;
  }
  const source = join(projectRoot, 'node_modules', 'pdfjs-dist');
  const target = join(projectRoot, 'public', 'pdfjs-assets');
  try {
    const { version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as {
      version: string;
    };
    const marker = join(target, '.version');
    if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === version) return;

    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const folder of ['cmaps', 'standard_fonts']) {
      const folderPath = join(source, folder);
      if (existsSync(folderPath)) {
        cpSync(folderPath, join(target, folder), { recursive: true });
      }
    }
    writeFileSync(marker, version);
    console.log(`[vite] Staged pdf.js cmaps + standard fonts (pdfjs-dist ${version}).`);
  } catch (error) {
    console.warn('[vite] Unable to stage pdf.js cmaps/standard fonts:', error);
  }
}

syncPdfjsAssets();

/**
 * Installs the app as a PWA and as the OS handler for PDF/DOCX files.
 *
 * `injectRegister: null` keeps the auto-injected registration script out of
 * `index.html`: the same build is loaded from `file://` inside the Electron
 * shell, where `serviceWorker.register()` fails. `src/main.tsx` registers the
 * worker itself, and only over http(s).
 */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const pwa = VitePWA({
  registerType: 'autoUpdate',
  injectRegister: null,
  includeAssets: ['icon.png'],
  manifest: {
    name: 'PDF & Doc Suite',
    short_name: 'PDF Editor',
    description: 'Edit PDFs, convert Word documents and manage files entirely in your browser.',
    lang: 'en',
    theme_color: '#0f172a',
    background_color: '#0f172a',
    display: 'standalone',
    orientation: 'any',
    // `base` is relative, so the manifest and the file handlers stay inside
    // whatever folder the build is hosted from.
    start_url: './',
    scope: './',
    icons: [
      { src: 'icon.png', sizes: '1024x1024', type: 'image/png', purpose: 'any' },
      { src: 'icon.png', sizes: '1024x1024', type: 'image/png', purpose: 'maskable' },
    ],
    file_handlers: [
      // vite-plugin-pwa's ManifestOptions only types `action` + `accept`;
      // everything Chromium needs to register the OS association is here.
      { action: './', accept: { 'application/pdf': ['.pdf'] } },
      { action: './', accept: { [DOCX_MIME]: ['.docx'] } },
    ],
  },
  workbox: {
    // The staged pdf.js cmaps/fonts are megabytes of rarely used data; they are
    // fetched on demand from the network instead of being precached.
    globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
    globIgnores: ['pdfjs-assets/**'],
    maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
    cleanupOutdatedCaches: true,
  },
});

export default defineConfig({
  plugins: [react(), pwa],

  base: './',
  build: {
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('pdfjs-dist')) return 'vendor-pdfjs';
            if (id.includes('pdf-lib')) return 'vendor-pdflib';
            if (id.includes('docx')) return 'vendor-docx';
            if (id.includes('mammoth')) return 'vendor-mammoth';
            if (id.includes('xlsx')) return 'vendor-xlsx';
            // Keep UI framework libraries together
            if (id.includes('react') || id.includes('lucide-react')) {
              return 'vendor-ui';
            }
          }
        },
      },
    },
  },
});