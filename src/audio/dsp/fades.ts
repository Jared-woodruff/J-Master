import type { FadeCurve } from './params';

function curveShape(t: number, curve: FadeCurve): number {
  switch (curve) {
    case 'linear': return t;
    case 'smooth': return t * t * (3 - 2 * t);        // S-curve
    case 'exp': return t * t * t;                     // slow start, late rise
    case 'log': return Math.sqrt(t);                  // fast start, long tail
  }
}

/** Combined fade gain (0..1) at an absolute song position in seconds. */
export function fadeGainAt(
  posSec: number,
  fadeInSec: number,
  fadeOutSec: number,
  fadeInCurve: FadeCurve,
  fadeOutCurve: FadeCurve,
  songLengthSec: number,
): number {
  let g = 1;
  if (fadeInSec > 0 && posSec < fadeInSec) {
    const t = Math.max(0, Math.min(1, posSec / fadeInSec));
    g *= curveShape(t, fadeInCurve);
  }
  if (fadeOutSec > 0 && songLengthSec > 0) {
    const outStart = songLengthSec - fadeOutSec;
    if (posSec > outStart) {
      const t = Math.max(0, Math.min(1, (songLengthSec - posSec) / fadeOutSec));
      g *= curveShape(t, fadeOutCurve);
    }
  }
  return g;
}
