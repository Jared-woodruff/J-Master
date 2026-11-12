// What a file itself says about how it was made, read once at load: where
// its spectrum stops, how it starts and ends, and whether its peaks were
// already cut off. Each is a measurement first; the check sheet decides
// what to offer.
import { fft } from '../dsp/fft';

export interface SourceChecks {
  /**
   * Where the spectrum stops dead (Hz), when it does: a generator's or a
   * lossy codec's low-pass. Null when the top rolls off naturally, runs to
   * the engine's limit, or the track is too short or quiet to tell.
   */
  cutoffHz: number | null;
  /** How far the spectrum falls across the cut, dB. 0 without one. */
  cutoffDropDb: number;
  /** Silence before the first sound and after the last, s. */
  headSilenceSec: number;
  tailSilenceSec: number;
  /** Level of the first and last 10 ms of sound, dBFS RMS. */
  startLevelDb: number;
  endLevelDb: number;
  /** The track begins mid-sound: its first samples are already loud. */
  abruptStart: boolean;
  /** The track stops mid-sound instead of dying away. */
  abruptEnd: boolean;
  /**
   * Flat tops: runs of three or more identical samples at the file's own
   * peak. Counted on the file's own samples, before any rate conversion
   * (which turns a flat top into a ripple).
   */
  clippedRuns: number;
  /** Mean of the samples as a share of full scale (DC offset), per channel. */
  dcOffset: number;
}

/** Quieter than this is silence. */
const SILENCE_DB = -60;
/** A start or an end louder than this, with no ramp, is abrupt. */
const ABRUPT_DB = -36;
const WIN_SEC = 0.01;

const FFT_SIZE = 4096;
/** Band grid for the cutoff search: BAND_HZ-wide bands from SEARCH_LO up. */
const BAND_HZ = 250;
const SEARCH_LO_HZ = 6000;
/** The spectrum must fall at least this far within one band's width… */
const MIN_DROP_DB = 22;
/** …from content at least this loud (per-bin power, dBFS), to count as a cut. */
const MIN_CONTENT_DB = -95;
/** A cut above this is as good as full bandwidth (a 44.1 kHz file stops at 22 kHz by nature). */
export const FULL_BAND_HZ = 19500;

/**
 * The sign that makes L + sign × R the fuller mono sum: −1 for a source
 * with one side inverted, whose plain sum is next to nothing. Every
 * analysis that listens in mono (the tempo, the spectrum, the waveform)
 * uses it, so such a file is still read as music, and the check sheet can
 * say what is wrong with it.
 */
export function monoSign(L: Float32Array, R: Float32Array): 1 | -1 {
  let lr = 0;
  // A stride is plenty: this is a sign, not a measurement.
  for (let i = 0; i < L.length; i += 5) lr += L[i] * R[i];
  return lr < 0 ? -1 : 1;
}

/**
 * Flat tops in a file: runs of three or more samples that are the same
 * value (to one part in a million) and within 2% of the file's peak. A
 * waveform that merely crests there keeps moving from sample to sample; one
 * that was cut off does not. A file turned down after it was clipped still
 * shows them, so its own peak is the reference, not full scale.
 */
export function countClippedRuns(L: Float32Array, R: Float32Array): number {
  const n = L.length;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(L[i]), b = Math.abs(R[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  // Too quiet to say anything about (and silence is one long flat run).
  if (peak < 0.1) return 0;
  const near = peak * 0.98;
  const same = peak * 1e-6;
  let runs = 0;
  for (const x of [L, R]) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && Math.abs(x[i]) >= near && Math.abs(x[i] - x[i - 1]) <= same) run++;
      else { if (run >= 3) runs++; run = 1; }
    }
  }
  return runs;
}

/**
 * `clippedRuns`: the count from the file's own samples, when the audio
 * here has been through a rate conversion since.
 */
export function analyzeSource(L: Float32Array, R: Float32Array, fs: number, clippedRuns?: number): SourceChecks {
  const n = L.length;
  const win = Math.max(1, Math.round(fs * WIN_SEC));
  const silence = Math.pow(10, SILENCE_DB / 20);

  // ── silence at the ends ──────────────────────────────────────────────
  let first = 0;
  while (first < n && Math.abs(L[first]) < silence && Math.abs(R[first]) < silence) first++;
  let last = n - 1;
  while (last > first && Math.abs(L[last]) < silence && Math.abs(R[last]) < silence) last--;
  const empty = first >= n;
  const headSilenceSec = empty ? 0 : first / fs;
  const tailSilenceSec = empty ? 0 : (n - 1 - last) / fs;

  // ── how it starts and ends ───────────────────────────────────────────
  const rms = (from: number, to: number): number => {
    let acc = 0;
    const a = Math.max(0, from), b = Math.min(n, to);
    for (let i = a; i < b; i++) acc += L[i] * L[i] + R[i] * R[i];
    return b > a ? 10 * Math.log10(acc / (2 * (b - a)) + 1e-20) : -200;
  };
  const startLevelDb = empty ? -200 : rms(first, first + win);
  const endLevelDb = empty ? -200 : rms(last + 1 - win, last + 1);
  // Abrupt: loud from the very first (or to the very last) sample of the
  // FILE. A track with silence around it was given room; one that rises or
  // dies away inside its first or last 10 ms reads far quieter there than
  // a moment later.
  const bodyStartDb = empty ? -200 : rms(first + win, first + 5 * win);
  const bodyEndDb = empty ? -200 : rms(last + 1 - 5 * win, last + 1 - win);
  const startsHot = !empty && first === 0 && Math.max(Math.abs(L[0]), Math.abs(R[0])) > Math.pow(10, ABRUPT_DB / 20);
  const abruptStart = startsHot && startLevelDb > ABRUPT_DB && startLevelDb > bodyStartDb - 6;
  const abruptEnd = !empty && tailSilenceSec < WIN_SEC && endLevelDb > ABRUPT_DB && endLevelDb > bodyEndDb - 6;

  // ── DC ───────────────────────────────────────────────────────────────
  let sumL = 0, sumR = 0;
  for (let i = 0; i < n; i++) { sumL += L[i]; sumR += R[i]; }
  const dcOffset = n > 0 ? Math.max(Math.abs(sumL), Math.abs(sumR)) / n : 0;

  const { cutoffHz, cutoffDropDb } = findCutoff(L, R, fs, first, last + 1);
  return {
    cutoffHz, cutoffDropDb, headSilenceSec, tailSilenceSec, startLevelDb, endLevelDb,
    abruptStart, abruptEnd, clippedRuns: clippedRuns ?? countClippedRuns(L, R), dcOffset,
  };
}

/**
 * The long-term spectrum's cliff, if it has one. Averaged over up to 240
 * frames spread across the sounding part of the track, then read on a
 * 250 Hz grid: a cut is the band where the level just below stands at
 * least MIN_DROP_DB over everything above it.
 */
function findCutoff(
  L: Float32Array, R: Float32Array, fs: number, from: number, to: number,
): { cutoffHz: number | null; cutoffDropDb: number } {
  const none = { cutoffHz: null, cutoffDropDb: 0 };
  const span = to - from;
  if (span < FFT_SIZE * 8) return none;
  const frames = Math.min(240, Math.floor(span / FFT_SIZE));
  const hop = Math.floor((span - FFT_SIZE) / Math.max(1, frames - 1));
  const half = FFT_SIZE / 2;
  const power = new Float64Array(half);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const w = new Float64Array(FFT_SIZE);
  // Blackman-Harris: its side lobes (−92 dB) stay under the floor being
  // looked for; a Hann window's would smear the cliff into a slope.
  for (let i = 0; i < FFT_SIZE; i++) {
    const a = (2 * Math.PI * i) / (FFT_SIZE - 1);
    w[i] = 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a);
  }
  const norm = 1 / (FFT_SIZE * 0.35875 / 2);
  for (let f = 0; f < frames; f++) {
    const s = from + f * hop;
    for (let i = 0; i < FFT_SIZE; i++) { re[i] = 0.5 * (L[s + i] + R[s + i]) * w[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < half; k++) power[k] += (re[k] * re[k] + im[k] * im[k]) * norm * norm;
  }
  const binHz = fs / FFT_SIZE;
  const top = fs / 2 - 500;
  const bands: number[] = [];
  const bandF: number[] = [];
  for (let f0 = SEARCH_LO_HZ - 4 * BAND_HZ; f0 + BAND_HZ <= top; f0 += BAND_HZ) {
    const k0 = Math.floor(f0 / binHz), k1 = Math.floor((f0 + BAND_HZ) / binHz);
    let acc = 0;
    for (let k = k0; k < k1; k++) acc += power[k];
    bands.push(10 * Math.log10(acc / Math.max(1, k1 - k0) / frames + 1e-30));
    bandF.push(f0);
  }
  // For each band edge: the level over the kilohertz below it, against the
  // loudest band anywhere above it.
  let best = -1, bestDrop = 0;
  for (let b = 4; b < bands.length - 1; b++) {
    const below = (bands[b - 1] + bands[b - 2] + bands[b - 3] + bands[b - 4]) / 4;
    if (below < MIN_CONTENT_DB) continue;
    let above = -Infinity;
    for (let j = b + 1; j < bands.length; j++) if (bands[j] > above) above = bands[j];
    const drop = below - above;
    if (drop >= MIN_DROP_DB && drop > bestDrop) { bestDrop = drop; best = b; }
  }
  if (best < 0) return none;
  // The edge itself. The band found above sits where the drop is deepest,
  // which is the far side of the cliff; the edge is where the level first
  // falls 12 dB under the content a kilohertz or two before it.
  let ref = -Infinity;
  for (let j = Math.max(0, best - 8); j <= best - 3; j++) if (bands[j] > ref) ref = bands[j];
  if (!Number.isFinite(ref)) ref = bands[best - 1];
  const mid = ref - 12;
  let k = Math.floor(bandF[Math.max(0, best - 6)] / binHz);
  const kEnd = Math.floor((bandF[best] + 2 * BAND_HZ) / binHz);
  const smooth = (i: number) => {
    let acc = 0;
    for (let j = i - 2; j <= i + 2; j++) acc += power[Math.max(0, Math.min(half - 1, j))];
    return 10 * Math.log10(acc / 5 / frames + 1e-30);
  };
  while (k < kEnd && smooth(k) > mid) k++;
  const cutoffHz = Math.round((k * binHz) / 50) * 50;
  return { cutoffHz, cutoffDropDb: bestDrop };
}
