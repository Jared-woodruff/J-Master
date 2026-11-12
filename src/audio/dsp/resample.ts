// Sample-rate conversion: a polyphase Kaiser-windowed sinc, zero phase.
//
// The engine runs at 48 kHz. Files at another rate come in through here
// (the browser's own decoder resampler rolls the top octave off), and a
// master leaves through here when it is delivered at 44.1 kHz.
//
// The filter's transition band is centred on the lower of the two Nyquist
// frequencies: flat to the passband edge (20 kHz for the audio rates), and
// down by STOP_DB from the mirror of that edge on. Whatever folds or images
// lands above the passband edge, at −STOP_DB or lower anywhere below it.

/** Stopband attenuation of the conversion filter, dB. */
export const RESAMPLE_STOP_DB = 130;
/** Passband edge for rates whose Nyquist clears it, Hz. */
const AUDIO_EDGE_HZ = 20000;
/** Most phases kept exactly; a ratio needing more interpolates between them. */
const MAX_PHASES = 2048;

function besselI0(x: number): number {
  let sum = 1, term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

function gcd(a: number, b: number): number {
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}

export interface ResamplePlan {
  inRate: number;
  outRate: number;
  /** Taps per phase (input samples each output reads). */
  taps: number;
  /** Phases in the table. */
  phases: number;
  /** True when each output's phase is one of the table's exactly. */
  exact: boolean;
  /** Flat to here, Hz. */
  passbandHz: number;
  /** Down by RESAMPLE_STOP_DB from here on, Hz. */
  stopbandHz: number;
  table: Float64Array;
}

const plans = new Map<string, ResamplePlan>();

/** The conversion filter for a pair of rates (designed once, then kept). */
export function planResample(inRate: number, outRate: number): ResamplePlan {
  const key = `${inRate}>${outRate}`;
  const hit = plans.get(key);
  if (hit) return hit;

  const nyq = Math.min(inRate, outRate) / 2;
  const passbandHz = nyq > AUDIO_EDGE_HZ * 1.05 ? AUDIO_EDGE_HZ : nyq * 0.9;
  const stopbandHz = 2 * nyq - passbandHz;
  // Everything below is in cycles per INPUT sample.
  const fc = nyq / inRate;
  const width = (stopbandHz - passbandHz) / inRate;
  const A = RESAMPLE_STOP_DB;
  const beta = 0.1102 * (A - 8.7);
  let taps = Math.ceil((A - 7.95) / (2.285 * 2 * Math.PI * width)) + 1;
  taps += taps & 1;                       // even: the window straddles the output instant
  const half = taps / 2;

  const g = gcd(Math.round(inRate), Math.round(outRate));
  const L = Math.round(outRate) / g;
  const exact = Number.isInteger(inRate) && Number.isInteger(outRate) && L <= MAX_PHASES;
  const phases = exact ? L : MAX_PHASES;
  // One extra row when interpolating, so phase p + 1 always exists.
  const rows = exact ? phases : phases + 1;
  const table = new Float64Array(rows * taps);
  const i0beta = besselI0(beta);
  for (let p = 0; p < rows; p++) {
    const frac = p / phases;
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      // Tap j reads input sample i0 + j − half + 1; the output sits at i0 + frac.
      const t = j - half + 1 - frac;
      const r = t / half;
      const w = Math.abs(r) < 1 ? besselI0(beta * Math.sqrt(1 - r * r)) / i0beta : 0;
      const a = 2 * Math.PI * fc * t;
      const s = Math.abs(a) < 1e-9 ? 2 * fc : (2 * fc * Math.sin(a)) / a;
      const v = s * w;
      table[p * taps + j] = v;
      sum += v;
    }
    // Unity gain at DC for every phase: truncation ripple can't modulate level.
    for (let j = 0; j < taps; j++) table[p * taps + j] /= sum;
  }
  const plan: ResamplePlan = { inRate, outRate, taps, phases, exact, passbandHz, stopbandHz, table };
  plans.set(key, plan);
  return plan;
}

/** How many samples `length` samples at `inRate` become at `outRate`. */
export function resampledLength(length: number, inRate: number, outRate: number): number {
  return Math.max(length > 0 ? 1 : 0, Math.round((length * outRate) / inRate));
}

/**
 * Converts one channel. Output sample n sits at input time n · inRate /
 * outRate: no delay, and the same duration. Samples outside the input read
 * as silence.
 */
export function resample(
  x: Float32Array, inRate: number, outRate: number, onProgress?: (pct: number) => void,
): Float32Array {
  if (inRate === outRate) return new Float32Array(x);
  const plan = planResample(inRate, outRate);
  const { taps, phases, table, exact } = plan;
  const half = taps / 2;
  const n = x.length;
  const outLen = resampledLength(n, inRate, outRate);
  const out = new Float32Array(outLen);
  const step = inRate / outRate;
  const g = gcd(Math.round(inRate), Math.round(outRate));
  const M = Math.round(inRate) / g;
  const L = Math.round(outRate) / g;
  const chunk = 1 << 18;

  for (let o = 0; o < outLen; o++) {
    let i0: number, row: number, mix = 0;
    if (exact) {
      // Integer arithmetic: the position never accumulates rounding.
      const num = o * M;
      i0 = Math.floor(num / L);
      row = (num - i0 * L) * taps;
    } else {
      const pos = o * step;
      i0 = Math.floor(pos);
      const fp = (pos - i0) * phases;
      const p = Math.floor(fp);
      mix = fp - p;
      row = p * taps;
    }
    const first = i0 - half + 1;
    let acc = 0;
    if (first >= 0 && first + taps <= n) {
      if (mix === 0) {
        for (let j = 0; j < taps; j++) acc += table[row + j] * x[first + j];
      } else {
        const next = row + taps;
        for (let j = 0; j < taps; j++) {
          const h = table[row + j];
          acc += (h + mix * (table[next + j] - h)) * x[first + j];
        }
      }
    } else {
      const next = row + taps;
      for (let j = 0; j < taps; j++) {
        const k = first + j;
        if (k < 0 || k >= n) continue;
        const h = table[row + j];
        acc += (mix === 0 ? h : h + mix * (table[next + j] - h)) * x[k];
      }
    }
    out[o] = acc;
    if (onProgress && (o & (chunk - 1)) === 0) onProgress(o / outLen);
  }
  return out;
}

/** Converts a stereo pair (progress runs 0..1 across both channels). */
export function resampleStereo(
  L: Float32Array, R: Float32Array, inRate: number, outRate: number, onProgress?: (pct: number) => void,
): { L: Float32Array; R: Float32Array } {
  if (inRate === outRate) return { L: new Float32Array(L), R: new Float32Array(R) };
  const outL = resample(L, inRate, outRate, onProgress && ((p) => onProgress(p * 0.5)));
  const outR = resample(R, inRate, outRate, onProgress && ((p) => onProgress(0.5 + p * 0.5)));
  return { L: outL, R: outR };
}
