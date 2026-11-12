// CLIP — a peak clipper ahead of the limiter.
//
// A limiter answers a drum hit by ducking everything around it for a few
// milliseconds. A clipper answers it by flattening only the hit's own tip,
// which the ear forgives on short transients. Clipping first and limiting
// what is left is how loud masters keep their punch: the limiter's gain
// reduction is bounded by how far the clipper lets peaks stand over the
// ceiling.
//
// The curve is the identity up to the knee, then bends smoothly (tanh) to a
// flat top. It runs 4x oversampled, so the harmonics it makes above the
// audio band are filtered out rather than folded back in.
//
// Most of a song never comes near the knee, and there the curve does
// nothing. So the oversampler only runs around peaks: the stage watches
// the last WINDOW samples, wakes when one comes within MARGIN of the knee
// (interpolated peaks stand a little over the samples), and rests again
// HOLD samples after the last. Resting, the signal goes through a plain
// delay of the same length. The watch is per sample, counted the same in
// the preview and the export, so both make the same decisions.
import { Oversampler4x } from './oversampler';
import { DelayLine } from './delay';
import { OS_PRIME, recentOf } from './saturator';
import { dbToLin } from './params';
import type { ClipMode } from './params';

/** Per mode: where the flat top sits over the ceiling, and where the bend starts under it (dB). */
export const CLIP_SHAPE: Record<Exclude<ClipMode, 'off'>, { topDb: number; kneeDb: number }> = {
  // The limiter may still take up to 3 dB; only peaks past the ceiling bend.
  soft: { topDb: 3, kneeDb: 0 },
  // The limiter is left 1 dB; the bend starts 1 dB under the ceiling.
  hard: { topDb: 1, kneeDb: -1 },
};

/** Samples whose peaks can reach an output: the oversampler's filters span this many. */
const WINDOW = 80;
/** The stage wakes for samples within this of the knee (linear: 3 dB under). */
const MARGIN = 0.7;
/** …and rests this long after the last one. */
const HOLD = 256;

export class Clipper {
  private osL = new Oversampler4x();
  private osR = new Oversampler4x();
  private dryL = new DelayLine(Oversampler4x.latency, OS_PRIME);
  private dryR = new DelayLine(Oversampler4x.latency, OS_PRIME);
  private scratch = new Float32Array(OS_PRIME);
  private refL = new Float32Array(256);
  private refR = new Float32Array(256);
  private mode: ClipMode = 'off';
  private ceilingLin = dbToLin(-1);
  private knee = 1;
  private top = 1;
  /** The oversampler is running (and its state is current). */
  private awake = false;
  /** Samples left before the stage may rest. */
  private holdLeft = 0;
  /** Deepest cut in the last block, dB (positive), for the meter. */
  grDb = 0;

  /** Constant, working or resting. */
  static readonly latency = Oversampler4x.latency;

  reset(): void {
    this.osL.reset(); this.osR.reset(); this.dryL.reset(); this.dryR.reset();
    this.awake = false; this.holdLeft = 0; this.grDb = 0;
  }

  setMode(mode: ClipMode): void { this.mode = mode; this.retune(); }
  setCeiling(ceilingDb: number): void { this.ceilingLin = dbToLin(ceilingDb); this.retune(); }

  private retune(): void {
    if (this.mode === 'off') return;
    const s = CLIP_SHAPE[this.mode];
    this.knee = this.ceilingLin * dbToLin(s.kneeDb);
    this.top = this.ceilingLin * dbToLin(s.topDb);
  }

  get active(): boolean { return this.mode !== 'off'; }

  private rest(L: Float32Array, R: Float32Array, from: number, to: number): void {
    const { dryL, dryR } = this;
    for (let i = from; i < to; i++) {
      L[i] = dryL.push(L[i]);
      R[i] = dryR.push(R[i]);
    }
  }

  /** One channel of a waking run; returns the least gain it applied. */
  private work(os: Oversampler4x, dry: DelayLine, x: Float32Array, from: number, n: number, ref: Float32Array, worst: number): number {
    const { knee, top } = this;
    const span = top - knee;
    for (let i = 0; i < n; i++) ref[i] = dry.push(x[from + i]);
    const hi = os.up(x, from, n);
    for (let i = 0; i < hi.length; i++) {
      const v = hi[i];
      const a = v < 0 ? -v : v;
      if (a > knee) {
        const y = knee + span * Math.tanh((a - knee) / span);
        hi[i] = v < 0 ? -y : y;
      }
    }
    os.down(x, from, n);
    // What the clipper took off each sample, against the same sample dry.
    for (let i = 0; i < n; i++) {
      const d = ref[i] < 0 ? -ref[i] : ref[i];
      if (d > knee) {
        const y = x[from + i];
        const g = (y < 0 ? -y : y) / d;
        if (g < worst) worst = g;
      }
    }
    return worst;
  }

  /** `engaged: false` holds the stage out (REF) while keeping its delay. */
  processBlock(L: Float32Array, R: Float32Array, start: number, len: number, engaged = true): void {
    if (!(this.active && engaged)) {
      this.rest(L, R, start, start + len);
      this.awake = false;
      this.holdLeft = 0;
      this.grDb = 0;
      return;
    }
    const wake = this.knee * MARGIN;
    const end = start + len;
    let worst = 1;
    let i = start;
    while (i < end) {
      if (this.holdLeft === 0) {
        // Resting: pass the delay until a sample comes near the knee.
        let j = i;
        while (j < end) {
          const l = L[j], r = R[j];
          if ((l < 0 ? -l : l) > wake || (r < 0 ? -r : r) > wake) break;
          j++;
        }
        if (j > i) { this.rest(L, R, i, j); this.awake = false; }
        if (j === end) break;
        i = j;
        this.holdLeft = WINDOW + HOLD;
      }
      // Waking: the run lasts until the hold runs out or the block ends; a
      // sample near the knee inside it starts the hold over.
      let n = 0;
      while (i + n < end && this.holdLeft > 0) {
        const l = L[i + n], r = R[i + n];
        if ((l < 0 ? -l : l) > wake || (r < 0 ? -r : r) > wake) this.holdLeft = WINDOW + HOLD;
        else this.holdLeft--;
        n++;
      }
      if (!this.awake) {
        // The oversampler picks up from the last stretch of signal, so its
        // output carries on from where the resting delay left off.
        const s = this.scratch;
        this.osL.reset(); this.osR.reset();
        this.osL.up(recentOf(this.dryL, s), 0, OS_PRIME); this.osL.down(s, 0, OS_PRIME);
        this.osR.up(recentOf(this.dryR, s), 0, OS_PRIME); this.osR.down(s, 0, OS_PRIME);
        this.awake = true;
      }
      if (this.refL.length < n) { this.refL = new Float32Array(n); this.refR = new Float32Array(n); }
      worst = this.work(this.osL, this.dryL, L, i, n, this.refL, worst);
      worst = this.work(this.osR, this.dryR, R, i, n, this.refR, worst);
      i += n;
    }
    this.grDb = worst < 1 ? -20 * Math.log10(Math.max(worst, 1e-6)) : 0;
  }
}
