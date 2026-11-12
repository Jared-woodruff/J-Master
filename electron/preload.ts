import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('jmaster', {
  // Electron 32+ removed File.path; dropped files resolve their disk path
  // here instead ('' for files not backed by disk).
  pathForFile: (file: File): string => {
    let path = '';
    try { path = webUtils.getPathForFile(file); } catch { /* not on disk */ }
    // The user dropped it: the app may read it again later (a batch run).
    if (path) ipcRenderer.send('jmaster:allowPath', path);
    return path;
  },
  /** A path from the user's own history (a recent file they clicked). */
  allowPath: (path: string): void => ipcRenderer.send('jmaster:allowPath', path),
  openFile: (): Promise<{ name: string; path: string; data: ArrayBuffer } | null> =>
    ipcRenderer.invoke('jmaster:openFile'),
  saveProjectFile: (defaultName: string, json: string): Promise<string | null> =>
    ipcRenderer.invoke('jmaster:saveProject', defaultName, json),
  showInFolder: (path: string): void =>
    ipcRenderer.send('jmaster:showInFolder', path),
  /** Opens a report or sheet the app saved this session; false when it can't. */
  openSaved: (path: string): Promise<boolean> => ipcRenderer.invoke('jmaster:openSaved', path),
  writeFileNew: (dir: string, name: string, data: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke('jmaster:writeFileNew', dir, name, data),
  appendFile: (path: string, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('jmaster:appendFile', path, data),
  patchFile: (path: string, offset: number, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('jmaster:patchFile', path, offset, data),
  commitFile: (path: string): Promise<string> => ipcRenderer.invoke('jmaster:commitFile', path),
  discardFile: (path: string): Promise<void> => ipcRenderer.invoke('jmaster:discardFile', path),
  /**
   * A file the app was opened with (a double-clicked project, a track
   * dropped on the shortcut). The main process only says "there is one";
   * the window takes it when it is ready, so none is lost to a window that
   * wasn't listening yet. Returns the unsubscribe.
   */
  onOpenPath: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on('jmaster:openPath', listener);
    return () => { ipcRenderer.removeListener('jmaster:openPath', listener); };
  },
  takeOpenPath: (): Promise<string | null> => ipcRenderer.invoke('jmaster:takeOpenPath'),
  /** What the window is in the middle of (asked about before it closes); null when nothing. */
  setBusy: (what: string | null): void => ipcRenderer.send('jmaster:busy', what),
  saveFile: (defaultName: string, data: ArrayBuffer): Promise<string | null> =>
    ipcRenderer.invoke('jmaster:saveFile', defaultName, data),
  windowControl: (action: 'minimize' | 'maximize' | 'close'): void =>
    ipcRenderer.send('jmaster:window', action),
  pickFiles: (): Promise<{ name: string; path: string }[] | null> =>
    ipcRenderer.invoke('jmaster:pickFiles'),
  readFileByPath: (path: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('jmaster:readFileByPath', path),
  chooseDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('jmaster:chooseDirectory'),
  saveFileTo: (dir: string, name: string, data: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke('jmaster:saveFileTo', dir, name, data),
  platform: process.platform,
});
