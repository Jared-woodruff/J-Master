// ITU-R BS.1770-4 loudness measurement: K-weighting (high shelf + highpass),
// 400 ms gating blocks at 75% overlap, absolute -70 LUFS gate and relative
// -10 LU gate for the integrated value. Plus momentary (400 ms) and
// short-term (3 s) values for the live meters, and offline true-peak.
import { Biquad } from './biquad';
import { TruePeakDetector } from './limiter';

const BLOCK_SEC = 0.1; // gating hop: 100 ms; a gating block = 4 hops (400 ms)

function makeKFilters(fs: number): [Biquad, Biquad, Biquad, Biquad] {
  const shelfL = new Biquad(); shelfL.setKWeightShelf(fs);
  const hpL = new Biquad(); hpL.setKWeightHighpass(fs);
  const shelfR = new Biquad(); shelfR.setKWeightShelf(fs);
  const hpR = new Biquad(); hpR.setKWeightHighpass(fs);
  return [shelfL, hpL, shelfR, hpR];
}

function energyToLufs(energy: number): number {
  return -0.691 + 10 * Math.log10(Math.max(energy, 1e-12));
}

/**
 * Streaming loudness meter for the live UI: feeds per-sample, exposes
 * momentary / short-term / integrated (gated, recomputed periodically).
 */
export class LoudnessMeter {
  private shelfL: Biquad; private hpL: Biquad;
  private shelfR: Biquad; private hpR: Biquad;
  private hopLen: number;
  private hopAcc = 0;
  private hopCount = 0;
  private hops: number[] = [];  // mean-square energy per 100 ms hop
  momentary = -70;
  shortTerm = -70;
  integrated = -70;

  constructor(private fs: number) {
    [this.shelfL, this.hpL, this.shelfR, this.hpR] = makeKFilters(fs);
    this.hopLen = Math.round(fs * BLOCK_SEC);
  }

  reset(): void {
    this.shelfL.reset(); this.hpL.reset(); this.shelfR.reset(); this.hpR.reset();
    this.hopAcc = 0; this.hopCount = 0; this.hops.length = 0;
    this.momentary = -70; this.shortTerm = -70; this.integrated = -70;
  }

  processBlock(L: Float32Array, R: Float32Array, start: number, len: number): void {
    let hopAcc = this.hopAcc, hopCount = this.hopCount;
    for (let i = start; i < start + len; i++) {
      const kl = this.hpL.process(this.shelfL.process(L[i]));
      const kr = this.hpR.process(this.shelfR.process(R[i]));
      hopAcc += kl * kl + kr * kr;
      hopCount++;
      if (hopCount >= this.hopLen) {
        this.hops.push(hopAcc / this.hopLen);
        hopAcc = 0; hopCount = 0;
        this.updateReadings();
      }
    }
    this.hopAcc = hopAcc; this.hopCount = hopCount;
  }

  private updateReadings(): void {
    const hops = this.hops;
    const n = hops.length;
    // Momentary: last 4 hops (400 ms).
    if (n >= 4) {
      let e = 0;
      for (let i = n - 4; i < n; i++) e += hops[i];
      this.momentary = energyToLufs(e / 4);
    }
    // Short-term: last 30 hops (3 s).
    if (n >= 30) {
      let e = 0;
      for (let i = n - 30; i < n; i++) e += hops[i];
      this.shortTerm = energyToLufs(e / 30);
    } else if (n >= 4) {
      let e = 0;
      for (let i = 0; i < n; i++) e += hops[i];
      this.shortTerm = energyToLufs(e / n);
    }
    // Integrated (gated): recompute every 5 hops to keep it cheap.
    if (n >= 4 && n % 5 === 0) this.integrated = gatedLoudnessFromHops(hops);
  }
}

/** Gated integrated loudness from 100 ms hop energies (blocks = 4 hops). */
export function gatedLoudnessFromHops(hops: number[]): number {
  const blocks: number[] = [];
  for (let i = 0; i + 4 <= hops.length; i++) {
    blocks.push((hops[i] + hops[i + 1] + hops[i + 2] + hops[i + 3]) / 4);
  }
  if (blocks.length === 0) return -70;
  const absGate: number[] = [];
  for (const e of blocks) {
    if (energyToLufs(e) > -70) absGate.push(e);
  }
  if (absGate.length === 0) return -70;
  let mean = 0;
  for (const e of absGate) mean += e;
  mean /= absGate.length;
  const relThresh = energyToLufs(mean) - 10;
  let sum = 0, count = 0;
  for (const e of absGate) {
    if (energyToLufs(e) > relThresh) { sum += e; count++; }
  }
  if (count === 0) return -70;
  return energyToLufs(sum / count);
}

/** K-weighted 100 ms hop energies for a whole buffer. */
export function computeLoudnessHops(L: Float32Array, R: Float32Array, fs: number): number[] {
  const [shelfL, hpL, shelfR, hpR] = makeKFilters(fs);
  const hopLen = Math.round(fs * BLOCK_SEC);
  const hops: number[] = [];
  let acc = 0, cnt = 0;
  for (let i = 0; i < L.length; i++) {
    const kl = hpL.process(shelfL.process(L[i]));
    const kr = hpR.process(shelfR.process(R[i]));
    acc += kl * kl + kr * kr;
    if (++cnt >= hopLen) {
      hops.push(acc / hopLen);
      acc = 0; cnt = 0;
    }
  }
  return hops;
}

/** Offline integrated LUFS of a whole buffer. */
export function measureIntegratedLufs(L: Float32Array, R: Float32Array, fs: number): number {
  return gatedLoudnessFromHops(computeLoudnessHops(L, R, fs));
}

/**
 * Short-term (3 s) loudness series from hop energies, one value per
 * `strideHops` hops (default 5 → a point every 0.5 s).
 */
export function shortTermSeriesFromHops(hops: number[], strideHops = 5): Float32Array {
  const points = Math.max(1, Math.floor(hops.length / strideHops));
  const out = new Float32Array(points);
  for (let p = 0; p < points; p++) {
    const end = (p + 1) * strideHops;
    const startIdx = Math.max(0, end - 30);
    let e = 0;
    for (let i = startIdx; i < end && i < hops.length; i++) e += hops[i];
    out[p] = energyToLufs(e / Math.max(1, Math.min(end, hops.length) - startIdx));
  }
  return out;
}

/**
 * Loudness range per EBU R128: distribution of gated 3 s short-term values,
 * LRA = 95th − 10th percentile (absolute gate −70, relative gate I − 20).
 */
export function loudnessRangeFromHops(hops: number[]): number {
  const stVals: number[] = [];
  for (let end = 30; end <= hops.length; end++) {
    let e = 0;
    for (let i = end - 30; i < end; i++) e += hops[i];
    const lv = energyToLufs(e / 30);
    if (lv > -70) stVals.push(lv);
  }
  if (stVals.length < 2) return 0;
  const integrated = gatedLoudnessFromHops(hops);
  const gated = stVals.filter((v) => v > integrated - 20).sort((a, b) => a - b);
  if (gated.length < 2) return 0;
  const p10 = gated[Math.floor(gated.length * 0.1)];
  const p95 = gated[Math.min(gated.length - 1, Math.floor(gated.length * 0.95))];
  return p95 - p10;
}

/** Offline true peak (dBTP) of a whole buffer via 4x interpolation. */
export function measureTruePeakDb(L: Float32Array, R: Float32Array): number {
  const tl = new TruePeakDetector();
  const tr = new TruePeakDetector();
  let peak = 0;
  for (let i = 0; i < L.length; i++) {
    const p = Math.max(tl.process(L[i]), tr.process(R[i]));
    if (p > peak) peak = p;
  }
  return 20 * Math.log10(Math.max(peak, 1e-10));
}

/** Sample peak in dBFS. */
export function measureSamplePeakDb(L: Float32Array, R: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < L.length; i++) {
    const a = Math.abs(L[i]);
    const b = Math.abs(R[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  return 20 * Math.log10(Math.max(peak, 1e-10));
}
