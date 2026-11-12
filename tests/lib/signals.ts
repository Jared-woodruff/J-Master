// Signals with known ground truth, and the measurements the suites share.
// Everything is seeded: a failing number is the same number on every run.

export const FS = 48000;

/** Seeded uniform noise in [0, 1) (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const dbToLin = (db: number) => Math.pow(10, db / 20);
export const linToDb = (lin: number) => 20 * Math.log10(Math.max(lin, 1e-15));

export function sine(freq: number, sec: number, fs = FS, peakDb = 0, phase = 0): Float32Array {
  const n = Math.round(sec * fs);
  const out = new Float32Array(n);
  const a = dbToLin(peakDb);
  const w = (2 * Math.PI * freq) / fs;
  for (let i = 0; i < n; i++) out[i] = a * Math.sin(w * i + phase);
  return out;
}

export function whiteNoise(sec: number, fs = FS, peakDb = -6, seed = 1): Float32Array {
  const n = Math.round(sec * fs);
  const out = new Float32Array(n);
  const r = rng(seed);
  const a = dbToLin(peakDb);
  for (let i = 0; i < n; i++) out[i] = a * (r() * 2 - 1);
  return out;
}

/** Pink noise (Paul Kellet's filter), scaled to `rmsDb`. */
export function pinkNoise(sec: number, fs = FS, rmsDbTarget = -20, seed = 1): Float32Array {
  const n = Math.round(sec * fs);
  const out = new Float32Array(n);
  const r = rng(seed);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  const g = dbToLin(rmsDbTarget - rmsDb(out));
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

export interface Stereo { l: Float32Array; r: Float32Array }

/**
 * A small song: kick, snare, hats, a bass line and a detuned pad, with the
 * pad spread wide. Dense enough to load a compressor and a limiter, with
 * a peak-to-loudness ratio near a real mix's, and its tempo is exact.
 */
export interface SongOptions {
  /** Whether the drums and bass play on beat `b` (default: always). The pad always plays. */
  drums?: (beat: number) => boolean;
  /** Hi-hats per beat (default 2: eighths). 0 = none. */
  hats?: number;
  /** A tempo that moves: beats per minute at time `t` seconds (default: `bpm` throughout). */
  tempoAt?: (t: number) => number;
}

export function song(sec: number, bpm = 120, fs = FS, seed = 7, opts: SongOptions = {}): Stereo {
  const n = Math.round(sec * fs);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const rand = rng(seed);
  const notes = [55, 55, 65.41, 49];
  const hatsPerBeat = opts.hats ?? 2;
  let pos = 0;                                  // this beat's start, in samples
  for (let b = 0; pos < n; b++) {
    const beat = (60 / (opts.tempoAt ? opts.tempoAt(pos / fs) : bpm)) * fs;
    const at = Math.round(pos);
    pos += beat;
    if (opts.drums && !opts.drums(b)) continue;
    // kick on every beat
    for (let i = 0; i < 0.25 * fs && at + i < n; i++) {
      const t = i / fs;
      const v = 0.42 * Math.sin(2 * Math.PI * (48 * t + (90 / 30) * (1 - Math.exp(-30 * t)))) * Math.exp(-t * 14);
      l[at + i] += v; r[at + i] += v;
    }
    // snare on 2 and 4
    if (b % 2 === 1) {
      for (let i = 0; i < 0.18 * fs && at + i < n; i++) {
        const t = i / fs;
        const v = 0.26 * (rand() * 2 - 1) * Math.exp(-t * 26) + 0.16 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30);
        l[at + i] += v; r[at + i] += v;
      }
    }
    // hats (eighths unless told otherwise), slightly right
    for (let h = 0; h < hatsPerBeat; h++) {
      const ht = Math.round(at + (h * beat) / hatsPerBeat);
      let prev = 0;
      for (let i = 0; i < 0.05 * fs && ht + i < n; i++) {
        const w = rand() * 2 - 1;
        const hp = w - prev; prev = w;
        const v = 0.09 * hp * Math.exp(-(i / fs) * 90);
        l[ht + i] += v * 0.8; r[ht + i] += v * 1.1;
      }
    }
    // bass: one note per beat
    const f = notes[Math.floor(b / 4) % notes.length];
    for (let i = 0; i < beat && at + i < n; i++) {
      const t = i / fs;
      const env = Math.min(1, t * 200) * Math.exp(-t * 3);
      const v = 0.24 * env * (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * 2 * f * t));
      l[at + i] += v; r[at + i] += v;
    }
  }
  // pad: a chord, detuned per side
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const sw = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.11 * t);
    let pl = 0, pr = 0;
    for (const f of [220, 277.18, 329.63, 440]) {
      pl += Math.sin(2 * Math.PI * f * 1.003 * t);
      pr += Math.sin(2 * Math.PI * f * 0.997 * t + 1);
    }
    l[i] += 0.05 * pl * (0.6 + 0.4 * sw);
    r[i] += 0.05 * pr * (0.6 + 0.4 * (1 - sw));
  }
  return { l, r };
}

export function rmsDb(x: ArrayLike<number>, from = 0, to = x.length): number {
  let acc = 0;
  for (let i = from; i < to; i++) acc += x[i] * x[i];
  return 10 * Math.log10(Math.max(acc / Math.max(1, to - from), 1e-30));
}

export function peakDb(x: ArrayLike<number>, from = 0, to = x.length): number {
  let p = 0;
  for (let i = from; i < to; i++) { const a = Math.abs(x[i]); if (a > p) p = a; }
  return linToDb(p);
}

/**
 * Amplitude (peak, linear) of the `freq` component over [from, to): a
 * Hann-windowed single-bin DFT, so a neighbour a few bins away doesn't leak
 * into the reading.
 */
export function toneAmp(x: ArrayLike<number>, freq: number, fs = FS, from = 0, to = x.length): number {
  const n = to - from;
  let re = 0, im = 0, wsum = 0;
  const w0 = (2 * Math.PI * freq) / fs;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const v = x[from + i] * w;
    re += v * Math.cos(w0 * i);
    im -= v * Math.sin(w0 * i);
    wsum += w;
  }
  return (2 * Math.hypot(re, im)) / wsum;
}

export const toneDb = (x: ArrayLike<number>, freq: number, fs = FS, from = 0, to = x.length) =>
  linToDb(toneAmp(x, freq, fs, from, to));

/** RMS of (a − b) relative to the RMS of a, dB: how deep two signals null. */
export function nullDb(a: ArrayLike<number>, b: ArrayLike<number>, from = 0, to = Math.min(a.length, b.length)): number {
  let diff = 0, ref = 0;
  for (let i = from; i < to; i++) {
    const d = a[i] - b[i];
    diff += d * d;
    ref += a[i] * a[i];
  }
  if (diff === 0) return -Infinity;
  return 10 * Math.log10(diff / Math.max(ref, 1e-30));
}

export function copy(s: Stereo): Stereo {
  return { l: new Float32Array(s.l), r: new Float32Array(s.r) };
}
