// Cached canvas palette. getComputedStyle is expensive to call per frame;
// the values only change when the theme attribute does, so cache on that.
// The returned object's identity doubles as a "theme changed" signal for
// draw-loop dirty checks.
export interface CanvasPalette {
  well: string;
  bar: string;
  rms: string;
  signal: string;
  hair: string;
  spec: string;
  src: string;
}

let cached: CanvasPalette | null = null;
let cachedTheme = '';

export function palette(): CanvasPalette {
  const theme = document.documentElement.getAttribute('data-theme') ?? 'plate';
  if (!cached || cachedTheme !== theme) {
    const s = getComputedStyle(document.documentElement);
    cached = {
      well: s.getPropertyValue('--surface-well').trim() || '#0A0B0D',
      bar: s.getPropertyValue('--wave-bar').trim() || '#3D4248',
      rms: s.getPropertyValue('--wave-rms').trim() || '#565B61',
      signal: s.getPropertyValue('--signal-500').trim() || '#FF4D00',
      hair: s.getPropertyValue('--border-hairline').trim() || '#26292E',
      spec: s.getPropertyValue('--graphite-400').trim() || '#878D93',
      src: s.getPropertyValue('--graphite-300').trim() || '#AFB3B8',
    };
    cachedTheme = theme;
  }
  return cached;
}
