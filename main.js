const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const { mergeFiles } = require('./backend/mergeTools');
const { compressPDF } = require('./backend/compressTools');
const { splitPDF } = require('./backend/splitTools');
const { convertPDFtoImages } = require('./backend/imageTools');
const { imagesToPDF } = require('./backend/imageToPdf');

let mainWin;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // External destinations opened with window.open (e.g. the hosted checkout the
  // upgrade modal uses on desktop) belong in the user's default browser, not in
  // a bare Electron window. Anything non-http(s) keeps the default behaviour.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Dev builds (unpackaged) load the Vite dev server; packaged/production
  // builds always load the bundled renderer from disk via __dirname so no
  // localhost dependency, dev-server timeout, or dev fallback can run.
  const rendererEntry = path.join(__dirname, 'frontend/dist/index.html');

  if (!app.isPackaged && process.env.NODE_ENV !== 'production') {
    mainWin.loadURL('http://localhost:5173').catch(() => {
      mainWin.loadFile(rendererEntry);
    });
  } else {
    mainWin.loadFile(rendererEntry);
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

// NOTE: `word-to-pdf` and `edit-pdf` run entirely in the renderer (mammoth +
// pdfjs for parsing/rendering, pdf-lib for assembly/export) and therefore
// intentionally have NO ipcMain.on() counterpart. Their tool ids are declared
// in frontend/src/components/PdfTools.tsx; the preload bridge exposes generic
// send/on/invoke for every channel, so no per-tool registration is required.

/** Normalise an optional file list sent by the renderer (e.g. drag & drop). */
function resolveFileList(payload) {
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => path.normalize(item.trim()));
}

/**
 * Renderer tool payloads may be a plain string[] (legacy) or a structured
 * object { files: string[], options: {...} }. Normalise both into a stable
 * { filePaths, options } shape so every handler can forward tool-specific
 * options (page ranges, compression presets, layout, etc.) to the backend.
 */
function parseToolPayload(payload) {
  if (Array.isArray(payload)) {
    return { filePaths: resolveFileList(payload), options: {} };
  }
  if (payload && typeof payload === 'object') {
    const rawFiles = Array.isArray(payload.files) ? payload.files : [];
    const rawOptions =
      payload.options && typeof payload.options === 'object' ? payload.options : {};
    return { filePaths: resolveFileList(rawFiles), options: { ...rawOptions } };
  }
  return { filePaths: [], options: {} };
}

/**
 * Validate a renderer-supplied input path: it must be absolute, point at an
 * existing regular file (verified through fs.realpathSync.native so symlink
 * redirects cannot smuggle unexpected files in), and match an expected
 * extension. Returns the canonical real path for further processing.
 */
function validateInputPath(filePath, expectedExtensions) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('A file path is required.');
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error(`Refusing non-absolute file path: "${filePath}"`);
  }
  const extensions = Array.isArray(expectedExtensions)
    ? expectedExtensions
    : [expectedExtensions].filter(Boolean);
  const extensionMatches = (candidate) =>
    extensions.length === 0 ||
    extensions.some((extension) => {
      const withDot = String(extension).startsWith('.') ? String(extension) : `.${extension}`;
      return path.extname(candidate).toLowerCase() === withDot.toLowerCase();
    });
  if (!extensionMatches(filePath)) {
    throw new Error(
      `Unsupported file type: "${filePath}". Expected ${extensions.join(' or ')}.`
    );
  }

  let resolved;
  try {
    resolved = fs.realpathSync.native(filePath);
  } catch (err) {
    throw new Error(`"${filePath}" does not exist or could not be resolved: ${err.message}`);
  }
  // Re-check the extension of the real file so a symlink pointing at a script
  // or another document type is rejected too.
  if (!extensionMatches(resolved)) {
    throw new Error(
      `Refusing "${resolved}": the resolved file does not match the expected type.`
    );
  }

  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch (err) {
    throw new Error(`Could not stat "${resolved}": ${err.message}`);
  }
  if (!stats.isFile()) {
    throw new Error(`"${resolved}" is not a regular file.`);
  }
  return resolved;
}

/** Validate a list of renderer-supplied paths, returning canonical paths. */
function validateInputFileList(filePaths, expectedExtensions) {
  return filePaths.map((filePath) => validateInputPath(filePath, expectedExtensions));
}

ipcMain.on('split-pdf', async (event, payload) => {
  const parsed = parseToolPayload(payload);
  let filePaths = parsed.filePaths;
  const options = parsed.options || {};

  if (filePaths.length === 0) {
    const { canceled, filePaths: picked } = await dialog.showOpenDialog(mainWin, {
      title: 'Select PDF to Split',
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      properties: ['openFile'],
    });
    if (canceled || picked.length === 0) return;
    filePaths = picked;
  }

  try {
    filePaths = validateInputFileList(filePaths, ['.pdf']);
    event.reply('split-pdf-processing', 'Splitting PDF pages…');
    const outputFiles = await splitPDF(filePaths[0], {
      ranges: options.ranges,
      rangesText: options.rangesText,
      mode: options.mode,
      everyN: options.everyN,
    });
    if (!outputFiles) {
      event.reply('split-pdf-cancelled', 'Split cancelled.');
      return; // user cancelled the output folder picker
    }
    const count = Array.isArray(outputFiles) ? outputFiles.length : 1;
    event.reply(
      'split-pdf-success',
      `PDF split successfully into ${count} file${count === 1 ? '' : 's'}.`
    );
  } catch (err) {
    event.reply('split-pdf-error', err.message || 'Failed to split PDF.');
  }
});

ipcMain.on('compress-pdf', async (event, payload) => {
  const parsed = parseToolPayload(payload);
  let filePaths = parsed.filePaths;
  const options = parsed.options || {};

  if (filePaths.length === 0) {
    const { canceled, filePaths: picked } = await dialog.showOpenDialog(mainWin, {
      title: 'Select PDF to Compress',
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      properties: ['openFile'],
    });
    if (canceled || picked.length === 0) return;
    filePaths = picked;
  }

  try {
    filePaths = validateInputFileList(filePaths, ['.pdf']);
    event.reply('compress-pdf-processing', 'Compressing PDF… this may take a moment.');
    const result = await compressPDF(filePaths[0], {
      preset: options.preset,
      dpi: options.dpi,
      quality: options.quality,
      engine: options.engine,
    });
    if (!result) {
      event.reply('compress-pdf-cancelled', 'Compression cancelled.');
      return; // user cancelled the output save dialog
    }
    event.reply(
      'compress-pdf-success',
      `PDF compressed successfully (${result.engine}). ` +
        `Size reduced by ${result.savingsPercent}%. Saved to ${result.outputPath}`
    );
  } catch (err) {
    event.reply('compress-pdf-error', err.message || 'Failed to compress PDF.');
  }
});

ipcMain.on('merge-pdf', async (event, payload) => {
  const parsed = parseToolPayload(payload);
  let filePaths = parsed.filePaths;

  if (filePaths.length < 2) {
    const { canceled, filePaths: picked } = await dialog.showOpenDialog(mainWin, {
      title: 'Select PDFs to Merge',
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections'],
    });

    if (canceled || picked.length < 2) {
      if (!canceled) event.reply('merge-pdf-error', 'Please select at least two PDF files to merge.');
      return;
    }
    filePaths = picked;
  }

  try {
    filePaths = validateInputFileList(filePaths, ['.pdf']);
    event.reply('merge-pdf-processing', `Merging ${filePaths.length} PDF files…`);
    const outputPath = await mergeFiles(filePaths);
    if (!outputPath) {
      event.reply('merge-pdf-cancelled', 'Merge cancelled.');
      return; // user cancelled the output save dialog
    }
    event.reply('merge-pdf-success', `PDFs merged successfully. Saved to ${outputPath}`);
  } catch (err) {
    event.reply('merge-pdf-error', err.message || 'Failed to merge PDFs.');
  }
});

ipcMain.on('convert-pdf-images', async (event, payload) => {
  const parsed = parseToolPayload(payload);
  let filePaths = parsed.filePaths;
  const options = parsed.options || {};

  if (filePaths.length === 0) {
    const { canceled, filePaths: picked } = await dialog.showOpenDialog(mainWin, {
      title: 'Select PDF to Convert to Images',
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      properties: ['openFile'],
    });
    if (canceled || picked.length === 0) return;
    filePaths = picked;
  }

  const { canceled, filePaths: dirPaths } = await dialog.showOpenDialog(mainWin, {
    title: 'Select a folder for the extracted page images',
    buttonLabel: 'Save Images Here',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || dirPaths.length === 0) return;
  const outputDir = dirPaths[0];

  try {
    filePaths = validateInputFileList(filePaths, ['.pdf']);
    const format = String(options.format || 'png').toLowerCase();
    const fileName = filePaths.length === 1 ? filePaths[0] : `${filePaths.length} PDFs`;
    event.reply(
      'convert-pdf-images-processing',
      `Extracting pages from ${fileName} to ${format.toUpperCase()} images…`
    );
    const result = await convertPDFtoImages(filePaths, outputDir, {
      format,
      dpi: options.dpi,
      quality: options.quality,
    });
    event.reply(
      'convert-pdf-images-success',
      `${filePaths.length} PDF${filePaths.length === 1 ? '' : 's'} converted to ${format.toUpperCase()} images in ${result}`
    );
  } catch (err) {
    event.reply('convert-pdf-images-error', err.message || 'Failed to convert PDF.');
  }
});

ipcMain.on('images-to-pdf', async (event, payload) => {
  const parsed = parseToolPayload(payload);
  let filePaths = parsed.filePaths;
  const options = parsed.options || {};

  if (filePaths.length === 0) {
    const { canceled, filePaths: picked } = await dialog.showOpenDialog(mainWin, {
      title: 'Select Images to Assemble into PDF',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (canceled || picked.length === 0) return;
    filePaths = picked;
  }

  const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Save assembled PDF',
    buttonLabel: 'Save PDF',
    defaultPath: 'images.pdf',
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return;
  const outputPath = filePath.toLowerCase().endsWith('.pdf') ? filePath : `${filePath}.pdf`;

  try {
    filePaths = validateInputFileList(filePaths, ['.png', '.jpg', '.jpeg']);
    event.reply('images-to-pdf-processing', `Assembling ${filePaths.length} image${filePaths.length === 1 ? '' : 's'} into a PDF…`);
    const saved = await imagesToPDF(filePaths, outputPath, {
      pageSize: options.pageSize,
      orientation: options.orientation,
      margin: options.margin,
    });
    event.reply('images-to-pdf-success', `Images assembled into PDF successfully. Saved to ${saved}`);
  } catch (err) {
    event.reply('images-to-pdf-error', err.message || 'Failed to create PDF from images.');
  }
});

// Native dialog + file read for the Word (.docx) viewer. The renderer asks via
// ipcRenderer.invoke, receives { fileName, base64 } (or { canceled: true }),
// and hands the bytes to mammoth in the browser context.
ipcMain.handle('open-docx-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
    title: 'Select Word Document',
    filters: [{ name: 'Word Documents', extensions: ['docx'] }],
    properties: ['openFile'],
  });

  if (canceled || filePaths.length === 0) return { canceled: true };

  const filePath = filePaths[0];
  try {
    const resolvedPath = validateInputPath(filePath, '.docx');
    const data = fs.readFileSync(resolvedPath);
    return {
      canceled: false,
      fileName: path.basename(resolvedPath),
      filePath: resolvedPath,
      base64: data.toString('base64'),
    };
  } catch (err) {
    throw new Error(`Could not read "${path.basename(filePath)}": ${err.message}`);
  }
});