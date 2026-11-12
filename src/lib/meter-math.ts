// The meters rack's arithmetic: loudness range from a run of short-term
// values, the ticks that hold over a bar, the over counter, and the
// spectrum's frequency axis. Pure: no DOM, no engine, no store.

// ── loudness ──────────────────────────────────────────────────────────
/** Nothing under this is loudness at all (BS.1770's absolute gate). */
export const LUFS_FLOOR = -70;

const lufsToEnergy = (lufs: number): number => Math.pow(10, (lufs + 0.691) / 10);
const energyToLufs = (energy: number): number => -0.691 + 10 * Math.log10(Math.max(energy, 1e-12));

/**
 * Loudness range (EBU Tech 3342) of a run of short-term loudness values:
 * silence is gated out (-70 LUFS), then everything more than 20 LU under
 * the mean of what is left, and the range is the spread between the 10th
 * and 95th percentiles of the rest. The same rule, to the index, as the
 * offline measurement in audio/dsp/loudness.ts.
 */
export function lraFromShortTerm(values: ArrayLike<number>, count: number = values.length): number {
  let n = 0;
  let energy = 0;
  for (let i = 0; i < count; i++) {
    const v = values[i];
    if (v > LUFS_FLOOR) { n++; energy += lufsToEnergy(v); }
  }
  if (n < 2) return 0;
  const relGate = energyToLufs(energy / n) - 20;
  const gated = new Float64Array(n);
  let g = 0;
  for (let i = 0; i < count; i++) {
    const v = values[i];
    if (v > LUFS_FLOOR && v > relGate) gated[g++] = v;
  }
  if (g < 2) return 0;
  const sorted = gated.subarray(0, g).sort();
  const p10 = sorted[Math.floor(g * 0.1)];
  const p95 = sorted[Math.min(g - 1, Math.floor(g * 0.95))];
  return p95 - p10;
}

/**
 * Short-term loudness values as they come off the live meter, kept for the
 * running loudness range. Grows as it fills and stops at two hours of
 * values (ten a second), so a session left playing never grows without end.
 */
export class ShortTermSeries {
  static readonly MAX = 72_000;
  private buf = new Float32Array(1024);
  private n = 0;

  get length(): number { return this.n; }

  push(lufs: number): void {
    if (!(lufs > LUFS_FLOOR) || this.n >= ShortTermSeries.MAX) return;
    if (this.n === this.buf.length) {
      const bigger = new Float32Array(Math.min(ShortTermSeries.MAX, this.buf.length * 2));
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.n++] = lufs;
  }

  clear(): void { this.n = 0; }

  lra(): number { return lraFromShortTerm(this.buf, this.n); }
}

// ── ticks and counters ────────────────────────────────────────────────
/** A peak that stays where it landed for a moment, then falls: the tick over a bar. */
export class PeakHold {
  value: number;
  private heldSec = 0;

  constructor(
    private readonly floor: number,
    private readonly holdSec: number,
    private readonly fallPerSec: number,
  ) {
    this.value = floor;
  }

  update(v: number, dtSec: number): number {
    if (v >= this.value) {
      this.value = v;
      this.heldSec = 0;
    } else {
      this.heldSec += dtSec;
      if (this.heldSec > this.holdSec) {
        this.value = Math.max(this.floor, v, this.value - this.fallPerSec * dtSec);
      }
    }
    return this.value;
  }

  reset(): void {
    this.value = this.floor;
    this.heldSec = 0;
  }
}

/** The loudest value of the last `size` readings. */
export class SlidingMax {
  private readonly ring: Float32Array;
  private at = 0;

  constructor(size: number, private readonly floor: number) {
    this.ring = new Float32Array(size).fill(floor);
  }

  push(v: number): number {
    this.ring[this.at] = v;
    this.at = (this.at + 1) % this.ring.length;
    let max = this.floor;
    for (let i = 0; i < this.ring.length; i++) if (this.ring[i] > max) max = this.ring[i];
    return max;
  }

  reset(): void {
    this.ring.fill(this.floor);
    this.at = 0;
  }
}

/** A reading this far past the ceiling is over it (the detector itself is good to a few hundredths). */
export const OVER_MARGIN_DB = 0.05;

/** Counts the times a level goes over a ceiling: one over lasts until the level is back under. */
export class OverCounter {
  count = 0;
  over = false;

  update(db: number, ceilingDb: number): boolean {
    const isOver = db > ceilingDb + OVER_MARGIN_DB;
    if (isOver && !this.over) this.count++;
    this.over = isOver;
    return isOver;
  }

  reset(): void {
    this.count = 0;
    this.over = false;
  }
}

// ── the spectrum's axes ───────────────────────────────────────────────
export const F_LO = 20;
export const F_HI = 20000;
const F_SPAN = Math.log(F_HI / F_LO);

/** 0 at 20 Hz, 1 at 20 kHz, even steps per octave between. */
export const hzToX = (hz: number): number => Math.log(hz / F_LO) / F_SPAN;
export const xToHz = (x: number): number => F_LO * Math.exp(x * F_SPAN);

/**
 * What a tilted display adds at `hz`: nothing at the pivot, `dbPerOct` more
 * per octave above it and as much less per octave below. Music's spectrum
 * falls about 4.5 dB an octave, so at that tilt a balanced mix reads level.
 */
export function slopeDb(hz: number, dbPerOct = 4.5, pivotHz = 1000): number {
  return dbPerOct * Math.log2(hz / pivotHz);
}

/**
 * An FFT in dB folded onto `out.length` bands, log-spaced from 20 Hz to
 * 20 kHz. A band takes its loudest bin; down where the bands are narrower
 * than the bins (the bottom octaves) it reads the level between the two
 * bins around its centre. Bin k sits at k * sampleRate / (2 * db.length).
 */
export function spectrumBands(db: ArrayLike<number>, sampleRate: number, out: Float32Array, floorDb = -120): void {
  const bins = db.length;
  const n = out.length;
  if (bins < 2 || n === 0) { out.fill(floorDb); return; }
  const binHz = sampleRate / 2 / bins;
  const at = (i: number): number => {
    const v = db[i];
    return Number.isFinite(v) && v > floorDb ? v : floorDb;
  };
  for (let b = 0; b < n; b++) {
    const f0 = xToHz(b / n);
    const f1 = xToHz((b + 1) / n);
    const i0 = Math.ceil(f0 / binHz);
    const i1 = Math.min(bins - 1, Math.ceil(f1 / binHz) - 1);
    if (i1 >= i0) {
      let peak = floorDb;
      for (let i = i0; i <= i1; i++) {
        const v = at(i);
        if (v > peak) peak = v;
      }
      out[b] = peak;
    } else {
      const pos = Math.min(bins - 1, Math.sqrt(f0 * f1) / binHz);
      const lo = Math.min(bins - 2, Math.floor(pos));
      const t = pos - lo;
      out[b] = at(lo) * (1 - t) + at(lo + 1) * t;
    }
  }
}

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** The nearest equal-tempered note to a frequency (A4 = 440 Hz): "A4", "C#2". */
export function noteName(hz: number): string {
  if (!(hz > 0) || !Number.isFinite(hz)) return '';
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  return `${NOTES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** "63 HZ", "1.25 KHZ", "12.5 KHZ" */
export function hzText(hz: number): string {
  if (hz >= 10000) return `${(hz / 1000).toFixed(1)} KHZ`;
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} KHZ`;
  return `${Math.round(hz)} HZ`;
}

// ── readouts ──────────────────────────────────────────────────────────
/** A loudness or level figure, or the unlit display when there is none. */
export function levelText(v: number, floor = -69): string {
  return Number.isFinite(v) && v > floor ? v.toFixed(1) : '--.-';
}

/** The step between time labels that puts at most `maxTicks` of them across `spanSec`. */
export function timeTickStep(spanSec: number, maxTicks: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const s of steps) if (spanSec / s <= Math.max(1, maxTicks)) return s;
  return 7200;
}
