// Output stage — lookahead true-peak limiter.
// Detection runs on a 4x interpolation of the signal so inter-sample (true)
// peaks are caught. The gain computer is built so the gain is fully down
// when a peak reaches the output: the required gain is held over the
// lookahead (sliding minimum), released smoothly, then averaged over the
// lookahead, which turns every attack into a ramp that ends on the peak.
import { dbToLin } from './params';

const LOOKAHEAD_SEC = 0.0025;
const RELEASE_SEC = 0.09;

// ── true-peak detection ─────────────────────────────────────────────────
// 8x interpolation, 24 taps per phase: Kaiser-windowed sinc phases centred
// between taps 11 and 12, so each push yields seven points between the
// samples 12 and 11 behind it. Worst under-read on a sine: 0.07 dB to
// 16 kHz, 0.11 dB to 20 kHz (4x with short filters missed 0.3-2 dB).
const TP_OS = 8;
const TP_TAPS = 24;
const TP_LAG = TP_TAPS / 2;        // the segment judged starts TP_LAG samples back

function besselI0(x: number): number {
  let sum = 1, term = 1;
  for (let k = 1; k < 32; k++) { term *= (x / (2 * k)) ** 2; sum += term; }
  return sum;
}

function designPhase(frac: number): Float64Array {
  const h = new Float64Array(TP_TAPS);
  const centre = TP_LAG - 1 + frac;
  const beta = 7;
  let sum = 0;
  for (let n = 0; n < TP_TAPS; n++) {
    const k = n - centre;
    const sinc = k === 0 ? 1 : Math.sin(Math.PI * k) / (Math.PI * k);
    const r = k / (TP_TAPS / 2);
    const w = Math.abs(r) < 1 ? besselI0(beta * Math.sqrt(1 - r * r)) / besselI0(beta) : 0;
    h[n] = sinc * w;
    sum += h[n];
  }
  for (let n = 0; n < TP_TAPS; n++) h[n] /= sum;
  return h;
}
const PHASES: Float64Array[] = [];
for (let p = 1; p < TP_OS; p++) PHASES.push(designPhase(p / TP_OS));

/**
 * Streaming 8x true-peak estimator for one channel. Each push returns the
 * peak of one segment of the waveform (the samples TP_LAG and TP_LAG − 1
 * behind the newest, and the curve between them), so the answer arrives
 * TP_LAG samples after the audio it describes.
 */
export class TruePeakDetector {
  // Written twice, TP_TAPS apart, so every window is one straight run.
  private hist = new Float64Array(TP_TAPS * 2);
  private pos = 0;

  static readonly lag = TP_LAG;

  reset(): void { this.hist.fill(0); this.pos = 0; }

  process(x: number): number {
    const hist = this.hist;
    hist[this.pos] = x;
    hist[this.pos + TP_TAPS] = x;
    this.pos = this.pos + 1 === TP_TAPS ? 0 : this.pos + 1;
    // hist[pos + j] is the j-th oldest of the last TP_TAPS samples.
    const o = this.pos;
    const a = Math.abs(hist[o + TP_LAG - 1]);
    const b = Math.abs(hist[o + TP_LAG]);
    let peak = a > b ? a : b;
    for (let p = 0; p < PHASES.length; p++) {
      const h = PHASES[p];
      let acc = 0;
      for (let n = 0; n < TP_TAPS; n++) acc += h[n] * hist[o + n];
      const v = acc < 0 ? -acc : acc;
      if (v > peak) peak = v;
    }
    return peak;
  }
}

/** The largest |gain| any phase can apply: interpolation's worst overshoot. */
const PHASE_L1 = Math.max(1, ...PHASES.map((h) => h.reduce((a, v) => a + Math.abs(v), 0)));

/**
 * The detector's answers for a whole stereo buffer (zeros past its end),
 * for offline passes that differ only in gain. Exact interpolation is the
 * expensive part, so it runs only where it can matter: `bound(i)` is a
 * cheap ceiling on the answer (the loudest sample the filter can see, times
 * its largest overshoot), and `exact(i)` computes, then keeps, the real
 * one. A stretch whose bound stays under the limiter's threshold never
 * needs it.
 */
export class TruePeakEnvelope {
  private bound: Float32Array;
  private cache: Float32Array;

  constructor(private L: Float32Array, private R: Float32Array, readonly length: number) {
    // Sliding max of |x| over the TP_TAPS samples each answer depends on.
    const b = new Float32Array(length);
    const q = new Int32Array(length + 1);
    const abs = (i: number) => {
      if (i < 0 || i >= L.length) return 0;
      const l = L[i] < 0 ? -L[i] : L[i];
      const r = R[i] < 0 ? -R[i] : R[i];
      return l > r ? l : r;
    };
    let head = 0, tail = 0;
    for (let i = 0; i < length; i++) {
      const v = abs(i);
      while (tail > head && abs(q[tail - 1]) <= v) tail--;
      q[tail++] = i;
      while (q[head] <= i - TP_TAPS) head++;
      b[i] = abs(q[head]) * PHASE_L1;
    }
    this.bound = b;
    this.cache = new Float32Array(length).fill(-1);
  }

  /** Upper bound on `exact(i)`. */
  boundAt(i: number): number { return this.bound[i]; }

  /** What a streaming detector would answer after sample i. */
  exact(i: number): number {
    const c = this.cache[i];
    if (c >= 0) return c;
    const v = Math.max(this.segment(this.L, i), this.segment(this.R, i));
    this.cache[i] = v;
    return v;
  }

  private segment(x: Float32Array, i: number): number {
    const o = i - TP_TAPS + 1;                     // oldest sample in the window
    const at = (k: number) => (k >= 0 && k < x.length ? x[k] : 0);
    const a = Math.abs(at(o + TP_LAG - 1));
    const b = Math.abs(at(o + TP_LAG));
    let peak = a > b ? a : b;
    const inside = o >= 0 && o + TP_TAPS <= x.length;
    for (let p = 0; p < PHASES.length; p++) {
      const h = PHASES[p];
      let acc = 0;
      if (inside) for (let n = 0; n < TP_TAPS; n++) acc += h[n] * x[o + n];
      else for (let n = 0; n < TP_TAPS; n++) acc += h[n] * at(o + n);
      const v = acc < 0 ? -acc : acc;
      if (v > peak) peak = v;
    }
    return peak;
  }
}

/** Sliding minimum over the last `win` values (monotonic deque). */
class SlidingMin {
  private vals: Float64Array;
  private idxs: Float64Array;   // doubles: exact far past 2^31 samples
  private head = 0;
  private tail = 0;

  constructor(private win: number) {
    this.vals = new Float64Array(win + 2);
    this.idxs = new Float64Array(win + 2);
  }

  reset(): void { this.head = 0; this.tail = 0; }

  /** Pushes value `v` at stream index `idx`; returns the window's minimum. */
  push(idx: number, v: number): number {
    const cap = this.vals.length;
    const { vals, idxs } = this;
    // Ring deque: drop larger values from the back, stale ones from the front.
    while (this.tail !== this.head && vals[(this.tail - 1 + cap) % cap] >= v) {
      this.tail = (this.tail - 1 + cap) % cap;
    }
    vals[this.tail] = v;
    idxs[this.tail] = idx;
    this.tail = (this.tail + 1) % cap;
    while (idxs[this.head] <= idx - this.win) this.head = (this.head + 1) % cap;
    return vals[this.head];
  }
}

export class Limiter {
  /** Attack ramp length (the gain average). */
  private attack: number;
  private delayL: Float32Array;
  private delayR: Float32Array;
  private dPos = 0;
  private tpL = new TruePeakDetector();
  private tpR = new TruePeakDetector();
  private hold: SlidingMin;
  private ramp: Float64Array;   // the last `attack` released gains
  private rampPos = 0;
  private rampSum: number;
  private released = 1;
  private sampleIdx = 0;
  private relCoef: number;
  private ceilingLin = dbToLin(-1);
  /** Delta monitoring: output only what limiting removed from the signal. */
  deltaMode = false;
  /** Current gain reduction in dB (positive), for the meter. */
  grDb = 0;
  /** Latency in samples: the lookahead plus the detector's lag. */
  readonly latency: number;

  constructor(sampleRate: number) {
    this.attack = Math.max(16, Math.round(sampleRate * LOOKAHEAD_SEC));
    // A peak is known TP_LAG samples after it enters; the ramp that answers
    // it must end before it leaves the delay.
    this.latency = this.attack + TP_LAG;
    this.delayL = new Float32Array(this.latency);
    this.delayR = new Float32Array(this.latency);
    this.hold = new SlidingMin(this.latency + 1);
    this.ramp = new Float64Array(this.attack).fill(1);
    this.rampSum = this.attack;
    this.relCoef = Math.exp(-1 / (sampleRate * RELEASE_SEC));
  }

  reset(): void {
    this.delayL.fill(0); this.delayR.fill(0); this.dPos = 0;
    this.tpL.reset(); this.tpR.reset(); this.hold.reset();
    this.ramp.fill(1); this.rampPos = 0; this.rampSum = this.attack;
    this.released = 1; this.sampleIdx = 0; this.grDb = 0;
  }

  setCeiling(ceilingDb: number): void { this.ceilingLin = dbToLin(ceilingDb); }

  /**
   * Limits a block in place. `peaks` (indexed like L/R) stands in for
   * detection when the input is that envelope's signal times `peakScale`.
   */
  processBlock(
    L: Float32Array, R: Float32Array, start: number, len: number, peaks?: TruePeakEnvelope, peakScale = 1,
  ): void {
    const { delayL, delayR, tpL, tpR, hold, ramp, attack, relCoef, ceilingLin } = this;
    const lat = this.latency;
    let dPos = this.dPos, rampPos = this.rampPos, rampSum = this.rampSum;
    let released = this.released, sampleIdx = this.sampleIdx;
    let minGain = 1;
    for (let i = start; i < start + len; i++) {
      const inL = L[i], inR = R[i];
      // Gain this stretch of waveform needs to stay under the ceiling…
      let peak: number;
      if (peaks) {
        // Under the ceiling by its bound: no gain needed, exact value moot.
        const bound = peaks.boundAt(i) * peakScale;
        peak = bound > ceilingLin ? peaks.exact(i) * peakScale : bound;
      } else {
        peak = Math.max(tpL.process(inL), tpR.process(inR));
      }
      const req = peak > ceilingLin ? ceilingLin / peak : 1;
      // …held until it has left the delay…
      const held = hold.push(sampleIdx, req);
      // …let go slowly (instantly down, exponentially up)…
      released = held < released ? held : held + relCoef * (released - held);
      // …and averaged over the attack, so it lands fully as the peak leaves.
      rampSum += released - ramp[rampPos];
      ramp[rampPos] = released;
      rampPos = rampPos + 1 === attack ? 0 : rampPos + 1;
      const gain = Math.min(1, rampSum / attack);
      if (gain < minGain) minGain = gain;

      const dl = delayL[dPos];
      const dr = delayR[dPos];
      delayL[dPos] = inL;
      delayR[dPos] = inR;
      dPos = dPos + 1 === lat ? 0 : dPos + 1;
      const outL = dl * gain;
      const outR = dr * gain;
      // Last-resort safety: sample peaks can never exceed the ceiling.
      const cl = outL > ceilingLin ? ceilingLin : outL < -ceilingLin ? -ceilingLin : outL;
      const cr = outR > ceilingLin ? ceilingLin : outR < -ceilingLin ? -ceilingLin : outR;
      if (this.deltaMode) {
        // What limiting removed: limited output minus the (delayed) input.
        L[i] = cl - dl;
        R[i] = cr - dr;
      } else {
        L[i] = cl;
        R[i] = cr;
      }
      sampleIdx++;
    }
    // Rounding drift in the running sum is re-based once per block.
    let exact = 0;
    for (let k = 0; k < attack; k++) exact += ramp[k];
    this.rampSum = exact;
    this.dPos = dPos; this.rampPos = rampPos;
    this.released = released; this.sampleIdx = sampleIdx;
    this.grDb = -20 * Math.log10(Math.max(minGain, 1e-6));
  }
}
