// The arithmetic behind the waveform plate: time text, ruler steps,
// bar.beat positions, snapping, and where the view goes to keep the
// playhead in sight. Pure: no DOM, no store.

/** First index whose value is at or after `t` (the array ascends). */
export function lowerBound(a: ArrayLike<number>, t: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * "1:02", "1:02.5", "1:02.50". Rounded first and split after, so the
 * seconds carry into the minutes: 59.96 s at one decimal is 1:00.0, never
 * 0:60.0.
 */
export function timecode(sec: number, decimals = 0): string {
  const scale = 10 ** Math.max(0, Math.min(3, Math.floor(decimals)));
  const total = Math.round(Math.max(0, Number.isFinite(sec) ? sec : 0) * scale);
  const whole = Math.floor(total / scale);
  const text = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  return scale > 1 ? `${text}.${String(total % scale).padStart(String(scale).length - 1, '0')}` : text;
}

/** A length of time as a readout says it: "850 MS", "7.8 S", "2:05". */
export function spanText(sec: number): string {
  const s = Math.max(0, sec);
  if (s < 0.9995) return `${Math.round(s * 1000)} MS`;
  if (s < 59.95) return `${s.toFixed(1)} S`;
  return timecode(s, 0);
}

const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];

/** The finest ruler step that keeps the view to `maxLabels` labels. */
export function rulerStep(viewLenSec: number, maxLabels = 12): number {
  const n = Math.max(2, maxLabels);
  return RULER_STEPS.find((s) => viewLenSec / s <= n) ?? RULER_STEPS[RULER_STEPS.length - 1];
}

/**
 * The tick times in [startSec, endSec], each a whole multiple of the step
 * (never a running sum, which drifts by the hundredth tick).
 */
export function rulerTicks(startSec: number, endSec: number, step: number): number[] {
  const out: number[] = [];
  if (!(step > 0) || !(endSec >= startSec)) return out;
  // 0.1 × 3 is 0.30000000000000004: the label is made from a rounded tick.
  const k0 = Math.ceil(startSec / step - 1e-9);
  const k1 = Math.floor(endSec / step + 1e-9);
  for (let k = Math.max(0, k0); k <= k1 && out.length < 400; k++) out.push(+(k * step).toFixed(3));
  return out;
}

/** A ruler label: tenths below one-second steps, whole seconds above. */
export function rulerLabel(sec: number, step: number): string {
  return timecode(sec, step < 1 ? 1 : 0);
}

/** What a bar.beat position is read from. */
export interface GridTempo {
  bpm: number;
  firstBeatSec: number;
  firstBarSec?: number;
  beats: number[];
  downbeat: number;
  drift: unknown | null;
}

/** True when the grid follows tracked beats (a drifting tempo) rather than one fixed pulse. */
export function gridFollowsBeats(t: GridTempo): boolean {
  return !!t.drift && t.beats.length > 1;
}

/**
 * The bar and beat (both from 1, four to the bar) `sec` falls in, by the
 * same grid the waveform draws; null before the first bar line or without
 * a pulse.
 */
export function barBeatAt(sec: number, t: GridTempo): { bar: number; beat: number } | null {
  if (!(t.bpm > 0)) return null;
  let n: number;
  if (gridFollowsBeats(t)) {
    const b = t.beats;
    let i = lowerBound(b, sec);
    if (i >= b.length || b[i] > sec) i--;
    if (i < 0) return null;
    n = i - t.downbeat;
    // Past the last tracked beat the last interval carries on.
    if (i === b.length - 1) {
      const step = b[i] - b[i - 1];
      if (step > 0) n += Math.floor((sec - b[i]) / step + 1e-9);
    }
  } else {
    const anchor = t.firstBarSec ?? t.firstBeatSec;
    n = Math.floor((sec - anchor) / (60 / t.bpm) + 1e-6);
  }
  if (n < 0) return null;
  return { bar: Math.floor(n / 4) + 1, beat: (n % 4) + 1 };
}

/** The beat nearest `sec` on that grid; null without a pulse. */
export function nearestBeat(sec: number, t: GridTempo): number | null {
  if (!(t.bpm > 0)) return null;
  if (gridFollowsBeats(t)) {
    const b = t.beats;
    const i = lowerBound(b, sec);
    if (i <= 0) return b[0];
    if (i >= b.length) return b[b.length - 1];
    return sec - b[i - 1] <= b[i] - sec ? b[i - 1] : b[i];
  }
  // The fixed grid is drawn from its first bar on: nothing to snap to before it.
  const anchor = t.firstBarSec ?? t.firstBeatSec;
  const beatSec = 60 / t.bpm;
  return anchor + Math.max(0, Math.round((sec - anchor) / beatSec)) * beatSec;
}

/** `sec`, or the nearest of `candidates` when one lies within `tolSec`. */
export function snapTo(sec: number, candidates: Iterable<number | null | undefined>, tolSec: number): number {
  let best = sec, bestDist = tolSec;
  for (const c of candidates) {
    if (c === null || c === undefined || !Number.isFinite(c)) continue;
    const dist = Math.abs(c - sec);
    if (dist <= bestDist) { best = c; bestDist = dist; }
  }
  return best;
}

export interface ViewRange { start: number; end: number }

/** A view held inside the track, no shorter than `minLen` and no longer than the track. */
export function clampRange(start: number, end: number, dur: number, minLen: number): ViewRange {
  const d = Math.max(0, dur);
  const len = Math.max(Math.min(d, minLen), Math.min(d, end - start));
  const s = Math.max(0, Math.min(d - len, start));
  return { start: s, end: s + len };
}

/**
 * While playing: where the view should start so the playhead stays in
 * sight (a page turn as it reaches the right edge, a jump when it is off
 * to the left); null to leave the view where it is.
 */
export function followStart(view: ViewRange, playhead: number, dur: number): number | null {
  const len = view.end - view.start;
  if (len >= dur - 1e-6) return null;
  if (playhead > view.end - len * 0.02 && view.end < dur - 1e-6) return playhead - len * 0.1;
  if (playhead < view.start) return playhead - len * 0.1;
  return null;
}

/**
 * A moment that has to be seen (a seek made from the keyboard): null when
 * it is already in view; else a view start that shows it with what comes
 * next, or (stepping back) in the middle, so the next step back is still
 * on screen.
 */
export function revealStart(view: ViewRange, sec: number, dur: number): number | null {
  const len = view.end - view.start;
  if (len >= dur - 1e-6) return null;
  if (sec > view.end) return sec - len * 0.1;
  if (sec < view.start) return sec - len * 0.5;
  return null;
}

/** The frequency at height fraction `up` (0 = bottom) of the spectrogram's log axis (20 Hz to 20 kHz). */
export function specFreqAt(up: number): number {
  return 20 * Math.pow(1000, Math.max(0, Math.min(1, up)));
}

/** "86 HZ", "2.4 KHZ", "12 KHZ". */
export function freqText(hz: number): string {
  if (hz < 1000) return `${Math.round(hz)} HZ`;
  return `${hz < 10000 ? (hz / 1000).toFixed(1) : Math.round(hz / 1000)} KHZ`;
}
