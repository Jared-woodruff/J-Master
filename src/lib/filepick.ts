// File opening that works in both worlds: native dialog under Electron,
// <input type=file> in the browser preview.
import { useStore } from '../state/store';
import { filePathOf } from './filepath';

export async function pickAndLoadFile(): Promise<void> {
  const bridge = (window as any).jmaster;
  if (bridge?.openFile) {
    const res = await bridge.openFile();
    if (res) await useStore.getState().loadFile(res.data, res.name, res.path ?? null);
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.wav,.flac,.mp3,.ogg,.m4a,.jmaster,audio/*';
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
