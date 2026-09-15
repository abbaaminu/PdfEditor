import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // Group heavy document handling modules into a single vendor bundle
            if (
              id.includes('pdfjs-dist') ||
              id.includes('pdf-lib') ||
              id.includes('docx') ||
              id.includes('mammoth') ||
              id.includes('xlsx')
            ) {
              return 'vendor-docs';
            }
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