const { contextBridge, ipcRenderer, webUtils } = require('electron');

// ── IPC channel allow-lists ────────────────────────────────────────────────
// Every channel the renderer may send/observe/invoke must be listed here.
// Anything else is rejected by the preload bridge before it reaches Electron.

const TOOL_IDS = [
  'split-pdf',
  'compress-pdf',
  'merge-pdf',
  'convert-pdf-images',
  'images-to-pdf',
];

const SEND_CHANNELS = new Set(TOOL_IDS);

const EVENT_CHANNELS = new Set(
  TOOL_IDS.flatMap((id) => [
    `${id}-processing`,
    `${id}-success`,
    `${id}-error`,
    `${id}-cancelled`,
  ])
);

const INVOKE_CHANNELS = new Set(['open-docx-dialog']);

function assertAllowedSend(channel) {
  if (typeof channel !== 'string' || !SEND_CHANNELS.has(channel)) {
    throw new Error(`Blocked ipcRenderer.send to disallowed channel "${channel}".`);
  }
}

function assertAllowedInvoke(channel) {
  if (typeof channel !== 'string' || !INVOKE_CHANNELS.has(channel)) {
    return Promise.reject(
      new Error(`Blocked ipcRenderer.invoke on disallowed channel "${channel}".`)
    );
  }
  return null;
}

contextBridge.exposeInMainWorld('electron', {
  send: (channel, data) => {
    assertAllowedSend(channel);
    ipcRenderer.send(channel, data);
  },
  on: (channel, func) => {
    // Subscribing to an unknown event channel silently returns a no-op so a
    // misbehaving renderer can never register listeners on main-process events.
    if (typeof channel !== 'string' || !EVENT_CHANNELS.has(channel)) {
      return () => {};
    }
    const subscription = (event, ...args) => func(...args);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  },
  invoke: (channel, data) => {
    const rejected = assertAllowedInvoke(channel);
    if (rejected) return rejected;
    return ipcRenderer.invoke(channel, data);
  },
  // Resolves the absolute path of a dropped/selected File so the renderer can
  // hand it straight to the main-process PDF tools (drag & drop support).
  getPathForFile: (file) => {
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      try {
        return webUtils.getPathForFile(file);
      } catch (_) {
        /* fall through to the legacy File.path */
      }
    }
    return file && file.path;
  },
});
