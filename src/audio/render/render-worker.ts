// Offline worker: source analysis (LUFS / peaks / waveform buckets) and the
// export render. The render runs the same MasterChain as the preview, then
// solves the loudness target exactly: measure → gain → limit → verify.
import { MasterChain } from '../dsp/chain';
import { Biquad } from '../dsp/biquad';
import { Limiter } from '../dsp/limiter';
import {
  measureIntegratedLufs,
  measureTruePeakDb,
  measureSamplePeakDb,
  computeLoudnessHops,
  gatedLoudnessFromHops,
  shortTermSeriesFromHops,
  loudnessRangeFromHops,
} from '../dsp/loudness';
import { ChainParams, NOMINAL_LUFS, dbToLin } from '../dsp/params';
import { encodeAudio, EncodeOptions } from '../encode';

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

interface PreviewMsg {
  type: 'preview';
  l: ArrayBuffer;
  r: ArrayBuffer;
  fs: number;
  params: ChainParams;
  sourceLufs: number;
  reqId?: number;
}

/**
 * Processed-master preview: full chain + loudness solve + limiter, reduced to
 * one peaks level and a short-term loudness series — no encode.
 */
function preview(msg: PreviewMsg): void {
  const L = new Float32Array(msg.l);
  const R = new Float32Array(msg.r);
  const fs = msg.fs;
  const n = L.length;
  const params: ChainParams = { ...msg.params };
  params.stagingGainDb = NOMINAL_LUFS - msg.sourceLufs;
  params.outputGainDb = 0;
  params.limiterDelta = false;
  const coreParams: ChainParams = { ...params, ceilingDb: 24 };

  const chain = new MasterChain(fs, BLOCK);
  chain.setParams(coreParams);
  chain.snapParams();
  for (let s = 0; s < n; s += BLOCK) {
    chain.processBlock(L, R, s, Math.min(BLOCK, n - s), s);
  }
  const coreHops = computeLoudnessHops(L, R, fs);
  const coreLufs = gatedLoudnessFromHops(coreHops);
  // Same iterative loudness solve as the export (limiting pushes back).
  const coreL = new Float32Array(L);
  const coreR = new Float32Array(R);
  let gainDb = msg.params.targetLufs - coreLufs;
  for (let iter = 0; iter < 3; iter++) {
    const limiter = new Limiter(fs);
    limiter.setCeiling(msg.params.ceilingDb);
    const g = dbToLin(gainDb);
    for (let s = 0; s < n; s += BLOCK) {
      const len = Math.min(BLOCK, n - s);
      for (let i = s; i < s + len; i++) {
        L[i] = coreL[i] * g;
        R[i] = coreR[i] * g;
      }
      limiter.processBlock(L, R, s, len);
    }
    const err = msg.params.targetLufs - gatedLoudnessFromHops(computeLoudnessHops(L, R, fs));
    if (Math.abs(err) < 0.25) break;
    gainDb += err * 0.95;
  }

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
  const msg = e.data as AnalyzeMsg | RenderMsg | CalibrateMsg | SpectrogramMsg | TempoMsg | PreviewMsg | ProfileMsg;
  if (msg.type === 'analyze') analyze(msg);
  else if (msg.type === 'render') {
    void render(msg).catch((err) => {
      post({ type: 'render-error', reqId: msg.reqId, message: String(err) });
    });
  }
  else if (msg.type === 'calibrate') calibrate(msg);
  else if (msg.type === 'spectrogram') spectrogram(msg);
  else if (msg.type === 'tempo') tempo(msg);
  else if (msg.type === 'preview') preview(msg);
  else if (msg.type === 'profile') profile(msg);
};

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
// Spectral-flux onset envelope → autocorrelation with octave weighting →
// parabolic-refined BPM → beat phase by comb alignment.
const TEMPO_FFT = 1024;
const TEMPO_HOP = 512;

function tempo(msg: TempoMsg): void {
  const L = new Float32Array(msg.l);
  const R = new Float32Array(msg.r);
  const fs = msg.fs;
  const n = L.length;
  const hopSec = TEMPO_HOP / fs;
  const cols = Math.max(2, Math.floor((n - TEMPO_FFT) / TEMPO_HOP) + 1);

  // Onset envelope: half-wave-rectified log-magnitude spectral flux.
  const win = new Float64Array(TEMPO_FFT);
  for (let i = 0; i < TEMPO_FFT; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (TEMPO_FFT - 1));
  }
  const re = new Float64Array(TEMPO_FFT);
  const im = new Float64Array(TEMPO_FFT);
  const prevMag = new Float64Array(TEMPO_FFT / 2);
  const env = new Float64Array(cols);
  const lowEnv = new Float64Array(cols);      // < ~220 Hz flux: kick/bass onsets
  const lowBins = Math.max(2, Math.round(220 / (fs / TEMPO_FFT)));

  // Per-column 8-band log energies for section detection.
  const N_BANDS = 8;
  const bandEdges = new Int32Array(N_BANDS + 1);
  for (let b = 0; b <= N_BANDS; b++) {
    const f = 60 * Math.pow(12000 / 60, b / N_BANDS);
    bandEdges[b] = Math.max(1, Math.min(TEMPO_FFT / 2, Math.round(f / (fs / TEMPO_FFT))));
  }
  const bandFeat = new Float64Array(cols * N_BANDS);

  for (let c = 0; c < cols; c++) {
    const s = c * TEMPO_HOP;
    for (let i = 0; i < TEMPO_FFT; i++) {
      re[i] = 0.5 * (L[s + i] + R[s + i]) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    let lowFlux = 0;
    for (let k = 1; k < TEMPO_FFT / 2; k++) {
      const mag = Math.log1p(20 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      const d = mag - prevMag[k];
      if (d > 0) {
        flux += d;
        if (k <= lowBins) lowFlux += d;
      }
      prevMag[k] = mag;
    }
    env[c] = flux;
    lowEnv[c] = lowFlux;
    for (let b = 0; b < N_BANDS; b++) {
      let e = 0;
      for (let k = bandEdges[b]; k < bandEdges[b + 1]; k++) {
        e += re[k] * re[k] + im[k] * im[k];
      }
      bandFeat[c * N_BANDS + b] = Math.log10(e + 1e-10);
    }
  }
  // Remove the slow-moving mean so the autocorrelation sees pulses only.
  const meanWin = Math.round(1.0 / hopSec);
  const detrended = new Float64Array(cols);
  let acc = 0;
  for (let c = 0; c < cols; c++) {
    acc += env[c];
    if (c >= meanWin) acc -= env[c - meanWin];
    const mean = acc / Math.min(c + 1, meanWin);
    detrended[c] = Math.max(0, env[c] - mean);
  }

  // Autocorrelation over 60–200 BPM lags, weighted toward ~120 BPM.
  const minLag = Math.max(2, Math.floor(60 / 200 / hopSec));
  const maxLag = Math.min(cols - 2, Math.ceil(60 / 60 / hopSec));
  let bestLag = 0;
  let bestScore = -1;
  const acAt = (lag: number): number => {
    let s = 0;
    for (let c = lag; c < cols; c++) s += detrended[c] * detrended[c - lag];
    return s / (cols - lag);
  };
  const acCache = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) acCache[lag] = acAt(lag);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hopSec);
    // Log-gaussian preference centred near 120 BPM.
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const harmonic = lag * 2 <= maxLag ? 0.4 * acCache[lag * 2] : 0;
    const score = (acCache[lag] + harmonic) * w;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (bestLag === 0) {
    post({ type: 'tempo', bpm: 0, firstBeatSec: 0, confidence: 0 });
    return;
  }

  // Parabolic refinement around the winning lag.
  let refined = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = acCache[bestLag - 1], y1 = acCache[bestLag], y2 = acCache[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) refined = bestLag + (0.5 * (y0 - y2)) / denom;
  }
  const bpm = 60 / (refined * hopSec);

  // Beat phase: comb offset with the greatest onset energy. Low-frequency
  // onsets (kick/bass) carry the downbeat, so when the track has meaningful
  // low-band activity the phase locks to that; hats on off-beats can no
  // longer pull the grid half a beat late.
  const period = refined;
  // Low bins are few, so even a strong kick is a small share of total flux —
  // any meaningful low-band activity should own the phase decision.
  let lowTotal = 0, fullTotal = 0;
  for (let c = 0; c < cols; c++) { lowTotal += lowEnv[c]; fullTotal += env[c]; }
  const phaseBase = lowTotal > fullTotal * 0.004 ? lowEnv : detrended;
  // Squaring makes sharp attacks (kicks) out-vote slow energy swells.
  const phaseEnv = new Float64Array(cols);
  for (let c = 0; c < cols; c++) phaseEnv[c] = phaseBase[c] * phaseBase[c];
  let bestOff = 0;
  let bestSum = -1;
  const steps = Math.min(64, Math.floor(period * 4));
  for (let oi = 0; oi < steps; oi++) {
    const off = (oi / steps) * period;
    let s = 0;
    for (let c = off; c < cols; c += period) s += phaseEnv[Math.round(c)] ?? 0;
    if (s > bestSum) { bestSum = s; bestOff = off; }
  }
  // Flux lands in the first window containing an onset, whose start time is
  // about half a window early — compensate so beats sit on the true onsets.
  let firstBeatSec = bestOff * hopSec + TEMPO_FFT / 2 / fs;
  const periodSec = refined * hopSec;
  while (firstBeatSec >= periodSec) firstBeatSec -= periodSec;

  // Confidence: winning peak vs the autocorrelation average.
  let acMean = 0;
  let acCount = 0;
  for (let lag = minLag; lag <= maxLag; lag++) { acMean += acCache[lag]; acCount++; }
  acMean /= Math.max(1, acCount);
  const confidence = Math.max(0, Math.min(1, acMean > 0 ? (acCache[bestLag] / acMean - 1) / 4 : 0));

  // ── section detection ─────────────────────────────────────────────
  // Checkerboard novelty on smoothed band features: how different the next
  // ~2 s sounds from the previous ~2 s, evaluated every quarter second.
  const beatSecF = 60 / bpm;
  const W = Math.round(2.0 / hopSec);
  const stride = Math.max(1, Math.round(0.25 / hopSec));
  const novelty: { sec: number; v: number }[] = [];
  for (let c = W; c < cols - W; c += stride) {
    let dist = 0;
    for (let b = 0; b < N_BANDS; b++) {
      let before = 0, after = 0;
      for (let k = 1; k <= W; k++) {
        before += bandFeat[(c - k) * N_BANDS + b];
        after += bandFeat[(c + k - 1) * N_BANDS + b];
      }
      const d = (after - before) / W;
      dist += d * d;
    }
    novelty.push({ sec: c * hopSec, v: Math.sqrt(dist) });
  }
  let nvMean = 0;
  for (const p of novelty) nvMean += p.v;
  nvMean /= Math.max(1, novelty.length);
  let nvVar = 0;
  for (const p of novelty) nvVar += (p.v - nvMean) * (p.v - nvMean);
  const nvStd = Math.sqrt(nvVar / Math.max(1, novelty.length));
  const threshold = nvMean + nvStd * 1.2;
  const minGapSec = 8;
  const rawBounds: number[] = [];
  for (let i = 1; i < novelty.length - 1; i++) {
    const p = novelty[i];
    if (p.v > threshold && p.v >= novelty[i - 1].v && p.v >= novelty[i + 1].v) {
      if (rawBounds.length === 0 || p.sec - rawBounds[rawBounds.length - 1] >= minGapSec) {
        rawBounds.push(p.sec);
      } else if (p.v > (novelty.find((q) => q.sec === rawBounds[rawBounds.length - 1])?.v ?? 0)) {
        rawBounds[rawBounds.length - 1] = p.sec;
      }
    }
  }

  // ── bar anchoring ─────────────────────────────────────────────────
  // Sections start on downbeats; choose the beat offset (0–3) that puts bar
  // lines closest to the detected boundaries.
  const barSec = beatSecF * 4;
  let firstBarSec = firstBeatSec;
  if (rawBounds.length > 0) {
    let bestK = 0;
    let bestDist = Infinity;
    for (let k = 0; k < 4; k++) {
      const barPhase = firstBeatSec + k * beatSecF;
      let sum = 0;
      for (const b of rawBounds) {
        const m = ((b - barPhase) % barSec + barSec) % barSec;
        sum += Math.min(m, barSec - m);
      }
      if (sum < bestDist) { bestDist = sum; bestK = k; }
    }
    firstBarSec = firstBeatSec + bestK * beatSecF;
    while (firstBarSec >= barSec) firstBarSec -= barSec;
  }
  // Snap boundaries onto the bar grid when they're within a bar.
  const snapped = rawBounds.map((b) => {
    const m = ((b - firstBarSec) % barSec + barSec) % barSec;
    const down = b - m;
    const up = down + barSec;
    const target = m < barSec / 2 ? down : up;
    return Math.abs(target - b) <= barSec ? Math.max(0, target) : b;
  });

  // Sections with energy-class labels (mean band energy terciles).
  const durSec = n / fs;
  const boundsAll = [0, ...snapped.filter((b) => b > 1 && b < durSec - 2), durSec];
  const sections: { startSec: number; endSec: number; label: string }[] = [];
  const means: number[] = [];
  for (let i = 0; i < boundsAll.length - 1; i++) {
    const c0 = Math.floor(boundsAll[i] / hopSec);
    const c1 = Math.min(cols, Math.floor(boundsAll[i + 1] / hopSec));
    let m = 0, cnt = 0;
    for (let c = c0; c < c1; c++) {
      for (let b = 0; b < N_BANDS; b++) m += bandFeat[c * N_BANDS + b];
      cnt++;
    }
    means.push(cnt > 0 ? m / cnt : -10);
  }
  const sorted = [...means].sort((a, b) => a - b);
  const t1 = sorted[Math.floor(sorted.length / 3)];
  const t2 = sorted[Math.floor((sorted.length * 2) / 3)];
  for (let i = 0; i < boundsAll.length - 1; i++) {
    let label = means[i] <= t1 ? 'LOW' : means[i] >= t2 ? 'PEAK' : 'MID';
    if (i === 0 && label !== 'PEAK') label = 'INTRO';
    if (i === boundsAll.length - 2 && i > 0 && label !== 'PEAK') label = 'OUTRO';
    sections.push({ startSec: boundsAll[i], endSec: boundsAll[i + 1], label });
  }

  post({ type: 'tempo', bpm, firstBeatSec, firstBarSec, confidence, sections });
}

// ── spectrogram ───────────────────────────────────────────────────────
const SPEC_FFT = 2048;
const SPEC_HOP = 1024;
const SPEC_BANDS = 256;
const SPEC_DB_LO = -76;
const SPEC_DB_HI = -6;

/** In-place iterative radix-2 complex FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1, curI = 0;
      for (let j = 0; j < len / 2; j++) {
        const aR = re[i + j], aI = im[i + j];
        const bR = re[i + j + len / 2] * curR - im[i + j + len / 2] * curI;
        const bI = re[i + j + len / 2] * curI + im[i + j + len / 2] * curR;
        re[i + j] = aR + bR;
        im[i + j] = aI + bI;
        re[i + j + len / 2] = aR - bR;
        im[i + j + len / 2] = aI - bI;
        const nR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nR;
      }
    }
  }
}

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
  params.stagingGainDb = NOMINAL_LUFS - msg.sourceLufs;
  params.outputGainDb = 0;
  params.fadeInSec = 0;
  params.fadeOutSec = 0;
  params.ceilingDb = 24; // transparent limiter for the core measurement
  params.limiterDelta = false;

  const chain = new MasterChain(fs, BLOCK);
  chain.setParams(params);
  chain.snapParams();
  for (let s = 0; s < n; s += BLOCK) {
    chain.processBlock(L, R, s, Math.min(BLOCK, n - s), s);
  }
  const processedLufs = measureIntegratedLufs(L, R, fs);
  // How the chain changed the excerpt's loudness beyond the staging gain.
  const chainDeltaDb = processedLufs - (rawLufs + params.stagingGainDb);
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

  // ── source diagnostics (the SUNO pathology checks) ──────────────────
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
  const L = new Float32Array(msg.l);
  const R = new Float32Array(msg.r);
  const fs = msg.fs;
  const n = L.length;
  const params: ChainParams = { ...msg.params };

  // Stage the source at nominal loudness, run the chain core with a
  // transparent output stage (0 dB gain, limiter ceiling far above signal).
  // Delta monitoring is a preview tool only — never rendered.
  params.stagingGainDb = NOMINAL_LUFS - msg.sourceLufs;
  params.outputGainDb = 0;
  params.limiterDelta = false;
  const coreParams: ChainParams = { ...params, ceilingDb: 24 };

  const chain = new MasterChain(fs, BLOCK);
  chain.setParams(coreParams);
  chain.snapParams();

  for (let s = 0; s < n; s += BLOCK) {
    const len = Math.min(BLOCK, n - s);
    chain.processBlock(L, R, s, len, s);
    if (s % (BLOCK * 64) === 0) {
      post({ type: 'progress', reqId: msg.reqId, phase: 'PROCESSING CHAIN', pct: (s / n) * 0.55 });
    }
  }

  post({ type: 'progress', reqId: msg.reqId, phase: 'MEASURING LOUDNESS', pct: 0.58 });
  const coreLufs = measureIntegratedLufs(L, R, fs);

  // Solve gain → limiter so integrated loudness lands on target.
  let gainDb = msg.params.targetLufs - coreLufs;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  let finalLufs = -70;
  let limiterMaxGr = 0;

  for (let iter = 0; iter < 4; iter++) {
    post({ type: 'progress', reqId: msg.reqId, phase: `LIMITING (PASS ${iter + 1})`, pct: 0.62 + iter * 0.08 });
    const g = dbToLin(gainDb);
    const limiter = new Limiter(fs);
    limiter.setCeiling(msg.params.ceilingDb);
    limiterMaxGr = 0;
    for (let s = 0; s < n; s += BLOCK) {
      const len = Math.min(BLOCK, n - s);
      for (let i = s; i < s + len; i++) {
        outL[i] = L[i] * g;
        outR[i] = R[i] * g;
      }
      limiter.processBlock(outL, outR, s, len);
      if (limiter.grDb > limiterMaxGr) limiterMaxGr = limiter.grDb;
    }
    finalLufs = measureIntegratedLufs(outL, outR, fs);
    const err = msg.params.targetLufs - finalLufs;
    if (Math.abs(err) < 0.15) break;
    gainDb += err * 0.95;
  }

  post({ type: 'progress', reqId: msg.reqId, phase: `ENCODING ${msg.encode.format.toUpperCase()}`, pct: 0.92 });
  const truePeakDb = measureTruePeakDb(outL, outR);
  const samplePeakDb = measureSamplePeakDb(outL, outR);
  const encoded = await encodeAudio(outL, outR, fs, msg.encode);

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
        durationSec: n / fs,
        sampleRate: fs,
        bitDepth: msg.encode.format === 'mp3' || msg.encode.format === 'opus' ? 16 : msg.encode.bitDepth,
        format: msg.encode.format,
        mp3Kbps: msg.encode.mp3Kbps,
        opusKbps: msg.encode.opusKbps,
        bytes: encoded.data.byteLength,
      },
    },
    [encoded.data],
  );
}
