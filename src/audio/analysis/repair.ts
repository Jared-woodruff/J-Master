// Drift repair: stretch a drifting track onto a steady tempo without
// touching its pitch.
//
// The tempo curve says how fast the song runs at every moment. Integrated,
// it counts beats, and a warp gives every beat its time at the target
// tempo; a phase vocoder then plays the audio along that warp. Generated
// tracks drift in tempo only (their pitch holds; measured on a real take
// whose tempo ran 5.7% fast), so a plain speed change would detune them.
//
// The curve, not the tracked beats, drives the warp: on a real take the
// integrated curve stayed within 0.07 beats of the song's pulse for 4½
// minutes, while single tracked beats jitter by ±10% and can settle a
// third of a beat off the pulse for a minute where the kick is syncopated.
//
// The vocoder's phases come from phase gradient heap integration (Průša &
// Holighaus 2017): partials stay locked to their peaks and transients keep
// their attack. The rotations are computed once from both channels
// together and applied to both, so the stereo image stays exactly where it
// was. No single frame length suits a whole mix (bass partials a few hertz
// apart need long frames, drum attacks short ones), so the track is heard
// in two bands, each through its own frame length, but with phases from
// one field across both, so the bands add back coherently where they
// meet. Where the warp runs at unity the output equals the input.
import { FftPlan } from '../dsp/fft';
import { bridged, type TempoCurve } from './tempo';

const TWO_PI = 2 * Math.PI;

export interface RepairPlan {
  targetBpm: number;
  /** Output sample → source sample (fractional); monotonic, warp(0) = 0. */
  warp: (tau: number) => number;
  /** Output length, samples. */
  outLength: number;
  /** Beats in the song. */
  beats: number;
  /** Local stretch range: 0.057 = 5.7% longer, −0.02 = 2% shorter. */
  maxStretch: number;
  minStretch: number;
}

/**
 * Curve points with gaps bridged, then smoothed by a Gaussian-weighted
 * local line (σ = 3 points), which unlike a plain average keeps a steady
 * ramp exact up to the ends of the song; with the line's slope at each
 * end (BPM per point).
 */
function smoothCurve(curve: TempoCurve): { vals: number[]; slope0: number; slope1: number } {
  const v = bridged(curve.bpm);
  if (!v) return { vals: [], slope0: 0, slope1: 0 };
  const fit = (i: number): [number, number] => {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = Math.max(0, i - 9); j <= Math.min(v.length - 1, i + 9); j++) {
      const w = Math.exp(-0.5 * ((j - i) / 3) ** 2), x = j - i;
      sw += w; sx += w * x; sy += w * v[j]; sxx += w * x * x; sxy += w * x * v[j];
    }
    const det = sw * sxx - sx * sx;
    return det > 1e-9 ? [(sy * sxx - sx * sxy) / det, (sw * sxy - sx * sy) / det] : [sy / sw, 0];
  };
  return { vals: v.map((_, i) => fit(i)[0]), slope0: fit(0)[1], slope1: fit(v.length - 1)[1] };
}

/**
 * How far past its first and last points the curve's trend carries on:
 * the points sit at the middle of 12 s windows, so the music runs on 6 s
 * past them at each end. Beyond that (silence), the tempo holds.
 */
const CURVE_EDGE_SEC = 6;

/**
 * The warp that plays the whole song at `targetBpm`: the (smoothed) tempo
 * curve integrated into a running beat count, each beat at its count times
 * the target beat length.
 */
export function planRepair(curve: TempoCurve, targetBpm: number, fs: number, sourceLength: number): RepairPlan {
  const { vals, slope0, slope1 } = smoothCurve(curve);
  if (vals.length < 2 || !(targetBpm > 0)) throw new Error('no tempo curve to repair from');
  const last = vals.length - 1;
  const edge = CURVE_EDGE_SEC / curve.stepSec;
  const bpmAt = (t: number): number => {
    const x = (t - curve.startSec) / curve.stepSec;
    // Past the ends, the trend carries on as far as the music does.
    if (x < 0) return vals[0] + slope0 * Math.max(x, -edge);
    if (x > last) return vals[last] + slope1 * Math.min(x - last, edge);
    const i = Math.min(last - 1, Math.floor(x));
    return vals[i] + (vals[i + 1] - vals[i]) * (x - i);
  };
  const H = 256;                               // count resolution, samples
  const steps = Math.ceil(sourceLength / H) + 2;
  const count = new Float64Array(steps);
  for (let i = 1; i < steps; i++) count[i] = count[i - 1] + (H / fs) * (Math.max(1, bpmAt(((i - 0.5) * H) / fs)) / 60);
  const perBeat = (60 / targetBpm) * fs;       // output samples per beat
  const srcCount = (s: number): number => {
    const x = Math.max(0, s / H);
    const i = Math.min(steps - 2, Math.floor(x));
    return count[i] + (count[i + 1] - count[i]) * (x - i);
  };
  const beats = srcCount(sourceLength);
  const outLength = Math.max(1, Math.round(beats * perBeat));
  const warp = (tau: number): number => {
    const b = Math.max(0, tau / perBeat);
    if (b >= count[steps - 1]) return (steps - 1 + (b - count[steps - 1]) / (count[steps - 1] - count[steps - 2])) * H;
    let lo = 0, hi = steps - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (count[m] <= b) lo = m; else hi = m;
    }
    return (lo + (b - count[lo]) / (count[hi] - count[lo])) * H;
  };
  let maxStretch = -Infinity, minStretch = Infinity;
  for (const v of [...vals, bpmAt(curve.startSec - CURVE_EDGE_SEC), bpmAt(curve.startSec + (last * curve.stepSec) + CURVE_EDGE_SEC)]) {
    const stretch = v / targetBpm - 1;
    if (stretch > maxStretch) maxStretch = stretch;
    if (stretch < minStretch) minStretch = stretch;
  }
  return { targetBpm, warp, outLength, beats: Math.round(beats), maxStretch, minStretch };
}

/**
 * One STFT resolution: a periodic Hann window, the FFT, and both channels'
 * spectra for this frame and the last. Both channels travel in one complex
 * FFT (L real, R imaginary).
 */
class Stft {
  readonly N: number;
  readonly half: number;
  readonly win: Float64Array;
  private readonly plan: FftPlan;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  lr: Float64Array; li: Float64Array; rr: Float64Array; ri: Float64Array;
  private plr: Float64Array; private pli: Float64Array;
  private prr: Float64Array; private pri: Float64Array;

  constructor(N: number) {
    this.N = N;
    this.half = N / 2;
    this.plan = new FftPlan(N);
    this.win = new Float64Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / N);
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    const K = this.half + 1;
    this.lr = new Float64Array(K); this.li = new Float64Array(K);
    this.rr = new Float64Array(K); this.ri = new Float64Array(K);
    this.plr = new Float64Array(K); this.pli = new Float64Array(K);
    this.prr = new Float64Array(K); this.pri = new Float64Array(K);
  }

  /**
   * Both channels' spectra around source sample `a` (silence outside the
   * signal). With `sub`, the frame is of L − subL and R − subR.
   */
  analyze(L: Float32Array, R: Float32Array, a: number, subL?: Float32Array, subR?: Float32Array): void {
    [this.plr, this.lr] = [this.lr, this.plr];
    [this.pli, this.li] = [this.li, this.pli];
    [this.prr, this.rr] = [this.rr, this.prr];
    [this.pri, this.ri] = [this.ri, this.pri];
    const { N, half, win, re, im } = this;
    const len = L.length;
    for (let i = 0; i < N; i++) {
      const idx = a - half + i;
      if (idx < 0 || idx >= len) { re[i] = 0; im[i] = 0; continue; }
      re[i] = (subL ? L[idx] - subL[idx] : L[idx]) * win[i];
      im[i] = (subR ? R[idx] - subR[idx] : R[idx]) * win[i];
    }
    this.plan.forward(re, im);
    const { lr, li, rr, ri } = this;
    for (let k = 0; k <= half; k++) {
      const j = (N - k) % N;
      lr[k] = 0.5 * (re[k] + re[j]); li[k] = 0.5 * (im[k] - im[j]);
      rr[k] = 0.5 * (im[k] + im[j]); ri[k] = -0.5 * (re[k] - re[j]);
    }
  }

  /** |L|² + |R|² in bin k. */
  power(k: number): number {
    return this.lr[k] * this.lr[k] + this.li[k] * this.li[k] + this.rr[k] * this.rr[k] + this.ri[k] * this.ri[k];
  }

  /**
   * Bin k's true frequency (radians per sample) over the analysis hop,
   * from its phase advance since the last frame in both channels together,
   * so a partial in the side is tracked as surely as one in the middle.
   */
  omega(k: number, hopA: number): number {
    const w = (TWO_PI * k) / this.N;
    if (hopA <= 0) return w;
    const { lr, li, rr, ri, plr, pli, prr, pri } = this;
    const xr = lr[k] * plr[k] + li[k] * pli[k] + rr[k] * prr[k] + ri[k] * pri[k];
    const xi = li[k] * plr[k] - lr[k] * pli[k] + ri[k] * prr[k] - rr[k] * pri[k];
    let d = Math.atan2(xi, xr) - w * hopA;
    d -= TWO_PI * Math.round(d / TWO_PI);
    return w + d / hopA;
  }

  /**
   * Adds this frame, bin k turned by rot[k], to the output around sample
   * `c` (Hann synthesis window; the inverse is a conjugated forward FFT).
   */
  synthesize(rot: Float64Array, outL: Float32Array, outR: Float32Array, c: number, gain: number): void {
    const { N, half, win, re, im, lr, li, rr, ri } = this;
    let lastR = NaN, cR = 1, sR = 0;
    for (let k = 0; k <= half; k++) {
      const r = rot[k];
      if (r !== lastR) { cR = Math.cos(r); sR = Math.sin(r); lastR = r; }
      const yLr = lr[k] * cR - li[k] * sR, yLi = lr[k] * sR + li[k] * cR;
      const yRr = rr[k] * cR - ri[k] * sR, yRi = rr[k] * sR + ri[k] * cR;
      // Z'(k) = YL + j·YR, then conjugated for the inverse.
      re[k] = yLr - yRi;
      im[k] = -(yLi + yRr);
      if (k > 0 && k < half) {
        // Z'(N−k) = conj(YL) + j·conj(YR), conjugated.
        re[N - k] = yLr + yRi;
        im[N - k] = yLi - yRr;
      }
    }
    this.plan.forward(re, im);
    const start = c - half;
    const len = outL.length;
    for (let i = 0; i < N; i++) {
      const o = start + i;
      if (o < 0 || o >= len) continue;
      const w = win[i] * gain;
      outL[o] += re[i] * w;                    // conj(conj(·)) real part
      outR[o] -= im[i] * w;                    // and imaginary part
    }
  }
}

/**
 * Phase rotations, one per bin, by phase gradient heap integration (Průša
 * & Holighaus 2017) over a chain of bins whose neighbours are the adjacent
 * entries. Bins are visited loudest first across this frame and the last:
 * a peak that was loud in the last frame carries on at its own frequency,
 * and every other bin takes its rotation from a louder neighbour. Partials
 * stay locked to their peaks, and a transient, loud only now, spreads one
 * rotation over all its bins and keeps its shape. A rotation is how far
 * the synthesis phase sits from the analysis phase.
 */
class PhaseField {
  readonly n: number;
  /** This frame, filled by the caller before solve(): power and true frequency per bin. */
  readonly pw: Float64Array;
  readonly omega: Float64Array;
  readonly rot: Float64Array;
  private readonly prevPw: Float64Array;
  private readonly prevRot: Float64Array;
  private readonly done: Uint8Array;
  private readonly hKey: Float64Array;
  private readonly hVal: Int32Array;
  private first = true;

  constructor(n: number) {
    this.n = n;
    this.pw = new Float64Array(n); this.omega = new Float64Array(n); this.rot = new Float64Array(n);
    this.prevPw = new Float64Array(n); this.prevRot = new Float64Array(n);
    this.done = new Uint8Array(n);
    this.hKey = new Float64Array(2 * n); this.hVal = new Int32Array(2 * n);
  }

  /** `advance`: synthesis hop minus analysis hop, the time a partial's phase must gain. */
  solve(advance: number): void {
    const { n, pw, omega, rot, prevPw, prevRot, done, hKey, hVal } = this;
    if (this.first) { rot.fill(0); this.first = false; return; }
    let hn = 0;
    // A max-heap of bins keyed by power: bin i of the last frame is i,
    // bin i of this frame is i + n.
    const push = (key: number, val: number): void => {
      let i = hn++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hKey[p] >= key) break;
        hKey[i] = hKey[p]; hVal[i] = hVal[p]; i = p;
      }
      hKey[i] = key; hVal[i] = val;
    };
    const pop = (): number => {
      const top = hVal[0];
      const key = hKey[--hn], val = hVal[hn];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= hn) break;
        if (c + 1 < hn && hKey[c + 1] > hKey[c]) c++;
        if (hKey[c] <= key) break;
        hKey[i] = hKey[c]; hVal[i] = hVal[c]; i = c;
      }
      hKey[i] = key; hVal[i] = val;
      return top;
    };
    let maxPw = 0;
    for (let i = 0; i < n; i++) if (pw[i] > maxPw) maxPw = pw[i];
    const floor = maxPw * 1e-10;
    let todo = 0;
    for (let i = 0; i < n; i++) {
      if (pw[i] > floor) { done[i] = 0; todo++; } else done[i] = 2;
    }
    for (let i = 0; i < n; i++) push(prevPw[i], i);
    while (todo > 0 && hn > 0) {
      const v = pop();
      if (v < n) {
        // Only a peak carries on in time: a bin between two close
        // partials holds a mixture whose phase advance means nothing.
        if (done[v] !== 0) continue;
        if ((v > 0 && pw[v - 1] > pw[v]) || (v < n - 1 && pw[v + 1] > pw[v])) continue;
        const r = prevRot[v] + omega[v] * advance;
        rot[v] = r - TWO_PI * Math.round(r / TWO_PI);
        done[v] = 1; todo--;
        push(pw[v], v + n);
      } else {
        const k = v - n;
        if (k > 0 && done[k - 1] === 0) { rot[k - 1] = rot[k]; done[k - 1] = 1; todo--; push(pw[k - 1], k - 1 + n); }
        if (k < n - 1 && done[k + 1] === 0) { rot[k + 1] = rot[k]; done[k + 1] = 1; todo--; push(pw[k + 1], k + 1 + n); }
      }
    }
    // Bins under the floor turn with the nearest bin below them.
    for (let i = 0, last = 0; i < n; i++) { if (done[i] === 1) last = rot[i]; else rot[i] = last; }
  }

  /** This frame becomes the last one. */
  commit(): void {
    this.prevPw.set(this.pw);
    this.prevRot.set(this.rot);
  }
}

/** A frame centre's source sample: before the song starts, time runs at unity. */
function sourceAt(warp: (tau: number) => number, c: number): number {
  return c < 0 ? c : Math.round(warp(c));
}

export interface StretchOptions {
  /** FFT size (a power of two). */
  n?: number;
  /** Synthesis hop, samples. */
  hop?: number;
}

/**
 * Plays a stereo signal along `warp`, pitch unchanged, with one frame
 * length: a phase vocoder with one set of rotations for both channels.
 * The repair itself uses stretchTwoBand; this is the single-resolution
 * reference it is measured against.
 */
export function stretchStereo(
  L: Float32Array, R: Float32Array,
  warp: (tau: number) => number, outLength: number,
  onProgress?: (pct: number) => void,
  { n = 4096, hop = 1024 }: StretchOptions = {},
): { L: Float32Array; R: Float32Array } {
  const stft = new Stft(n);
  const K = n / 2 + 1;
  const field = new PhaseField(K);
  const outL = new Float32Array(outLength), outR = new Float32Array(outLength);
  // A periodic Hann, on analysis and synthesis, overlaps to 3N/8 per hop;
  // the inverse transform is N times too big.
  const gain = hop / ((3 / 8) * n) / n;
  // The first frame that reaches sample 0, so the start overlaps in full.
  const m0 = Math.floor(-n / 2 / hop) + 1;
  const frames = Math.ceil((outLength + n / 2) / hop) + 1;
  let prevA = 0;
  for (let m = m0; m < frames; m++) {
    const c = m * hop;
    const a = sourceAt(warp, c);
    const hopA = a - prevA;
    stft.analyze(L, R, a);
    for (let k = 0; k < K; k++) { field.pw[k] = stft.power(k); field.omega[k] = stft.omega(k, hopA); }
    field.solve(hop - hopA);
    field.rot[0] = 0;
    field.rot[K - 1] = 0;                      // DC and Nyquist stay real
    stft.synthesize(field.rot, outL, outR, c, gain);
    field.commit();
    prevA = a;
    if (onProgress && ((m - m0) & 63) === 0) onProgress((m - m0) / (frames - m0));
  }
  return { L: outL, R: outR };
}

/**
 * Plays a stereo signal along `warp`, pitch unchanged, in two bands with
 * one set of phases. `low` is the signal below `fc` (lowBand); the band
 * above is the rest, taken frame by frame. Below fc, 4096-point frames
 * keep bass partials a few hertz apart from beating; above it, 2048-point
 * frames keep drum attacks sharp.
 *
 * The phases come from ONE field: a heap over the full signal's
 * 4096-point bins below fc and its 2048-point bins above, analysed at the
 * same frame centres, with the two runs of bins joined at fc. Both bands
 * synthesize with that field, so a partial in the crossover, split
 * between the bands, adds back in phase, and one straddling fc gets one
 * rotation. (Two bands with phases of their own add a note near fc back
 * at a random level, down to silence.)
 */
export function stretchTwoBand(
  L: Float32Array, R: Float32Array, low: { L: Float32Array; R: Float32Array },
  warp: (tau: number) => number, outLength: number, fs: number, fc: number,
  onProgress?: (pct: number) => void,
): { L: Float32Array; R: Float32Array } {
  const f4 = new Stft(4096), f2 = new Stft(2048);    // the full signal: the field
  const b4 = new Stft(4096), b2 = new Stft(2048);    // the bands: what is heard
  const bin4 = fs / 4096, bin2 = fs / 2048;
  const K4c = Math.floor(fc / bin4);                 // the field's last 4096-point bin
  const K2c = Math.floor(K4c / 2) + 1;               // and its first 2048-point bin
  const n4 = K4c + 1, n2 = 1024 - K2c + 1;
  const field = new PhaseField(n4 + n2);
  // Each band's bins through the crossover, beyond which it is silent.
  const K4hi = Math.min(2048, Math.ceil((fc + 150) / bin4));
  const K2lo = Math.max(1, Math.floor((fc - 150) / bin2));
  const rotLow = new Float64Array(2049), rotHigh = new Float64Array(1025);
  const outL = new Float32Array(outLength), outR = new Float32Array(outLength);
  const Hs = 512;                                    // the field's hop, and the high band's
  const gain2 = Hs / ((3 / 8) * 2048) / 2048;
  const gain4 = (2 * Hs) / ((3 / 8) * 4096) / 4096;  // the low band's frames are every other one
  // From the first low-band frame that reaches sample 0 (and it is even).
  const m0 = -2;
  const frames = Math.ceil((outLength + 2048) / Hs) + 2;
  let prevA = 0;
  for (let m = m0; m < frames; m++) {
    const c = m * Hs;
    const a = sourceAt(warp, c);
    const hopA = a - prevA;
    f4.analyze(L, R, a);
    f2.analyze(L, R, a);
    // A 4096-point Hann sums to twice a 2048-point one: a partial's power
    // reads 4× in the long frame, and is scaled to compare like with like.
    for (let i = 0; i < n4; i++) { field.pw[i] = f4.power(i) / 4; field.omega[i] = f4.omega(i, hopA); }
    for (let j = 0; j < n2; j++) { field.pw[n4 + j] = f2.power(K2c + j); field.omega[n4 + j] = f2.omega(K2c + j, hopA); }
    field.solve(Hs - hopA);
    const rot = field.rot;

    // The high band, every frame: above fc its own bins' rotations, below
    // (the crossover) those of the long bins at the same frequency.
    for (let k = 0; k <= 1024; k++) {
      rotHigh[k] = k >= K2c ? rot[n4 + k - K2c] : k >= K2lo ? rot[Math.min(K4c, 2 * k)] : 0;
    }
    rotHigh[0] = 0;
    rotHigh[1024] = 0;
    b2.analyze(L, R, a, low.L, low.R);
    b2.synthesize(rotHigh, outL, outR, c, gain2);

    // The low band, every other frame: below fc its own bins' rotations,
    // above (the crossover) those of the short bins at the same frequency.
    if ((m & 1) === 0) {
      for (let k = 0; k <= 2048; k++) {
        rotLow[k] = k <= K4c ? rot[k]
          : k <= K4hi ? rot[n4 + Math.min(n2 - 1, Math.max(0, Math.round(k / 2) - K2c))]
          : 0;
      }
      rotLow[0] = 0;
      rotLow[2048] = 0;
      b4.analyze(low.L, low.R, a);
      b4.synthesize(rotLow, outL, outR, c, gain4);
    }

    field.commit();
    prevA = a;
    if (onProgress && ((m - m0) & 63) === 0) onProgress((m - m0) / (frames - m0));
  }
  return { L: outL, R: outR };
}

/**
 * The low band of a stereo pair, below `fc`: a linear-phase FIR (a
 * Blackman-Harris windowed sinc; ±25 Hz transition at 48 kHz, stopband
 * −92 dB) applied by FFT convolution, both channels in one complex
 * transform. The high band is the rest (x − low), so the two sum back to
 * the input exactly, and share one phase field when stretched, so they
 * add back in phase through the transition too.
 */
export function lowBand(L: Float32Array, R: Float32Array, fs: number, fc: number): { L: Float32Array; R: Float32Array } {
  const taps = 8191, mid = (taps - 1) / 2;
  const B = 32768, step = B - taps + 1;
  const plan = new FftPlan(B);
  const hr = new Float64Array(B), hi = new Float64Array(B);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const t = i - mid, x = (TWO_PI * i) / (taps - 1);
    const sinc = t === 0 ? (2 * fc) / fs : Math.sin((TWO_PI * fc * t) / fs) / (Math.PI * t);
    hr[i] = sinc * (0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x));
    sum += hr[i];
  }
  for (let i = 0; i < taps; i++) hr[i] /= sum; // unity at DC
  plan.forward(hr, hi);
  const len = L.length;
  const outL = new Float32Array(len), outR = new Float32Array(len);
  const re = new Float64Array(B), im = new Float64Array(B);
  for (let s = 0; s < len + mid; s += step) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < step && s + i < len; i++) { re[i] = L[s + i]; im[i] = R[s + i]; }
    plan.forward(re, im);
    for (let k = 0; k < B; k++) {
      const a = re[k] * hr[k] - im[k] * hi[k], b = re[k] * hi[k] + im[k] * hr[k];
      re[k] = a; im[k] = -b;                   // conjugated for the inverse
    }
    plan.forward(re, im);
    // Sample s + i of the causal filter is sample s + i − mid of the
    // centred one; the inverse comes out conjugated and B times too big.
    for (let i = 0; i < B; i++) {
      const o = s + i - mid;
      if (o < 0) continue;
      if (o >= len) break;
      outL[o] += re[i] / B;
      outR[o] -= im[i] / B;
    }
  }
  return { L: outL, R: outR };
}

/**
 * Where the two bands meet. Below it, 4096-point frames keep bass partials
 * a few hertz apart from beating; above it, 2048-point frames keep drum
 * attacks sharp.
 */
export const REPAIR_CROSSOVER_HZ = 700;

/** The most a repair may stretch or squeeze any part of a song. */
export const REPAIR_MAX_STRETCH = 0.25;

/** The whole repair: plan the warp from the tempo curve, split the bands, stretch along it. */
export function repairDrift(
  L: Float32Array, R: Float32Array, fs: number, curve: TempoCurve, targetBpm: number,
  onProgress?: (pct: number) => void,
): { L: Float32Array; R: Float32Array; plan: RepairPlan } {
  const plan = planRepair(curve, targetBpm, fs, L.length);
  const low = lowBand(L, R, fs, REPAIR_CROSSOVER_HZ);
  onProgress?.(0.04);
  const out = stretchTwoBand(L, R, low, plan.warp, plan.outLength, fs, REPAIR_CROSSOVER_HZ,
    (p) => onProgress?.(0.04 + 0.96 * p));
  onProgress?.(1);
  return { ...out, plan };
}
