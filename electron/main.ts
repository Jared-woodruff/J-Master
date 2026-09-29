import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { readFile, writeFile, appendFile, open, rename, unlink } from 'node:fs/promises';
import { join, basename, extname, dirname, isAbsolute, resolve } from 'node:path';

let win: BrowserWindow | null = null;
let pendingOpenPath: string | null = null;

// ── paths the renderer may touch ─────────────────────────────────────────
// Network (UNC) and device paths reach other machines, and Windows signs in
// to them with the user's credentials, so a path read out of a shared
// project must never open one by itself. Local paths are fine; a network
// path only once the user chose it this session (a dialog, a drop, the
// launch arguments), or the folder it sits in.
const granted = new Set<string>();
const pathKey = (p: string) => resolve(p).toLowerCase();
const isNetworkPath = (p: string) => /^[\\/]{2}/.test(p);

function grantPath(p: string): void {
  if (typeof p !== 'string' || !isAbsolute(p)) return;
  granted.add(pathKey(p));
  granted.add(pathKey(dirname(p)));
}

function checkPath(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0 || !isAbsolute(p) || p.includes('\0')) {
    throw new Error('EACCES: not an absolute path');
  }
  if (isNetworkPath(p) && !granted.has(pathKey(p)) && !granted.has(pathKey(dirname(p)))) {
    throw new Error('EACCES: network path not chosen by the user');
  }
  return p;
}

/** Only the album image being written may be appended to or patched. */
const writable = new Set<string>();

/** `name` in `dir`, numbered " (2)", " (3)"… past files that already exist. */
async function writeUnique(dir: string, name: string, data: Buffer): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const full = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    try {
      await writeFile(full, data, { flag: 'wx' });
      return full;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 999) throw err;
    }
  }
}

const safeName = (name: string) => String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');

function projectPathFromArgv(argv: string[]): string | null {
  return argv.find((a) => a.toLowerCase().endsWith('.jmaster')) ?? null;
}

function deliverOpenPath(path: string): void {
  grantPath(path);
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
    // Small enough for scaled laptop displays; the layout re-flows below
    // ~1060 CSS px instead of clipping controls.
    minWidth: 720,
    minHeight: 560,
    frame: false,
    backgroundColor: '#0D0E10',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win?.show());

  // The dev server only ever serves an unpackaged build.
  const devUrl = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../dist/index.html'));
  }

  // External links go to the system browser, never a new Electron window,
  // and the window itself never navigates away from the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-redirect', (e) => e.preventDefault());

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
    if (p) { grantPath(p); pendingOpenPath = p; }
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
  grantPath(path);
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
  grantPath(res.filePath);
  await writeFile(res.filePath, json, 'utf8');
  return res.filePath;
});

ipcMain.on('jmaster:showInFolder', (_e, path: string) => {
  try { shell.showItemInFolder(checkPath(path)); } catch { /* not ours to open */ }
});

// A path the user just handed over (a dropped file, a recent file they
// clicked): network paths become usable for this session.
ipcMain.on('jmaster:allowPath', (_e, path: string) => grantPath(path));

// Album images stream in: written as "<name>.partial", appended to and
// patched, then committed over the final name, so a failed assembly never
// costs the previous image.
ipcMain.handle('jmaster:writeFileNew', async (_e, dir: string, name: string, data: ArrayBuffer) => {
  const full = join(checkPath(dir), safeName(name));
  await writeFile(full, Buffer.from(data));
  writable.add(pathKey(full));
  return full;
});

ipcMain.handle('jmaster:appendFile', async (_e, path: string, data: ArrayBuffer) => {
  if (!writable.has(pathKey(checkPath(path)))) throw new Error('EACCES: not a file the app is writing');
  await appendFile(path, Buffer.from(data));
});

ipcMain.handle('jmaster:patchFile', async (_e, path: string, offset: number, data: ArrayBuffer) => {
  if (!writable.has(pathKey(checkPath(path)))) throw new Error('EACCES: not a file the app is writing');
  const fh = await open(path, 'r+');
  try {
    await fh.write(Buffer.from(data), 0, data.byteLength, offset);
  } finally {
    await fh.close();
  }
});

/** Moves a finished `.partial` over its final name; returns the final path. */
ipcMain.handle('jmaster:commitFile', async (_e, path: string) => {
  const from = checkPath(path);
  if (!writable.has(pathKey(from)) || !from.endsWith('.partial')) throw new Error('EACCES: not a partial file');
  const to = from.slice(0, -'.partial'.length);
  await rename(from, to);
  writable.delete(pathKey(from));
  return to;
});

ipcMain.handle('jmaster:discardFile', async (_e, path: string) => {
  const p = checkPath(path);
  if (!writable.has(pathKey(p))) return;
  writable.delete(pathKey(p));
  await unlink(p).catch(() => undefined);
});

// The file-type filter follows the export format (it used to say WAV for
// every format).
const SAVE_FILTERS: Record<string, { name: string; extensions: string[] }> = {
  wav: { name: 'WAV audio', extensions: ['wav'] },
  flac: { name: 'FLAC audio', extensions: ['flac'] },
  mp3: { name: 'MP3 audio', extensions: ['mp3'] },
  opus: { name: 'Ogg Opus audio', extensions: ['opus', 'ogg'] },
};

ipcMain.handle('jmaster:saveFile', async (_e, defaultName: string, data: ArrayBuffer) => {
  if (!win) return null;
  const ext = extname(defaultName).slice(1).toLowerCase();
  const res = await dialog.showSaveDialog(win, {
    title: 'Save master',
    defaultPath: defaultName,
    filters: [SAVE_FILTERS[ext] ?? SAVE_FILTERS.wav],
  });
  if (res.canceled || !res.filePath) return null;
  grantPath(res.filePath);
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
  res.filePaths.forEach(grantPath);
  return res.filePaths.map((p) => ({ name: basename(p), path: p }));
});

ipcMain.handle('jmaster:readFileByPath', async (_e, path: string) => {
  const data = await readFile(checkPath(path));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
});

ipcMain.handle('jmaster:chooseDirectory', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose output folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  granted.add(pathKey(res.filePaths[0]));
  return res.filePaths[0];
});

// Masters saved into a folder never replace a file already there (a source
// track, another master): a taken name gets " (2)", " (3)"…
ipcMain.handle('jmaster:saveFileTo', async (_e, dir: string, name: string, data: ArrayBuffer) => {
  return writeUnique(checkPath(dir), safeName(name), Buffer.from(data));
});

ipcMain.on('jmaster:window', (_e, action: string) => {
  if (!win) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else if (action === 'close') win.close();
});
