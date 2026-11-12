// File opening that works in both worlds: native dialog under Electron,
// <input type=file> in the browser preview.
import { useStore } from '../state/store';
import { filePathOf } from './filepath';
import { fileErrorText } from '../state/files';

export async function pickAndLoadFile(): Promise<void> {
  const bridge = (window as any).jmaster;
  if (bridge?.openFile) {
    let res: { name: string; path: string; data: ArrayBuffer } | null;
    try {
      res = await bridge.openFile();
    } catch (err) {
      // The dialog gave a file that then couldn't be read (gone, locked, too large).
      useStore.getState().pushToast(`CAN'T OPEN THAT FILE · ${fileErrorText(err)}`, 'fault');
      return;
    }
    if (res) await useStore.getState().loadFile(res.data, res.name, res.path ?? null);
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.wav,.wave,.flac,.mp3,.ogg,.oga,.opus,.m4a,.aac,.aif,.aiff,.jmaster,audio/*';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const data = await file.arrayBuffer();
    await useStore.getState().loadFile(data, file.name);
  };
  input.click();
}

export function loadDroppedFile(file: File): Promise<void> {
  // The read is handed over unresolved so the store claims its place in
  // line at drop time.
  return useStore.getState().loadFile(file.arrayBuffer(), file.name, filePathOf(file));
}
