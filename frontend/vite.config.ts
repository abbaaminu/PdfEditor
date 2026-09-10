import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Finds the folder that owns `node_modules/pdfjs-dist`.
 *
 * `import.meta.url` cannot be used here: Vite loads this config from a bundle
 * written to the OS temp folder, so it would resolve to the wrong directory.
 * The npm scripts run with the frontend folder as the working directory.
 */
function findProjectRoot(): string | null {
  const candidates = [process.cwd(), resolve(process.cwd(), '..')];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'node_modules', 'pdfjs-dist', 'package.json'))) {
      return candidate;
    }
  }
  return null;
}

/**
 * pdf.js fetches CMaps (CJK documents) and standard fonts lazily at runtime.
 * Instead of pointing at a CDN, mirror them from `node_modules/pdfjs-dist`
 * into `public/pdfjs-assets` so they are served by the dev server and copied
 * into `dist/` for the packaged Electron build (offline, no CORS).
 */
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
      cpSync(join(source, folder), join(target, folder), { recursive: true });
    }
    writeFileSync(marker, version);
    console.log(`[vite] Staged pdf.js cmaps + standard fonts (pdfjs-dist ${version}).`);
  } catch (error) {
    console.warn('[vite] Unable to stage pdf.js cmaps/standard fonts:', error);
  }
}

syncPdfjsAssets();

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    // docx is a single vendor module larger than Vite's default warning limit.
    // It is isolated from the application bundle as a dedicated vendor chunk.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('pdf-lib')) {
              return 'vendor-pdf';
            }
            if (id.includes('pdfjs-dist')) {
              return 'vendor-pdfjs';
            }
            if (id.includes('docx')) {
              return 'vendor-docx';
            }
            if (id.includes('mammoth')) {
              return 'vendor-mammoth';
            }
            if (id.includes('xlsx')) {
              return 'vendor-xlsx';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            if (id.includes('react') || id.includes('react-dom')) {
              return 'vendor-framework';
            }
            return 'vendor-utils';
          }
        },
      },
    },
  },
});