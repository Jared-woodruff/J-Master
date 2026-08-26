// File opening that works in both worlds: native dialog under Electron,
// <input type=file> in the browser preview.
import { useStore } from '../state/store';

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

export async function loadDroppedFile(file: File): Promise<void> {
  const data = await file.arrayBuffer();
  // Electron exposes the filesystem path on dropped File objects.
  const path = (file as any).path ?? null;
  await useStore.getState().loadFile(data, file.name, path);
}
