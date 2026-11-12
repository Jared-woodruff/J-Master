// The offline master, shared by the export and the OUT preview so the
// preview is the export: the chain at nominal staging, then the loudness
// solve through the peak clipper (when it is in) and the final true-peak
// limiter. Every stage is latency compensated, so the master lines up with
// the source sample for sample and keeps its last milliseconds.
//
// A master delivered at another rate is converted BEFORE the solve: the
// clipper and limiter then work on the very samples that are written, and
// the loudness and the ceiling are measured at the delivered rate.
import { MasterChain } from '../dsp/chain';
import { Clipper } from '../dsp/clipper';
import { Limiter, TruePeakEnvelope } from '../dsp/limiter';
import { measureIntegratedLufs } from '../dsp/loudness';
import { ChainParams, dbToLin, keptRange, stagingGainDbFor } from '../dsp/params';
import { resample } from '../dsp/resample';

export const RENDER_BLOCK = 4096;
/** The loudness solve stops within this of the target… */
const SOLVE_TOL_LU = 0.05;
/** …or after this many limiter passes, keeping the closest. */
const SOLVE_MAX_PASSES = 8;
/** One solve step never adds more than this. */
const SOLVE_MAX_STEP_DB = 6;
/**
 * Under this many LU per dB of gain, the output stages have stopped giving
 * loudness: the target is out of reach under this ceiling, and more gain
 * only buys distortion.
 */
const PLATEAU_SLOPE = 0.2;
/** When the target is out of reach: the least gain that comes this close to the loudest pass. */
const PLATEAU_KEEP_LU = 0.3;
/** A master this close to its target has reached it. */
export const TARGET_REACHED_LU = 0.15;

export interface MasterRender {
  /** The master, as long as the source (silent outside a trim). */
  L: Float32Array;
  R: Float32Array;
  /** The rate L and R are at. */
  fs: number;
  /** The samples a trim keeps: [keepStart, keepEnd). The whole master without one. */
  keepStart: number;
  keepEnd: number;
  /** Integrated loudness of the master; −70 when nothing clears the gate. */
  lufs: number;
  /** Gain into the output stages, as rendered. */
  appliedGainDb: number;
  limiterMaxGrDb: number;
  /** Deepest cut the clipper made (0 with CLIP off). */
  clipMaxGrDb: number;
  /** False when the source was too quiet (or short) to measure: unity gain. */
  measured: boolean;
  /**
   * False when the loudness target can't be had under this ceiling (the
   * limiter runs out of loudness to give): `lufs` is where it landed.
   */
  reached: boolean;
}

export interface MasterOptions {
  /** Rate to deliver at; the chain itself always runs at the source's. */
  outRate?: number;
  onProgress?: (phase: string, pct: number) => void;
}

export function renderMaster(
  srcL: Float32Array,
  srcR: Float32Array,
  fs: number,
  params: ChainParams,
  sourceLufs: number,
  opts: MasterOptions | ((phase: string, pct: number) => void) = {},
): MasterRender {
  const { outRate = fs, onProgress } = typeof opts === 'function' ? { onProgress: opts } as MasterOptions : opts;
  const srcN = srcL.length;

  // ── the chain, up to its output gain ─────────────────────────────────
  // Delta monitoring and REF are listening aids only: never rendered.
  // The output stages are left out here: the loudness solve below runs a
  // clipper and limiter of its own, once per pass.
  const chain = new MasterChain(fs, RENDER_BLOCK, { limiter: false, clipper: false });
  chain.setParams({
    ...params,
    stagingGainDb: stagingGainDbFor(sourceLufs),
    outputGainDb: 0,
    limiterDelta: false,
    bypass: false,
    monitor: 'stereo',
    monitorGainDb: 0,
  });
  chain.snapParams();
  // Padded by the chain's latency so its tail flushes out; the output is
  // read from `lat` on. The trim and fades run on source positions.
  const lat = chain.latency;
  const L = new Float32Array(srcN + lat);
  const R = new Float32Array(srcN + lat);
  L.set(srcL);
  R.set(srcR);
  for (let s = 0; s < srcN + lat; s += RENDER_BLOCK) {
    chain.processBlock(L, R, s, Math.min(RENDER_BLOCK, srcN + lat - s), s);
    if (onProgress && s % (RENDER_BLOCK * 64) === 0) onProgress('PROCESSING CHAIN', (s / (srcN + lat)) * 0.5);
  }
  let coreL: Float32Array = L.subarray(lat, lat + srcN);
  let coreR: Float32Array = R.subarray(lat, lat + srcN);

  if (outRate !== fs) {
    onProgress?.(`CONVERTING TO ${(outRate / 1000).toFixed(1)} KHZ`, 0.52);
    coreL = resample(coreL, fs, outRate);
    coreR = resample(coreR, fs, outRate);
  }
  const n = coreL.length;
  const [keepStartSec, keepEndSec] = keptRange({ ...params, songLengthSec: srcN / fs });
  const keepStart = Math.min(n, Math.round(keepStartSec * outRate));
  const keepEnd = Math.max(keepStart, Math.min(n, Math.round(keepEndSec * outRate)));

  onProgress?.('MEASURING LOUDNESS', 0.58);
  const coreLufs = measureIntegratedLufs(coreL, coreR, outRate);
  const measured = coreLufs > -70;

  // ── the loudness solve through the output stages ─────────────────────
  const clipOn = (params.clipMode ?? 'off') !== 'off';
  const limLat = new Limiter(outRate).latency;
  const outLat = limLat + (clipOn ? Clipper.latency : 0);
  const outL = new Float32Array(n + outLat);
  const outR = new Float32Array(n + outLat);
  // Without the clipper, passes differ only in gain and share one
  // true-peak envelope. With it, each pass limits a different signal.
  const peaks = clipOn ? null : new TruePeakEnvelope(coreL, coreR, n + outLat);
  const masterL = outL.subarray(outLat, outLat + n);
  const masterR = outR.subarray(outLat, outLat + n);
  let limiterMaxGrDb = 0;
  let clipMaxGrDb = 0;
  let passes = 0;
  interface Try { g: number; lufs: number; gr: number; clip: number }
  const tries: Try[] = [];
  const pass = (gainDb: number): Try => {
    // Counted here, not inside the progress call: a render with nobody
    // listening must stop after as many passes as any other.
    passes++;
    onProgress?.(`LIMITING (PASS ${passes})`, Math.min(0.88, 0.62 + passes * 0.04));
    const g = dbToLin(gainDb);
    const limiter = new Limiter(outRate);
    limiter.setCeiling(params.ceilingDb);
    limiterMaxGrDb = 0;
    clipMaxGrDb = 0;
    for (let i = 0; i < n; i++) { outL[i] = coreL[i] * g; outR[i] = coreR[i] * g; }
    outL.fill(0, n);
    outR.fill(0, n);
    let clipper: Clipper | null = null;
    if (clipOn) {
      clipper = new Clipper();
      clipper.setCeiling(params.ceilingDb);
      clipper.setMode(params.clipMode);
    }
    for (let s = 0; s < n + outLat; s += RENDER_BLOCK) {
      const len = Math.min(RENDER_BLOCK, n + outLat - s);
      if (clipper) {
        clipper.processBlock(outL, outR, s, len);
        if (clipper.grDb > clipMaxGrDb) clipMaxGrDb = clipper.grDb;
        limiter.processBlock(outL, outR, s, len);
      } else {
        limiter.processBlock(outL, outR, s, len, peaks!, g);
      }
      if (limiter.grDb > limiterMaxGrDb) limiterMaxGrDb = limiter.grDb;
    }
    const t: Try = { g: gainDb, lufs: measureIntegratedLufs(masterL, masterR, outRate), gr: limiterMaxGrDb, clip: clipMaxGrDb };
    tries.push(t);
    return t;
  };
  const result = (t: Try, reached: boolean): MasterRender => ({
    L: masterL, R: masterR, fs: outRate, keepStart, keepEnd,
    lufs: t.lufs, appliedGainDb: t.g, limiterMaxGrDb: t.gr, clipMaxGrDb: t.clip, measured, reached,
  });

  const target = params.targetLufs;
  // Too quiet to measure: nothing to solve for, so no gain at all (dither
  // must not come out as a -14 LUFS hiss).
  if (!measured) return result(pass(0), true);

  // Secant steps on gain → loudness. Once the limiter works, a dB of gain
  // buys less than a LU, so each step learns the slope from the last two.
  let g0 = target - coreLufs;
  let l0 = pass(g0).lufs;
  let plateau = false;
  if (Math.abs(target - l0) > SOLVE_TOL_LU) {
    let g1 = g0 + Math.max(-SOLVE_MAX_STEP_DB, Math.min(SOLVE_MAX_STEP_DB, target - l0));
    let l1 = pass(g1).lufs;
    while (passes < SOLVE_MAX_PASSES && Math.abs(target - l1) > SOLVE_TOL_LU) {
      const raw = Math.abs(g1 - g0) > 1e-6 ? (l1 - l0) / (g1 - g0) : 1;
      // Still short of the target, and the last push bought almost nothing.
      if (l1 < target && g1 > g0 && raw < PLATEAU_SLOPE) { plateau = true; break; }
      const slope = Math.max(0.1, Math.min(1, raw));
      const step = Math.max(-SOLVE_MAX_STEP_DB, Math.min(SOLVE_MAX_STEP_DB, (target - l1) / slope));
      g0 = g1; l0 = l1;
      g1 += step;
      l1 = pass(g1).lufs;
    }
  }

  let best = tries[0];
  for (const t of tries) if (Math.abs(target - t.lufs) < Math.abs(target - best.lufs)) best = t;
  const reached = Math.abs(target - best.lufs) <= TARGET_REACHED_LU;
  if (!reached && (plateau || best.lufs < target)) {
    // Out of reach: of the passes within a hair of the loudest, the one
    // that pushed least. The rest of the gain was only limiter work.
    const loudest = Math.max(...tries.map((t) => t.lufs));
    const near = tries.filter((t) => t.lufs >= loudest - PLATEAU_KEEP_LU);
    best = near.reduce((a, t) => (t.g < a.g ? t : a), near[0]);
  }
  // The buffers must hold the pass that's reported.
  if (tries[tries.length - 1] !== best) best = pass(best.g);
  return result(best, reached);
}

/** The part of a master a trim keeps (the whole of it without one), as copies. */
export function keptAudio(m: MasterRender): { L: Float32Array; R: Float32Array } {
  return { L: m.L.slice(m.keepStart, m.keepEnd), R: m.R.slice(m.keepStart, m.keepEnd) };
}
