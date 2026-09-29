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
// apart need long frames, drum attacks short ones), so the track is split
// into two bands, each stretched with its own. Where the warp runs at unity
// the output equals the input.
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

export interface StretchOptions {
  /** FFT size (a power of two). */
  n?: number;
  /** Synthesis hop, samples. */
  hop?: number;
  /** The band (Hz) the input carries; phase work is spent there only. */
  band?: [number, number];
  fs?: number;
  /** Buffers to add the output into (both outLength long); new ones by default. */
  into?: { L: Float32Array; R: Float32Array };
}

/**
 * Plays a stereo signal along `warp`, pitch unchanged: a phase vocoder
 * whose phases come from phase gradient heap integration, with one set of
 * phase rotations for both channels. Both channels travel in one complex
 * FFT (L real, R imaginary).
 */
export function stretchStereo(
  L: Float32Array, R: Float32Array,
  warp: (tau: number) => number, outLength: number,
  onProgress?: (pct: number) => void,
  { n = 4096, hop = 1024, band, fs = 48000, into }: StretchOptions = {},
): { L: Float32Array; R: Float32Array } {
  const N = n, Hs = hop, half = N / 2, K = half + 1;
  const plan = new FftPlan(N);
  const len = L.length;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / N);
  // A periodic Hann, applied on analysis and synthesis, overlaps to 3N/8
  // per hop; the inverse transform is N times too big.
  const scale = Hs / ((3 / 8) * N) / N;
  const kLo = band ? Math.max(0, Math.floor((band[0] * N) / fs)) : 0;
  const kHi = band ? Math.min(half, Math.ceil((band[1] * N) / fs)) : half;

  const outL = into?.L ?? new Float32Array(outLength);
  const outR = into?.R ?? new Float32Array(outLength);
  const re = new Float64Array(N), im = new Float64Array(N);
  const lr = new Float64Array(K), li = new Float64Array(K);       // left spectrum
  const rr = new Float64Array(K), ri = new Float64Array(K);       // right spectrum
  const pw = new Float64Array(K), prevPw = new Float64Array(K);   // |L|² + |R|²
  const phi = new Float64Array(K), prevPhi = new Float64Array(K); // phase of L + R
  const rot = new Float64Array(K), prevRot = new Float64Array(K);
  const done = new Uint8Array(K);

  // A max-heap of bins keyed by power: bin k of the last frame is k, bin k
  // of this frame is k + K.
  const hKey = new Float64Array(2 * K), hVal = new Int32Array(2 * K);
  let hn = 0;
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

  let prevA = 0;
  let first = true;
  const frames = Math.ceil((outLength + half) / Hs) + 1;

  for (let m = 0; m < frames; m++) {
    const c = m * Hs;                          // output frame centre
    const a = Math.round(warp(c));             // source frame centre
    // Analysis: both channels in one transform.
    for (let i = 0; i < N; i++) {
      const idx = a - half + i;
      const inside = idx >= 0 && idx < len;
      re[i] = inside ? L[idx] * win[i] : 0;
      im[i] = inside ? R[idx] * win[i] : 0;
    }
    plan.forward(re, im);
    let maxPw = 0;
    for (let k = 0; k <= half; k++) {
      const j = (N - k) % N;
      lr[k] = 0.5 * (re[k] + re[j]); li[k] = 0.5 * (im[k] - im[j]);
      rr[k] = 0.5 * (im[k] + im[j]); ri[k] = -0.5 * (re[k] - re[j]);
      if (k < kLo || k > kHi) continue;
      phi[k] = Math.atan2(li[k] + ri[k], lr[k] + rr[k]);
      pw[k] = lr[k] * lr[k] + li[k] * li[k] + rr[k] * rr[k] + ri[k] * ri[k];
      if (pw[k] > maxPw) maxPw = pw[k];
    }
    const hopA = a - prevA;

    if (first) {
      rot.fill(0);
    } else {
      // Bins are visited loudest first, across this frame and the last. A
      // peak that was loud in the last frame carries on in time, its phase
      // moving at its own true frequency; a bin loud in this frame hands
      // its rotation to its quieter neighbours. Partials stay locked to
      // their peaks, and a transient, loud only now, spreads one rotation
      // over all its bins and keeps its shape.
      const floor = maxPw * 1e-10;
      let todo = 0;
      for (let k = kLo; k <= kHi; k++) {
        if (pw[k] > floor) { done[k] = 0; todo++; } else done[k] = 2;
      }
      hn = 0;
      for (let k = kLo; k <= kHi; k++) push(prevPw[k], k);
      while (todo > 0 && hn > 0) {
        const v = pop();
        if (v < K) {
          // Only a peak carries on in time: a bin between two close
          // partials holds a mixture whose phase advance means nothing.
          if (done[v] !== 0) continue;
          if ((v > kLo && pw[v - 1] > pw[v]) || (v < kHi && pw[v + 1] > pw[v])) continue;
          const omega = (TWO_PI * v) / N;
          let w = omega;
          if (hopA > 0) {
            let d = phi[v] - prevPhi[v] - omega * hopA;
            d -= TWO_PI * Math.round(d / TWO_PI);
            w = omega + d / hopA;
          }
          // Synthesis phase = the last synthesis phase + ω·Hs, kept as a
          // rotation away from the analysis phase.
          const r = prevPhi[v] + prevRot[v] + w * Hs - phi[v];
          rot[v] = r - TWO_PI * Math.round(r / TWO_PI);
          done[v] = 1; todo--;
          push(pw[v], v + K);
        } else {
          const k = v - K;
          if (k > kLo && done[k - 1] === 0) { rot[k - 1] = rot[k]; done[k - 1] = 1; todo--; push(pw[k - 1], k - 1 + K); }
          if (k < kHi && done[k + 1] === 0) { rot[k + 1] = rot[k]; done[k + 1] = 1; todo--; push(pw[k + 1], k + 1 + K); }
        }
      }
      // Bins under the floor turn with the nearest bin below them; outside
      // the band there is nothing to turn.
      for (let k = 0, last = 0; k <= half; k++) {
        if (k < kLo || k > kHi) rot[k] = 0;
        else if (done[k] === 1) last = rot[k];
        else rot[k] = last;
      }
    }
    rot[0] = 0;
    rot[half] = 0;                             // DC and Nyquist stay real
    first = false;

    // Rotate both channels; synthesize both in one inverse transform
    // (L real, R imaginary; the inverse is a conjugated forward FFT).
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
    plan.forward(re, im);
    const start = c - half;
    for (let i = 0; i < N; i++) {
      const o = start + i;
      if (o < 0 || o >= outLength) continue;
      const w = win[i] * scale;
      outL[o] += re[i] * w;                    // conj(conj(·)) real part
      outR[o] -= im[i] * w;                    // and imaginary part
    }

    prevA = a;
    prevPhi.set(phi); prevPw.set(pw); prevRot.set(rot);
    if (onProgress && (m & 63) === 0) onProgress(m / frames);
  }
  return { L: outL, R: outR };
}

/**
 * The low band of a stereo pair, below `fc`: a linear-phase FIR (a
 * Blackman-Harris windowed sinc; ±25 Hz transition at 48 kHz, stopband
 * −92 dB) applied by FFT convolution, both channels in one complex
 * transform. The high band is the rest (x − low), so the two sum back to
 * the input exactly. The two bands' stretches are not quite coherent where
 * they overlap, so the transition is kept narrow.
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

/** The whole repair: plan the warp from the tempo curve, stretch both bands along it, sum. */
export function repairDrift(
  L: Float32Array, R: Float32Array, fs: number, curve: TempoCurve, targetBpm: number,
  onProgress?: (pct: number) => void,
): { L: Float32Array; R: Float32Array; plan: RepairPlan } {
  const plan = planRepair(curve, targetBpm, fs, L.length);
  const fc = REPAIR_CROSSOVER_HZ;
  const band = lowBand(L, R, fs, fc);
  onProgress?.(0.04);
  const out = stretchStereo(band.L, band.R, plan.warp, plan.outLength,
    (p) => onProgress?.(0.04 + 0.36 * p), { n: 4096, hop: 1024, band: [0, 2 * fc], fs });
  // The high band, in the low band's buffers.
  for (let i = 0; i < L.length; i++) { band.L[i] = L[i] - band.L[i]; band.R[i] = R[i] - band.R[i]; }
  stretchStereo(band.L, band.R, plan.warp, plan.outLength,
    (p) => onProgress?.(0.4 + 0.6 * p), { n: 2048, hop: 512, band: [fc / 2, fs / 2], fs, into: out });
  onProgress?.(1);
  return { ...out, plan };
}
