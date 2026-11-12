import { app, BrowserWindow, Menu, ipcMain, dialog, shell, screen } from 'electron';
import { readFile, writeFile, appendFile, open, rename, unlink, access } from 'node:fs/promises';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, basename, extname, dirname, isAbsolute, resolve } from 'node:path';

let win: BrowserWindow | null = null;
/** A file handed to the app from outside (double-click, a second launch), until the window takes it. */
let pendingOpenPath: string | null = null;
/** What the window says it is in the middle of (a render, a batch); null when it can close. */
let busyWith: string | null = null;
let closeConfirmed = false;

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
/** Text files the app itself saved this session: the only ones it will open for you. */
const savedHere = new Set<string>();

const exists = (p: string) => access(p).then(() => true, () => false);

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

// One list for every open dialog, and for what the app takes as a launch
// argument (a file dropped on its shortcut, "Open with").
const AUDIO_EXTENSIONS = ['wav', 'wave', 'flac', 'mp3', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aiff', 'aif'];
const OPENABLE = new RegExp(`\\.(jmaster|${AUDIO_EXTENSIONS.join('|')})$`, 'i');

/** The project or audio file among a launch's arguments, as a full path. */
function openPathFromArgv(argv: string[], cwd: string): string | null {
  // The first argument is the program (and, unpackaged, the app folder).
  const arg = argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && OPENABLE.test(a));
  return arg ? resolve(cwd, arg) : null;
}

/**
 * The window pulls the path when it is ready for it (on start, and at each
 * nudge), so a file can't be lost to a window that wasn't listening yet.
 */
function deliverOpenPath(path: string): void {
  grantPath(path);
  pendingOpenPath = path;
  if (win && !win.webContents.isLoading()) win.webContents.send('jmaster:openPath');
}

// ── the window, where it was left ────────────────────────────────────────
interface WindowState { x?: number; y?: number; width: number; height: number; maximized: boolean }
const MIN_W = 720, MIN_H = 560;
const windowStateFile = () => join(app.getPath('userData'), 'window.json');

function readWindowState(): WindowState {
  const dflt: WindowState = { width: 1440, height: 920, maximized: false };
  try {
    const s = JSON.parse(readFileSync(windowStateFile(), 'utf8')) as Partial<WindowState>;
    const size = (v: unknown, lo: number, d: number) =>
      (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(16000, Math.round(v))) : d);
    const width = size(s.width, MIN_W, dflt.width);
    const height = size(s.height, MIN_H, dflt.height);
    const maximized = s.maximized === true;
    // Back where it was only if a display is still there to show it.
    if (typeof s.x === 'number' && typeof s.y === 'number' && Number.isFinite(s.x) && Number.isFinite(s.y)) {
      const { x, y } = s;
      const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
        x + width > a.x + 120 && x < a.x + a.width - 120 && y >= a.y - 8 && y < a.y + a.height - 120);
      if (onScreen) return { x: Math.round(x), y: Math.round(y), width, height, maximized };
    }
    return { width, height, maximized };
  } catch {
    return dflt;
  }
}

function saveWindowState(): void {
  if (!win) return;
  try {
    const b = win.getNormalBounds();
    const state: WindowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
    writeFileSync(windowStateFile(), JSON.stringify(state));
  } catch { /* a window that opens at the default size next time */ }
}

function createWindow(): void {
  const state = readWindowState();
  win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    // Small enough for scaled laptop displays; the layout re-flows below
    // ~1060 CSS px instead of clipping controls.
    minWidth: MIN_W,
    minHeight: MIN_H,
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
  if (state.maximized) win.maximize();

  // The capture and test scripts drive the window over the DevTools
  // protocol: shown without taking the focus, it can't swallow what the
  // person at the keyboard is typing somewhere else.
  const background = process.env.JMASTER_BACKGROUND === '1';
  win.once('ready-to-show', () => { if (background) win?.showInactive(); else win?.show(); });

  // The dev server only ever serves an unpackaged build.
  const devUrl = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
    // With no application menu there are no accelerators: these two are
    // what development needs back.
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        win?.webContents.toggleDevTools();
        e.preventDefault();
      } else if (input.key === 'F5') {
        win?.webContents.reload();
        e.preventDefault();
      }
    });
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

  // A reload starts the console over: whatever it was doing is gone.
  win.webContents.on('did-start-loading', () => { busyWith = null; });

  // Closing mid-render abandons the render (and a half-written CD image):
  // asked first, once.
  win.on('close', (e) => {
    if (!win) return;
    if (busyWith && !closeConfirmed) {
      e.preventDefault();
      const what = busyWith;
      void dialog.showMessageBox(win, {
        type: 'warning',
        title: 'J-Master',
        message: `${what} is still running.`,
        detail: 'Closing now abandons it. Nothing already saved is lost.',
        buttons: ['Keep working', 'Close anyway'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }).then((r) => {
        if (r.response === 1) {
          closeConfirmed = true;
          win?.close();
        }
      });
      return;
    }
    saveWindowState();
  });

  win.on('closed', () => { win = null; });
}

// Single instance: a second launch (e.g. double-clicked .jmaster) hands its
// file to the running window instead of opening a new one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, workingDirectory) => {
    const p = openPathFromArgv(argv, workingDirectory);
    if (p) deliverOpenPath(p);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // The default menu is invisible on a frameless window, but its
    // accelerators are not: Ctrl+W closed the app mid-render, Ctrl+R threw
    // the session away, Ctrl+Shift+I opened DevTools, Ctrl+minus zoomed.
    Menu.setApplicationMenu(null);
    const p = openPathFromArgv(process.argv, process.cwd());
    if (p) { grantPath(p); pendingOpenPath = p; }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

// An image still being written when the app goes is half an image: gone
// with it, so the folder never holds a ".partial" nobody will finish.
app.on('will-quit', () => {
  for (const p of writable) {
    try { unlinkSync(p); } catch { /* already gone */ }
  }
  writable.clear();
});

// ── IPC: file dialogs + window controls ───────────────────────────────

ipcMain.handle('jmaster:openFile', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    title: 'Load track',
    properties: ['openFile'],
    filters: [
      { name: 'Audio or project', extensions: [...AUDIO_EXTENSIONS, 'jmaster'] },
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

/** The file the app was opened with, once (null when there is none waiting). */
ipcMain.handle('jmaster:takeOpenPath', () => {
  const p = pendingOpenPath;
  pendingOpenPath = null;
  return p;
});

ipcMain.handle('jmaster:saveProject', async (_e, defaultName: string, json: string) => {
  if (!win) return null;
  const res = await dialog.showSaveDialog(win, {
    title: 'Save project',
    defaultPath: safeName(defaultName),
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

/** Opens a report or sheet the app saved this session in its default viewer. */
ipcMain.handle('jmaster:openSaved', async (_e, path: string) => {
  const p = checkPath(path);
  if (!savedHere.has(pathKey(p)) || !/\.(html|txt|cue)$/i.test(p)) return false;
  return (await shell.openPath(p)) === '';
});

// A path the user just handed over (a dropped file, a recent file they
// clicked): network paths become usable for this session.
ipcMain.on('jmaster:allowPath', (_e, path: string) => grantPath(path));

// What the window is in the middle of, for the close guard.
ipcMain.on('jmaster:busy', (e, what: unknown) => {
  if (e.sender !== win?.webContents) return;
  busyWith = typeof what === 'string' && what.length > 0 ? what.slice(0, 60) : null;
  if (!busyWith) closeConfirmed = false;
});

// Album images stream in: written as "<name>.partial", appended to and
// patched, then committed over the final name, so a failed assembly never
// costs the previous image. Anything else written here (the CUE sheet, the
// manifest) lands whole or not at all.
ipcMain.handle('jmaster:writeFileNew', async (_e, dir: string, name: string, data: ArrayBuffer) => {
  const full = join(checkPath(dir), safeName(name));
  if (full.endsWith('.partial')) {
    await writeFile(full, Buffer.from(data));
    writable.add(pathKey(full));
    return full;
  }
  const tmp = `${full}.tmp`;
  try {
    await writeFile(tmp, Buffer.from(data));
    await rename(tmp, full);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  savedHere.add(pathKey(full));
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

/**
 * Moves a finished `.partial` over its final name and returns where it
 * landed. When the last image is open in another app (a player, a burning
 * tool) it can't be replaced: the new one takes a numbered name beside it
 * rather than be thrown away after a long render.
 */
ipcMain.handle('jmaster:commitFile', async (_e, path: string) => {
  const from = checkPath(path);
  if (!writable.has(pathKey(from)) || !from.endsWith('.partial')) throw new Error('EACCES: not a partial file');
  const to = from.slice(0, -'.partial'.length);
  let landed = to;
  try {
    await rename(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err;
    const ext = extname(to);
    const stem = to.slice(0, to.length - ext.length);
    landed = '';
    for (let n = 2; n < 1000 && !landed; n++) {
      const candidate = `${stem} (${n})${ext}`;
      if (await exists(candidate)) continue;
      await rename(from, candidate);
      landed = candidate;
    }
    if (!landed) throw err;
  }
  writable.delete(pathKey(from));
  return landed;
});

ipcMain.handle('jmaster:discardFile', async (_e, path: string) => {
  const p = checkPath(path);
  if (!writable.has(pathKey(p))) return;
  writable.delete(pathKey(p));
  await unlink(p).catch(() => undefined);
});

// The file-type filter follows what is being saved.
const SAVE_FILTERS: Record<string, { name: string; extensions: string[] }> = {
  wav: { name: 'WAV audio', extensions: ['wav'] },
  flac: { name: 'FLAC audio', extensions: ['flac'] },
  mp3: { name: 'MP3 audio', extensions: ['mp3'] },
  opus: { name: 'Ogg Opus audio', extensions: ['opus', 'ogg'] },
  html: { name: 'Web page', extensions: ['html'] },
};

ipcMain.handle('jmaster:saveFile', async (_e, defaultName: string, data: ArrayBuffer) => {
  if (!win) return null;
  const ext = extname(defaultName).slice(1).toLowerCase();
  const res = await dialog.showSaveDialog(win, {
    title: ext === 'html' ? 'Save report' : 'Save master',
    defaultPath: safeName(defaultName),
    filters: [SAVE_FILTERS[ext] ?? SAVE_FILTERS.wav],
  });
  if (res.canceled || !res.filePath) return null;
  grantPath(res.filePath);
  await writeFile(res.filePath, Buffer.from(data));
  savedHere.add(pathKey(res.filePath));
  return res.filePath;
});

// Batch: pick many files (paths only; bytes are read lazily per item).
ipcMain.handle('jmaster:pickFiles', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    title: 'Add tracks to batch',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: AUDIO_EXTENSIONS },
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
  const full = await writeUnique(checkPath(dir), safeName(name), Buffer.from(data));
  savedHere.add(pathKey(full));
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
