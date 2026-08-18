import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { readFile, writeFile, appendFile, open } from 'node:fs/promises';
import { join, basename } from 'node:path';

let win: BrowserWindow | null = null;
let pendingOpenPath: string | null = null;

function projectPathFromArgv(argv: string[]): string | null {
  return argv.find((a) => a.toLowerCase().endsWith('.jmaster')) ?? null;
}

function deliverOpenPath(path: string): void {
  if (win && !win.webContents.isLoading()) {
    win.webContents.send('jmaster:openPath', path);
  } else {
    pendingOpenPath = path;
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    frame: false,
    backgroundColor: '#0D0E10',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win?.show());

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../dist/index.html'));
  }

  // External links go to the system browser, never a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => {
    if (pendingOpenPath) {
      win?.webContents.send('jmaster:openPath', pendingOpenPath);
      pendingOpenPath = null;
    }
  });

  win.on('closed', () => { win = null; });
}

// Single instance: a second launch (e.g. double-clicked .jmaster) hands its
// file to the running window instead of opening a new one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const p = projectPathFromArgv(argv);
    if (p) deliverOpenPath(p);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    const p = projectPathFromArgv(process.argv);
    if (p) pendingOpenPath = p;
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

// ── IPC: file dialogs + window controls ───────────────────────────────

ipcMain.handle('jmaster:openFile', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    title: 'Load track',
    properties: ['openFile'],
    filters: [
      { name: 'Audio or project', extensions: ['wav', 'flac', 'mp3', 'ogg', 'm4a', 'aiff', 'aif', 'jmaster'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const path = res.filePaths[0];
  const data = await readFile(path);
  return {
    name: basename(path),
    path,
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  };
});

ipcMain.handle('jmaster:saveProject', async (_e, defaultName: string, json: string) => {
  if (!win) return null;
  const res = await dialog.showSaveDialog(win, {
    title: 'Save project',
    defaultPath: defaultName,
    filters: [{ name: 'J-Master project', extensions: ['jmaster'] }],
  });
  if (res.canceled || !res.filePath) return null;
  await writeFile(res.filePath, json, 'utf8');
  return res.filePath;
});

ipcMain.on('jmaster:showInFolder', (_e, path: string) => {
  shell.showItemInFolder(path);
});

// Streaming file writes for large album images.
ipcMain.handle('jmaster:writeFileNew', async (_e, dir: string, name: string, data: ArrayBuffer) => {
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const full = join(dir, safe);
  await writeFile(full, Buffer.from(data));
  return full;
});

ipcMain.handle('jmaster:appendFile', async (_e, path: string, data: ArrayBuffer) => {
  await appendFile(path, Buffer.from(data));
});

ipcMain.handle('jmaster:patchFile', async (_e, path: string, offset: number, data: ArrayBuffer) => {
  const fh = await open(path, 'r+');
  try {
    await fh.write(Buffer.from(data), 0, data.byteLength, offset);
  } finally {
    await fh.close();
  }
});

ipcMain.handle('jmaster:saveFile', async (_e, defaultName: string, data: ArrayBuffer) => {
  if (!win) return null;
  const res = await dialog.showSaveDialog(win, {
    title: 'Save master',
    defaultPath: defaultName,
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  });
  if (res.canceled || !res.filePath) return null;
  await writeFile(res.filePath, Buffer.from(data));
  return res.filePath;
});

// Batch: pick many files (paths only; bytes are read lazily per item).
ipcMain.handle('jmaster:pickFiles', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    title: 'Add tracks to batch',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: ['wav', 'flac', 'mp3', 'ogg', 'm4a', 'aiff', 'aif'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled) return null;
  return res.filePaths.map((p) => ({ name: basename(p), path: p }));
});

ipcMain.handle('jmaster:readFileByPath', async (_e, path: string) => {
  const data = await readFile(path);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
});

ipcMain.handle('jmaster:chooseDirectory', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose output folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle('jmaster:saveFileTo', async (_e, dir: string, name: string, data: ArrayBuffer) => {
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const full = join(dir, safe);
  await writeFile(full, Buffer.from(data));
  return full;
});

ipcMain.on('jmaster:window', (_e, action: string) => {
  if (!win) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else if (action === 'close') win.close();
});
