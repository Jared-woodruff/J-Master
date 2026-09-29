// Disk path of a dropped/picked File. Electron 32+ removed File.path, so the
// preload bridge resolves it via webUtils; the browser preview has no paths.
export function filePathOf(file: File): string | null {
  const bridge = (window as any).jmaster;
  const viaBridge: string | undefined = bridge?.pathForFile?.(file);
  if (viaBridge) return viaBridge;
  const legacy: string | undefined = (file as any).path;
  return legacy || null;
}

const AUDIO_EXT = /\.(wav|wave|flac|mp3|ogg|oga|opus|m4a|aac|aif|aiff)$/i;

/** Audio the decoder can take, or a .jmaster project. */
export function isLoadableFile(file: File): boolean {
  return AUDIO_EXT.test(file.name) || /\.jmaster$/i.test(file.name) || file.type.startsWith('audio/');
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
}
