// Output stage — lookahead true-peak limiter.
// 2.5 ms lookahead, sliding-window minimum gain with fast attack and
// programme-dependent release. Detection runs on a 4x polyphase
// interpolation of the signal so inter-sample (true) peaks are caught.
import { dbToLin } from './params';

const LOOKAHEAD_SEC = 0.0025;

// 4-phase interpolation FIR (8 taps per phase) for true-peak estimation,
// windowed-sinc at quarter-sample offsets.
const TP_TAPS = 8;
function designPhase(frac: number): Float64Array {
  const h = new Float64Array(TP_TAPS);
  const M = TP_TAPS / 2 - 1 + frac; // centre between taps 3 and 4
  let sum = 0;
  for (let n = 0; n < TP_TAPS; n++) {
    const k = n - M;
    const sinc = k === 0 ? 1 : Math.sin(Math.PI * k) / (Math.PI * k);
    const w = 0.54 + 0.46 * Math.cos((Math.PI * k) / (TP_TAPS / 2)); // Hamming-ish
    h[n] = sinc * Math.max(w, 0);
    sum += h[n];
  }
  for (let n = 0; n < TP_TAPS; n++) h[n] /= sum;
  return h;
}
const PHASES = [designPhase(0.25), designPhase(0.5), designPhase(0.75)];

/** Streaming 4x true-peak magnitude estimator for one channel. */
export class TruePeakDetector {
  private hist = new Float32Array(TP_TAPS);
  private pos = 0;

  reset(): void { this.hist.fill(0); this.pos = 0; }

  /** Push one sample; returns the true-peak magnitude estimate around it. */
  process(x: number): number {
    const hist = this.hist;
    hist[this.pos] = x;
    this.pos = (this.pos + 1) % TP_TAPS;
    let peak = Math.abs(x);
    for (let p = 0; p < 3; p++) {
      const h = PHASES[p];
      let acc = 0;
      for (let n = 0; n < TP_TAPS; n++) {
        acc += h[n] * hist[(this.pos - 1 - n + 2 * TP_TAPS) % TP_TAPS];
      }
      const a = Math.abs(acc);
      if (a > peak) peak = a;
    }
    return peak;
  }
}

/** Sliding-window minimum over the last N values (monotonic deque). */
class SlidingMin {
  private vals: Float64Array;
  private idxs: Int32Array;
  private head = 0;
  private tail = 0;
  private n = 0;
  private windowLen: number;

  constructor(windowLen: number, capacity: number) {
    this.windowLen = windowLen;
    this.vals = new Float64Array(capacity);
    this.idxs = new Int32Array(capacity);
  }

  reset(): void { this.head = 0; this.tail = 0; this.n = 0; }

  push(idx: number, v: number): number {
    const { vals, idxs } = this;
    while (this.tail > this.head && vals[this.tail - 1] >= v) this.tail--;
    if (this.tail === vals.length) {
      // Compact the live span back to the front (amortised, rare).
      const span = this.tail - this.head;
      vals.copyWithin(0, this.head, this.tail);
      idxs.copyWithin(0, this.head, this.tail);
      this.head = 0;
      this.tail = span;
    }
    vals[this.tail] = v;
    idxs[this.tail] = idx;
    this.tail++;
    while (idxs[this.head] <= idx - this.windowLen) this.head++;
    this.n = idx;
    return vals[this.head];
  }
}

export class Limiter {
  private lookahead: number;
  private delayL: Float32Array;
  private delayR: Float32Array;
  private dPos = 0;
  private tpL = new TruePeakDetector();
  private tpR = new TruePeakDetector();
  private slidingMin: SlidingMin;
  private sampleIdx = 0;
  private gain = 1;
  private attCoef: number;
  private relCoef: number;
  private ceilingLin = dbToLin(-1);
  /** Delta monitoring: output only what limiting removed from the signal. */
  deltaMode = false;
  /** Current gain reduction in dB (positive), for the meter. */
  grDb = 0;
  /** Latency in samples introduced by the lookahead delay. */
  readonly latency: number;

  constructor(sampleRate: number) {
    this.lookahead = Math.max(16, Math.round(sampleRate * LOOKAHEAD_SEC));
    this.latency = this.lookahead;
    this.delayL = new Float32Array(this.lookahead);
    this.delayR = new Float32Array(this.lookahead);
    this.slidingMin = new SlidingMin(this.lookahead, this.lookahead * 4 + 64);
    this.attCoef = Math.exp(-1 / (sampleRate * (LOOKAHEAD_SEC / 4)));
    this.relCoef = Math.exp(-1 / (sampleRate * 0.09));
  }

  reset(): void {
    this.delayL.fill(0); this.delayR.fill(0); this.dPos = 0;
    this.tpL.reset(); this.tpR.reset(); this.slidingMin.reset();
    this.sampleIdx = 0; this.gain = 1; this.grDb = 0;
  }

  setCeiling(ceilingDb: number): void { this.ceilingLin = dbToLin(ceilingDb); }

  processBlock(L: Float32Array, R: Float32Array, start: number, len: number): void {
    const { delayL, delayR, lookahead, tpL, tpR, slidingMin, attCoef, relCoef, ceilingLin } = this;
    let dPos = this.dPos, gain = this.gain, sampleIdx = this.sampleIdx;
    let maxGr = 0;
    for (let i = start; i < start + len; i++) {
      const inL = L[i], inR = R[i];
      // Required gain so the true peak at this instant stays under the ceiling.
      const peak = Math.max(tpL.process(inL), tpR.process(inR));
      const req = peak > ceilingLin ? ceilingLin / peak : 1;
      // The minimum required gain over the lookahead window…
      const winMin = slidingMin.push(sampleIdx, req);
      // …approached with fast attack, released slowly.
      const coef = winMin < gain ? attCoef : relCoef;
      gain = winMin + coef * (gain - winMin);
      // Delayed output picks up the smoothed gain.
      const dl = delayL[dPos];
      const dr = delayR[dPos];
      const outL = dl * gain;
      const outR = dr * gain;
      delayL[dPos] = inL;
      delayR[dPos] = inR;
      dPos = (dPos + 1) % lookahead;
      // Hard safety: sample peaks can never exceed the ceiling.
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
      const gr = -20 * Math.log10(Math.max(gain, 1e-6));
      if (gr > maxGr) maxGr = gr;
    }
    this.dPos = dPos; this.gain = gain; this.sampleIdx = sampleIdx;
    this.grDb = maxGr;
  }
}
