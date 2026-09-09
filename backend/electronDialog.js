// backend/electronDialog.js
// Thin wrapper around Electron's native dialog APIs so the backend tool
// modules can ask the user where to save/place output files while remaining
// loadable from plain Node (unit tests / the Express backend), where the
// `electron` module is not available as an API object.

function getElectron() {
  try {
    return require("electron");
  } catch (_) {
    return null;
  }
}

function getDialog() {
  const electron = getElectron();
  return electron && electron.dialog ? electron.dialog : null;
}

function getParentWindow() {
  const electron = getElectron();
  if (!electron || !electron.BrowserWindow) return undefined;
  const windows = electron.BrowserWindow.getAllWindows();
  return windows && windows.length > 0 ? windows[0] : undefined;
}

/**
 * Wraps dialog.showSaveDialog. Resolves with the raw Electron result object
 * ({ canceled, filePath }) or throws if Electron is not available.
 */
async function showSaveDialog(options) {
  const dialog = getDialog();
  if (!dialog) {
    throw new Error(
      "No output path was provided and the Electron save dialog is unavailable. " +
        "Call the tool with an explicit output path/options instead."
    );
  }
  const parent = getParentWindow();
  return parent
    ? dialog.showSaveDialog(parent, options)
    : dialog.showSaveDialog(options);
}

/**
 * Wraps dialog.showOpenDialog. Resolves with the raw Electron result object
 * ({ canceled, filePaths }) or throws if Electron is not available.
 */
async function showOpenDialog(options) {
  const dialog = getDialog();
  if (!dialog) {
    throw new Error(
      "No input was provided and the Electron open dialog is unavailable."
    );
  }
  const parent = getParentWindow();
  return parent
    ? dialog.showOpenDialog(parent, options)
    : dialog.showOpenDialog(options);
}

module.exports = { showSaveDialog, showOpenDialog, getDialog };
