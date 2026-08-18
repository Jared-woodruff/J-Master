import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('jmaster', {
  openFile: (): Promise<{ name: string; path: string; data: ArrayBuffer } | null> =>
    ipcRenderer.invoke('jmaster:openFile'),
  saveProjectFile: (defaultName: string, json: string): Promise<string | null> =>
    ipcRenderer.invoke('jmaster:saveProject', defaultName, json),
  showInFolder: (path: string): void =>
    ipcRenderer.send('jmaster:showInFolder', path),
  writeFileNew: (dir: string, name: string, data: ArrayBuffer): Promise<string> =>
    ipcRenderer.invoke('jmaster:writeFileNew', dir, name, data),
  appendFile: (path: string, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('jmaster:appendFile', path, data),
  patchFile: (path: string, offset: number, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('jmaster:patchFile', path, offset, data),
  onOpenPath: (cb: (path: string) => void): void => {
    ipcRenderer.on('jmaster:openPath', (_e, path: string) => cb(path));
  },
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
