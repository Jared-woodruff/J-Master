// The offline master, shared by the export and the OUT preview so the
// preview is the export: the chain at nominal staging, then the loudness
// solve through the final true-peak limiter. Both stages are latency
// compensated, so the master lines up with the source sample for sample
// and keeps its last milliseconds.
import { MasterChain } from '../dsp/chain';
import { Limiter, TruePeakEnvelope } from '../dsp/limiter';
import { measureIntegratedLufs } from '../dsp/loudness';
import { ChainParams, dbToLin, stagingGainDbFor } from '../dsp/params';

export const RENDER_BLOCK = 4096;
/** The loudness solve stops within this of the target… */
const SOLVE_TOL_LU = 0.05;
/** …or after this many limiter passes, keeping the closest. */
const SOLVE_MAX_PASSES = 8;
/** One solve step never adds more than this. */
const SOLVE_MAX_STEP_DB = 6;

export interface MasterRender {
  /** The master, exactly as long as the source. */
  L: Float32Array;
  R: Float32Array;
  /** Integrated loudness of the master; −70 when nothing clears the gate. */
  lufs: number;
  /** Gain into the final limiter, as rendered. */
  appliedGainDb: number;
  limiterMaxGrDb: number;
  /** False when the source was too quiet (or short) to measure: unity gain. */
  measured: boolean;
}

export function renderMaster(
  srcL: Float32Array,
  srcR: Float32Array,
  fs: number,
  params: ChainParams,
  sourceLufs: number,
  onProgress?: (phase: string, pct: number) => void,
): MasterRender {
  const n = srcL.length;

  // ── the chain, with a transparent output stage ────────────────────────
  // Delta monitoring and REF are listening aids only: never rendered.
  // No output limiter in the chain: its stage would be transparent here,
  // and the loudness solve below limits once, properly.
  const chain = new MasterChain(fs, RENDER_BLOCK, { limiter: false });
  chain.setParams({
    ...params,
    stagingGainDb: stagingGainDbFor(sourceLufs),
    outputGainDb: 0,
    limiterDelta: false,
    bypass: false,
    ceilingDb: 24,
  });
  chain.snapParams();
  // Padded by the chain's latency so its tail flushes out; the output is
  // read from `lat` on. Fades run on source positions, so they stay put.
  const lat = chain.latency;
  const L = new Float32Array(n + lat);
  const R = new Float32Array(n + lat);
  L.set(srcL);
  R.set(srcR);
  for (let s = 0; s < n + lat; s += RENDER_BLOCK) {
    chain.processBlock(L, R, s, Math.min(RENDER_BLOCK, n + lat - s), s);
    if (onProgress && s % (RENDER_BLOCK * 64) === 0) onProgress('PROCESSING CHAIN', (s / (n + lat)) * 0.55);
  }
  const coreL = L.subarray(lat, lat + n);
  const coreR = R.subarray(lat, lat + n);

  onProgress?.('MEASURING LOUDNESS', 0.58);
  const coreLufs = measureIntegratedLufs(coreL, coreR, fs);
  const measured = coreLufs > -70;

  // ── the loudness solve through the final limiter ─────────────────────
  const limLat = new Limiter(fs).latency;
  const outL = new Float32Array(n + limLat);
  const outR = new Float32Array(n + limLat);
  // Passes differ only in gain, so they share one true-peak envelope.
  const peaks = new TruePeakEnvelope(coreL, coreR, n + limLat);
  const masterL = outL.subarray(limLat, limLat + n);
  const masterR = outR.subarray(limLat, limLat + n);
  let limiterMaxGrDb = 0;
  let passes = 0;
  const pass = (gainDb: number): number => {
    onProgress?.(`LIMITING (PASS ${++passes})`, Math.min(0.88, 0.62 + passes * 0.04));
    const g = dbToLin(gainDb);
    const limiter = new Limiter(fs);
    limiter.setCeiling(params.ceilingDb);
    limiterMaxGrDb = 0;
    for (let i = 0; i < n; i++) { outL[i] = coreL[i] * g; outR[i] = coreR[i] * g; }
    outL.fill(0, n);
    outR.fill(0, n);
    for (let s = 0; s < n + limLat; s += RENDER_BLOCK) {
      limiter.processBlock(outL, outR, s, Math.min(RENDER_BLOCK, n + limLat - s), peaks, g);
      if (limiter.grDb > limiterMaxGrDb) limiterMaxGrDb = limiter.grDb;
    }
    return measureIntegratedLufs(masterL, masterR, fs);
  };

  const target = params.targetLufs;
  // Too quiet to measure: nothing to solve for, so no gain at all (dither
  // must not come out as a -14 LUFS hiss).
  if (!measured) {
    const lufs = pass(0);
    return { L: masterL, R: masterR, lufs, appliedGainDb: 0, limiterMaxGrDb, measured };
  }

  // Secant steps on gain → loudness. Once the limiter works, a dB of gain
  // buys less than a LU, so each step learns the slope from the last two.
  let g0 = target - coreLufs;
  let l0 = pass(g0);
  let best = { g: g0, lufs: l0, gr: limiterMaxGrDb };
  let lastG = g0;
  if (Math.abs(target - l0) > SOLVE_TOL_LU) {
    let g1 = g0 + Math.max(-SOLVE_MAX_STEP_DB, Math.min(SOLVE_MAX_STEP_DB, target - l0));
    let l1 = pass(g1);
    lastG = g1;
    if (Math.abs(target - l1) < Math.abs(target - best.lufs)) best = { g: g1, lufs: l1, gr: limiterMaxGrDb };
    while (passes < SOLVE_MAX_PASSES && Math.abs(target - l1) > SOLVE_TOL_LU) {
      const slope = Math.abs(g1 - g0) > 1e-6 ? Math.max(0.1, Math.min(1, (l1 - l0) / (g1 - g0))) : 1;
      const step = Math.max(-SOLVE_MAX_STEP_DB, Math.min(SOLVE_MAX_STEP_DB, (target - l1) / slope));
      g0 = g1; l0 = l1;
      g1 += step;
      l1 = pass(g1);
      lastG = g1;
      if (Math.abs(target - l1) < Math.abs(target - best.lufs)) best = { g: g1, lufs: l1, gr: limiterMaxGrDb };
    }
    // The buffers must hold the pass that's reported.
    if (lastG !== best.g) pass(best.g);
    limiterMaxGrDb = best.gr;
  }
  return { L: masterL, R: masterR, lufs: best.lufs, appliedGainDb: best.g, limiterMaxGrDb, measured };
}
