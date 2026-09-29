// Offline worker: source analysis (LUFS / peaks / waveform buckets) and the
// export render. The render (render/master.ts) runs the same MasterChain as
// the preview, then solves the loudness target: measure → gain → limit.
import { MasterChain } from '../dsp/chain';
import { Biquad } from '../dsp/biquad';
import {
  measureIntegratedLufs,
  measureTruePeakDb,
  measureSamplePeakDb,
  computeLoudnessHops,
  gatedLoudnessFromHops,
  shortTermSeriesFromHops,
  loudnessRangeFromHops,
} from '../dsp/loudness';
import { ChainParams, stagingGainDbFor } from '../dsp/params';
import { encodeAudio, EncodeOptions, QuantCache } from '../encode';
import { renderMaster } from './master';
import { fft } from '../dsp/fft';
import { analyzeTempo, type TempoCurve } from '../analysis/tempo';
import { repairDrift } from '../analysis/repair';

const BLOCK = 4096;

interface AnalyzeMsg {
  type: 'analyze';
  l: ArrayBuffer;
  r: ArrayBuffer;
  fs: number;
  /** Legacy single-level bucket count (still honoured for small requests). */
  buckets: number;
  /** Optional request id, echoed back (used by the batch worker channel). */
  reqId?: number;
}

// Peak pyramid: base level at BASE_SPB samples per bucket, then ×8 mips.
const BASE_SPB = 128;
const MIP_FACTOR = 8;

interface RenderMsg {
  type: 'render';
  l: ArrayBuffer;
  r: ArrayBuffer;
  fs: number;
  params: ChainParams;
  sourceLufs: number;
  encode: EncodeOptions;
  /** Companion formats, encoded from the same rendered buffers. */
  extras?: EncodeOptions[];
  reqId?: number;
}

interface CalibrateMsg {
  type: 'calibrate';
  seq: number;
  l: ArrayBuffer;
  r: ArrayBuffer;
  fs: number;
  params: ChainParams;
  sourceLufs: number;
}

interface SpectrogramMsg {
  type: 'spectrogram';
  l: ArrayBuffer;
  r: ArrayBuffer;
  fs: number;
}

interface TempoMsg {
  type: 'tempo';
  l: ArrayBuffer;
  r: ArrayBuffer;
  fs: number;
}

/** Source cached in-worker so each preview costs only a params message. */
interface PrimeMsg {
  type: 'prime';
  l: ArrayBuffer;
  r: ArrayBuffer;
  fs: number;
  sourceLufs: number;
}
let primedL: Float32Array | null = null;
let primedR: Float32Array | null = null;
let primedFs = 48000;
let primedLufs = -18;

function prime(msg: PrimeMsg): void {
  primedL = new Float32Array(msg.l);
  primedR = new Float32Array(msg.r);
  primedFs = msg.fs;
  primedLufs = msg.sourceLufs;
}

function unprime(): void {
  primedL = null;
  primedR = null;
}

interface PreviewMsg {
  type: 'preview';
  params: ChainParams;
  reqId?: number;
}

/**
 * Processed-master preview: full chain + loudness solve + limiter, reduced to
 * one peaks level and a short-term loudness series — no encode. Works on the
 * primed source (the chain mutates in place, so it copies locally).
 */
function preview(msg: PreviewMsg): void {
  if (!primedL || !primedR) {
    post({ type: 'previewed', reqId: msg.reqId, unprimed: true });
    return;
  }
  // Exactly the export's master (same stages, same loudness solve), so
  // what OUT shows is what RENDER writes.
  const fs = primedFs;
  const { L, R } = renderMaster(primedL, primedR, fs, msg.params, primedLufs);
  const n = L.length;

  const SPB = 512;
  const buckets = Math.max(1, Math.ceil(n / SPB));
  const mins = new Float32Array(buckets);
  const maxs = new Float32Array(buckets);
  const rms = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    const s = b * SPB;
    const e = Math.min(n, s + SPB);
    let mn = 0, mx = 0, acc = 0;
    for (let i = s; i < e; i++) {
      const v = 0.5 * (L[i] + R[i]);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      acc += v * v;
    }
    mins[b] = mn; maxs[b] = mx; rms[b] = Math.sqrt(acc / Math.max(1, e - s));
  }
  const outHops = computeLoudnessHops(L, R, fs);
  const stSeries = shortTermSeriesFromHops(outHops, 5);

  post(
    {
      type: 'previewed', reqId: msg.reqId,
      spb: SPB, mins: mins.buffer, maxs: maxs.buffer, rms: rms.buffer,
      stSeries: stSeries.buffer, stStepSec: 0.5,
      integrated: gatedLoudnessFromHops(outHops),
    },
    [mins.buffer, maxs.buffer, rms.buffer, stSeries.buffer],
  );
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as AnalyzeMsg | RenderMsg | CalibrateMsg | SpectrogramMsg | TempoMsg | PreviewMsg | ProfileMsg | PrimeMsg | RepairMsg | { type: 'unprime' };
  if (msg.type === 'analyze') analyze(msg);
  else if (msg.type === 'render') {
    void render(msg).catch((err) => {
      post({ type: 'render-error', reqId: msg.reqId, message: String(err) });
    });
  }
  else if (msg.type === 'calibrate') calibrate(msg);
  else if (msg.type === 'spectrogram') spectrogram(msg);
  else if (msg.type === 'tempo') tempo(msg);
  else if (msg.type === 'prime') prime(msg);
  else if (msg.type === 'unprime') unprime();
  else if (msg.type === 'preview') preview(msg);
  else if (msg.type === 'profile') profile(msg);
  else if (msg.type === 'repair') repair(msg);
};

// ── drift repair ──────────────────────────────────────────────────────
// The stretch itself lives in src/audio/analysis/repair.ts.
interface RepairMsg {
  type: 'repair';
  l: ArrayBuffer;
  r: ArrayBuffer;
  fs: number;
  curve: TempoCurve;
  targetBpm: number;
}

function repair(msg: RepairMsg): void {
  // Like the tempo, every request gets exactly one answer.
  try {
    let last = -1;
    const out = repairDrift(new Float32Array(msg.l), new Float32Array(msg.r), msg.fs, msg.curve, msg.targetBpm, (pct) => {
      const q = Math.floor(pct * 100);
      if (q !== last) { last = q; post({ type: 'repair-progress', pct }); }
    });
    post({ type: 'repaired', l: out.L.buffer, r: out.R.buffer }, [out.L.buffer, out.R.buffer]);
  } catch (err) {
    post({ type: 'repaired', failed: true, message: String(err) });
  }
}

// ── spectral profile (for reference matching + MASTER IT) ─────────────
const PROFILE_BANDS = 30;

interface ProfileMsg {
  type: 'profile';
  l: ArrayBuffer;
  r: ArrayBuffer;
  fs: number;
  reqId?: number;
}

function profile(msg: ProfileMsg): void {
  const L = new Float32Array(msg.l);
  const R = new Float32Array(msg.r);
  const fs = msg.fs;
  const n = L.length;
  const FFT = 2048;
  const HOP = 4096; // sparse hop — an average spectrum doesn't need overlap
  const cols = Math.max(1, Math.floor((n - FFT) / HOP) + 1);

  const win = new Float64Array(FFT);
  for (let i = 0; i < FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1));
  const re = new Float64Array(FFT);
  const im = new Float64Array(FFT);
  const binHz = fs / FFT;
  const lo = new Int32Array(PROFILE_BANDS);
  const hi = new Int32Array(PROFILE_BANDS);
  for (let b = 0; b < PROFILE_BANDS; b++) {
    const f0 = 20 * Math.pow(1000, b / PROFILE_BANDS);
    const f1 = 20 * Math.pow(1000, (b + 1) / PROFILE_BANDS);
    lo[b] = Math.max(1, Math.floor(f0 / binHz));
    hi[b] = Math.min(FFT / 2, Math.max(lo[b] + 1, Math.ceil(f1 / binHz)));
  }
  const acc = new Float64Array(PROFILE_BANDS);

  let sideE = 0, midE = 0;
  for (let i = 0; i < n; i++) {
    const m = 0.5 * (L[i] + R[i]);
    const s = 0.5 * (L[i] - R[i]);
    midE += m * m;
    sideE += s * s;
  }

  for (let c = 0; c < cols; c++) {
    const s = c * HOP;
    for (let i = 0; i < FFT; i++) {
      re[i] = 0.5 * (L[s + i] + R[s + i]) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < PROFILE_BANDS; b++) {
      let e = 0;
      for (let k = lo[b]; k < hi[b]; k++) e += re[k] * re[k] + im[k] * im[k];
      acc[b] += e / (hi[b] - lo[b]); // per-bin density → comparable bands
    }
  }
  const bands = new Float32Array(PROFILE_BANDS);
  for (let b = 0; b < PROFILE_BANDS; b++) {
    bands[b] = 10 * Math.log10(acc[b] / cols + 1e-14);
  }
  const lufs = measureIntegratedLufs(L, R, fs);
  const sideRatioDb = midE > 0 ? 10 * Math.log10((sideE + 1e-12) / (midE + 1e-12)) : -40;

  post(
    { type: 'profiled', reqId: msg.reqId, bands: bands.buffer, lufs, sideRatioDb },
    [bands.buffer],
  );
}

// ── tempo detection ───────────────────────────────────────────────────
// Global tempo, sections, and the tempo curve with drift live in
// src/audio/analysis/tempo.ts.
function tempo(msg: TempoMsg): void {
  const L = new Float32Array(msg.l);
  const R = new Float32Array(msg.r);
  // Every request gets exactly one answer: the engine pairs answers with
  // requests in order, so a missing one would hand the next track this one.
  try {
    post({ type: 'tempo', ...analyzeTempo(L, R, msg.fs) });
  } catch {
    post({ type: 'tempo', bpm: 0, firstBeatSec: 0, firstBarSec: 0, confidence: 0, sections: [], curve: null, beats: [], downbeat: 0, drift: null });
  }
}

// ── spectrogram ───────────────────────────────────────────────────────
const SPEC_FFT = 2048;
const SPEC_HOP = 1024;
const SPEC_BANDS = 256;
const SPEC_DB_LO = -76;
const SPEC_DB_HI = -6;

function spectrogram(msg: SpectrogramMsg): void {
  const L = new Float32Array(msg.l);
  const R = new Float32Array(msg.r);
  const fs = msg.fs;
  const n = L.length;
  const cols = Math.max(1, Math.floor((n - SPEC_FFT) / SPEC_HOP) + 1);
  const out = new Uint8Array(cols * SPEC_BANDS);

  const win = new Float64Array(SPEC_FFT);
  for (let i = 0; i < SPEC_FFT; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SPEC_FFT - 1));
  }
  // Full-scale sine → |X| ≈ FFT/4 with Hann; normalize magnitudes to dBFS.
  const norm = 1 / (SPEC_FFT / 4);

  // Log-frequency band → FFT-bin ranges (20 Hz .. 20 kHz).
  const binHz = fs / SPEC_FFT;
  const lo = new Int32Array(SPEC_BANDS);
  const hi = new Int32Array(SPEC_BANDS);
  for (let b = 0; b < SPEC_BANDS; b++) {
    const f0 = 20 * Math.pow(1000, b / SPEC_BANDS);
    const f1 = 20 * Math.pow(1000, (b + 1) / SPEC_BANDS);
    lo[b] = Math.max(1, Math.floor(f0 / binHz));
    hi[b] = Math.min(SPEC_FFT / 2, Math.max(lo[b] + 1, Math.ceil(f1 / binHz)));
  }

  const re = new Float64Array(SPEC_FFT);
  const im = new Float64Array(SPEC_FFT);
  const dbSpan = SPEC_DB_HI - SPEC_DB_LO;

  for (let c = 0; c < cols; c++) {
    const s = c * SPEC_HOP;
    for (let i = 0; i < SPEC_FFT; i++) {
      re[i] = 0.5 * (L[s + i] + R[s + i]) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const rowOff = c * SPEC_BANDS;
    for (let b = 0; b < SPEC_BANDS; b++) {
      let peak = 0;
      for (let k = lo[b]; k < hi[b]; k++) {
        const m = re[k] * re[k] + im[k] * im[k];
        if (m > peak) peak = m;
      }
      const db = 10 * Math.log10(peak * norm * norm + 1e-12);
      let v = ((db - SPEC_DB_LO) / dbSpan) * 255;
      if (v < 0) v = 0; else if (v > 255) v = 255;
      out[rowOff + b] = v;
    }
  }

  post({ type: 'spectrogram', cols, bands: SPEC_BANDS, data: out.buffer }, [out.buffer]);
}

/**
 * Preview-gain calibration: runs the chain core over a loud excerpt and
 * reports how much loudness the chain itself adds/removes, so the live
 * preview can sit at the loudness the export will actually hit.
 */
function calibrate(msg: CalibrateMsg): void {
  const L = new Float32Array(msg.l);
  const R = new Float32Array(msg.r);
  const fs = msg.fs;
  const n = L.length;

  const rawLufs = measureIntegratedLufs(L, R, fs);

  const params: ChainParams = { ...msg.params };
  params.stagingGainDb = stagingGainDbFor(msg.sourceLufs);
  params.outputGainDb = 0;
  params.fadeInSec = 0;
  params.fadeOutSec = 0;
  params.ceilingDb = 24; // transparent limiter for the core measurement
  params.limiterDelta = false;
  params.bypass = false; // measures the chain, whatever the monitor is on

  const chain = new MasterChain(fs, BLOCK, { limiter: false });
  chain.setParams(params);
  chain.snapParams();
  for (let s = 0; s < n; s += BLOCK) {
    chain.processBlock(L, R, s, Math.min(BLOCK, n - s), s);
  }
  const processedLufs = measureIntegratedLufs(L, R, fs);
  // How the chain changed the excerpt's loudness beyond the staging gain
  // (nothing to compare when either side is below the gate).
  const chainDeltaDb = rawLufs > -70 && processedLufs > -70
    ? processedLufs - (rawLufs + params.stagingGainDb)
    : 0;
  post({ type: 'calibrated', seq: msg.seq, chainDeltaDb });
}

function post(data: any, transfer?: Transferable[]): void {
  (self as any).postMessage(data, transfer);
}

function analyze(msg: AnalyzeMsg): void {
  const L = new Float32Array(msg.l);
  const R = new Float32Array(msg.r);
  const loudnessHops = computeLoudnessHops(L, R, msg.fs);
  const lufs = gatedLoudnessFromHops(loudnessHops);
  const lra = loudnessRangeFromHops(loudnessHops);
  // Short-term loudness lane: one point per 0.5 s.
  const stSeries = shortTermSeriesFromHops(loudnessHops, 5);
  const truePeakDb = measureTruePeakDb(L, R);
  const samplePeakDb = measureSamplePeakDb(L, R);

  // Channel balance: L/R RMS difference in dB (positive = right louder).
  let sumL = 0, sumR = 0;
  for (let i = 0; i < L.length; i++) {
    sumL += L[i] * L[i];
    sumR += R[i] * R[i];
  }
  const balanceOffsetDb =
    sumL > 0 && sumR > 0 ? 10 * Math.log10(sumR / sumL) : 0;

  // ── source diagnostics (the AI-music pathology checks) ──────────────
  // 1. Bass placement: side-vs-mid energy below 140 Hz.
  const sideLp1 = new Biquad(); sideLp1.setLowpass(msg.fs, 140, 0.707);
  const midLp1 = new Biquad(); midLp1.setLowpass(msg.fs, 140, 0.707);
  // 2. HF texture: >4.5 kHz share of the mono programme.
  const harshHp = new Biquad(); harshHp.setHighpass(msg.fs, 4500, 0.707);
  let sideBassSum = 0, midBassSum = 0, hfSum = 0, monoSum = 0;
  // 3. Width stability: correlation per half-second window, energy-gated.
  const corrWin = Math.round(msg.fs / 2);
  let wLr = 0, wLl = 0, wRr = 0, wCnt = 0;
  const corrs: { corr: number; energy: number }[] = [];
  for (let i = 0; i < L.length; i++) {
    const l = L[i], r = R[i];
    const mid = 0.5 * (l + r);
    const side = 0.5 * (l - r);
    const sb = sideLp1.process(side);
    const mb = midLp1.process(mid);
    sideBassSum += sb * sb;
    midBassSum += mb * mb;
    const hf = harshHp.process(mid);
    hfSum += hf * hf;
    monoSum += mid * mid;
    wLr += l * r; wLl += l * l; wRr += r * r;
    if (++wCnt >= corrWin) {
      const energy = (wLl + wRr) / wCnt;
      if (energy > 1e-6) {
        corrs.push({ corr: wLr / Math.sqrt(wLl * wRr + 1e-12), energy });
      }
      wLr = 0; wLl = 0; wRr = 0; wCnt = 0;
    }
  }
  const sideBassRelDb = midBassSum > 0 ? 10 * Math.log10((sideBassSum + 1e-12) / (midBassSum + 1e-12)) : -60;
  const harshRelDb = monoSum > 0 ? 10 * Math.log10((hfSum + 1e-12) / (monoSum + 1e-12)) : -60;
  let corrMean = 0, corrEnergyTotal = 0;
  const corrSorted = corrs.map((c) => c.corr).sort((a, b) => a - b);
  for (const c of corrs) { corrMean += c.corr * c.energy; corrEnergyTotal += c.energy; }
  corrMean = corrEnergyTotal > 0 ? corrMean / corrEnergyTotal : 1;
  const corrWorst = corrSorted.length > 0 ? corrSorted[Math.floor(corrSorted.length * 0.05)] : 1;
  const diagnostics = { sideBassRelDb, harshRelDb, corrMean, corrWorst };

  // Peak pyramid. Base level: min/max/rms of the mono sum per BASE_SPB
  // samples; each mip aggregates MIP_FACTOR buckets of the previous level.
  const n = L.length;
  const baseBuckets = Math.max(1, Math.ceil(n / BASE_SPB));
  const levels: { spb: number; mins: Float32Array; maxs: Float32Array; rms: Float32Array }[] = [];

  {
    const mins = new Float32Array(baseBuckets);
    const maxs = new Float32Array(baseBuckets);
    const rms = new Float32Array(baseBuckets);
    for (let b = 0; b < baseBuckets; b++) {
      const s = b * BASE_SPB;
      const e = Math.min(n, s + BASE_SPB);
      let mn = 0, mx = 0, acc = 0;
      for (let i = s; i < e; i++) {
        const v = 0.5 * (L[i] + R[i]);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        acc += v * v;
      }
      mins[b] = mn;
      maxs[b] = mx;
      rms[b] = Math.sqrt(acc / Math.max(1, e - s));
    }
    levels.push({ spb: BASE_SPB, mins, maxs, rms });
  }

  while (levels[levels.length - 1].mins.length > 2048) {
    const prev = levels[levels.length - 1];
    const count = Math.ceil(prev.mins.length / MIP_FACTOR);
    const mins = new Float32Array(count);
    const maxs = new Float32Array(count);
    const rms = new Float32Array(count);
    for (let b = 0; b < count; b++) {
      const s = b * MIP_FACTOR;
      const e = Math.min(prev.mins.length, s + MIP_FACTOR);
      let mn = 0, mx = 0, acc = 0;
      for (let i = s; i < e; i++) {
        if (prev.mins[i] < mn) mn = prev.mins[i];
        if (prev.maxs[i] > mx) mx = prev.maxs[i];
        acc += prev.rms[i] * prev.rms[i];
      }
      mins[b] = mn;
      maxs[b] = mx;
      rms[b] = Math.sqrt(acc / Math.max(1, e - s));
    }
    levels.push({ spb: prev.spb * MIP_FACTOR, mins, maxs, rms });
  }

  const transfer: Transferable[] = [];
  const levelsOut = levels.map((lv) => {
    transfer.push(lv.mins.buffer, lv.maxs.buffer, lv.rms.buffer);
    return { spb: lv.spb, mins: lv.mins.buffer, maxs: lv.maxs.buffer, rms: lv.rms.buffer };
  });
  transfer.push(stSeries.buffer);

  post(
    {
      type: 'analyzed', reqId: msg.reqId, lufs, lra, truePeakDb, samplePeakDb, balanceOffsetDb,
      diagnostics, levels: levelsOut, stSeries: stSeries.buffer, stStepSec: 0.5,
    },
    transfer,
  );
}

async function render(msg: RenderMsg): Promise<void> {
  const fs = msg.fs;
  const n = msg.l.byteLength / 4;
  const master = renderMaster(
    new Float32Array(msg.l), new Float32Array(msg.r), fs, msg.params, msg.sourceLufs,
    (phase, pct) => post({ type: 'progress', reqId: msg.reqId, phase, pct }),
  );
  const outL = master.L;
  const outR = master.R;
  const finalLufs = master.lufs;
  const gainDb = master.appliedGainDb;
  const limiterMaxGr = master.limiterMaxGrDb;

  post({ type: 'progress', reqId: msg.reqId, phase: `ENCODING ${msg.encode.format.toUpperCase()}`, pct: 0.9 });
  const truePeakDb = measureTruePeakDb(outL, outR);
  const samplePeakDb = measureSamplePeakDb(outL, outR);
  const quant: QuantCache = new Map();
  const encoded = await encodeAudio(outL, outR, fs, msg.encode, quant);

  // Companions: one loudness solve, several deliverables. Each encoder
  // reads the rendered buffers without modifying them, and the shared
  // quantization keeps a WAV and FLAC of one render bit-identical.
  const extras: { data: ArrayBuffer; ext: string; mime: string; format: string; bytes: number }[] = [];
  const wanted = msg.extras ?? [];
  for (let i = 0; i < wanted.length; i++) {
    post({
      type: 'progress', reqId: msg.reqId,
      phase: `ENCODING ${wanted[i].format.toUpperCase()}`,
      pct: 0.9 + (0.08 * (i + 1)) / (wanted.length + 1),
    });
    const x = await encodeAudio(outL, outR, fs, wanted[i], quant);
    extras.push({ data: x.data, ext: x.ext, mime: x.mime, format: wanted[i].format, bytes: x.data.byteLength });
  }

  post(
    {
      type: 'done',
      reqId: msg.reqId,
      wav: encoded.data,
      ext: encoded.ext,
      mime: encoded.mime,
      stats: {
        integratedLufs: finalLufs,
        truePeakDb,
        samplePeakDb,
        appliedGainDb: gainDb,
        limiterMaxGrDb: limiterMaxGr,
        loudnessMeasured: master.measured,
        durationSec: n / fs,
        sampleRate: fs,
        bitDepth: msg.encode.format === 'mp3' || msg.encode.format === 'opus' ? 16 : msg.encode.bitDepth,
        format: msg.encode.format,
        mp3Kbps: msg.encode.mp3Kbps,
        opusKbps: msg.encode.opusKbps,
        bytes: encoded.data.byteLength,
      },
      extras,
    },
    [encoded.data, ...extras.map((x) => x.data)],
  );
}
