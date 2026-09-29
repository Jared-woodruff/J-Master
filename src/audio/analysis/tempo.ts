// Tempo analysis for a loaded track: the global tempo and beat phase, the
// song's sections, and a tempo curve that follows the music over time.
// Generated tracks often drift (they speed up or slow down as they play),
// which no single fixed grid can describe, so the curve and a set of beats
// tracked through the music measure where the tempo moves and how far.
import { fft } from '../dsp/fft';

export const TEMPO_FFT = 1024;
export const TEMPO_HOP = 512;

export interface SongSection {
  startSec: number;
  endSec: number;
  label: string;
}

/** Local tempo, one point every `stepSec` starting at `startSec`. */
export interface TempoCurve {
  startSec: number;
  stepSec: number;
  /** BPM per point; NaN where the music carries no usable pulse. */
  bpm: number[];
}

/** A stretch where the tempo has left the one the track set out at. */
export interface DriftRegion {
  startSec: number;
  endSec: number;
  /** Where inside the region the tempo is furthest from the reference. */
  peakSec: number;
  peakBpm: number;
}

export interface TempoDrift {
  /** The tempo the track sets out at; drift is measured from it. */
  refBpm: number;
  endBpm: number;
  minBpm: number;
  maxBpm: number;
  /** Furthest the real beats get from the best single fixed-tempo grid. */
  maxSlipSec: number;
  maxSlipAtSec: number;
  regions: DriftRegion[];
}

export interface TempoAnalysis {
  bpm: number;
  firstBeatSec: number;
  firstBarSec: number;
  confidence: number;
  sections: SongSection[];
  curve: TempoCurve | null;
  /** Beat times (s) tracked through the music; `downbeat` indexes a bar line. */
  beats: number[];
  downbeat: number;
  /** Set only when the tempo drifts. */
  drift: TempoDrift | null;
}

/** Below this global confidence the pulse is too vague to judge drift. */
const DRIFT_MIN_CONFIDENCE = 0.25;
/** Columns this far below the loudest one are silence. */
const SILENCE_DB = 60;
/** Silence shorter than this at either end is just the file's edge. */
const EDGE_SILENCE_SEC = 0.5;
/** Band count of the per-column features that sections are found from. */
const N_BANDS = 8;

const NO_TEMPO: TempoAnalysis = {
  bpm: 0, firstBeatSec: 0, firstBarSec: 0, confidence: 0, sections: [],
  curve: null, beats: [], downbeat: 0, drift: null,
};

/**
 * Spectral-flux onset envelope → autocorrelation with octave weighting →
 * parabolic-refined BPM → beat phase by comb alignment; checkerboard
 * novelty for sections; then the tempo curve, tracked beats and drift.
 * Tempo is measured on the music alone: silence before or after it would
 * drag the beat grid. A track with no pulse reports bpm 0 and sections.
 */
export function analyzeTempo(L: Float32Array, R: Float32Array, fs: number): TempoAnalysis {
  const n = L.length;
  if (n < TEMPO_FFT * 2) return NO_TEMPO;
  const hopSec = TEMPO_HOP / fs;
  const durSec = n / fs;
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
  const colPow = new Float64Array(cols);      // column power, for silence
  const lowBins = Math.max(2, Math.round(220 / (fs / TEMPO_FFT)));

  // Per-column 8-band log energies for section detection.
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
    let pow = 0;
    for (let k = 1; k < TEMPO_FFT / 2; k++) {
      const p2 = re[k] * re[k] + im[k] * im[k];
      pow += p2;
      const mag = Math.log1p(20 * Math.sqrt(p2));
      const d = mag - prevMag[k];
      if (d > 0) {
        flux += d;
        if (k <= lowBins) lowFlux += d;
      }
      prevMag[k] = mag;
    }
    env[c] = flux;
    lowEnv[c] = lowFlux;
    colPow[c] = pow;
    for (let b = 0; b < N_BANDS; b++) {
      let e = 0;
      for (let k = bandEdges[b]; k < bandEdges[b + 1]; k++) {
        e += re[k] * re[k] + im[k] * im[k];
      }
      bandFeat[c * N_BANDS + b] = Math.log10(e + 1e-10);
    }
  }

  // Where the music is: columns [a0, a1] between the silence at the ends.
  let peakPow = 0;
  for (let c = 0; c < cols; c++) if (colPow[c] > peakPow) peakPow = colPow[c];
  if (!(peakPow > 0)) return { ...NO_TEMPO, sections: [{ startSec: 0, endSec: durSec, label: 'SILENCE' }] };
  const gate = peakPow * Math.pow(10, -SILENCE_DB / 10);
  let a0 = 0, a1 = cols - 1;
  while (a0 < a1 && colPow[a0] <= gate) a0++;
  while (a1 > a0 && colPow[a1] <= gate) a1--;
  const edge = Math.round(EDGE_SILENCE_SEC / hopSec);
  if (a0 < edge) a0 = 0;
  if (cols - 1 - a1 < edge) a1 = cols - 1;
  const offSec = a0 * hopSec;
  const endSec = a1 === cols - 1 ? durSec : (a1 * TEMPO_HOP + TEMPO_FFT) / fs;

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
  // Everything below runs on the music's columns; times add `offSec`.
  const det = detrended.subarray(a0, a1 + 1);
  const aCols = det.length;

  // Autocorrelation over 60–200 BPM lags, weighted toward ~120 BPM.
  const minLag = Math.max(2, Math.floor(60 / 200 / hopSec));
  const maxLag = Math.min(aCols - 2, Math.ceil(60 / 60 / hopSec));
  let bestLag = 0;
  let bestScore = -1;
  const acAt = (lag: number): number => {
    let s = 0;
    for (let c = lag; c < aCols; c++) s += det[c] * det[c - lag];
    return s / (aCols - lag);
  };
  const acCache = new Float64Array(Math.max(minLag, maxLag) + 2);
  for (let lag = minLag; lag <= maxLag; lag++) acCache[lag] = acAt(lag);
  // A drifting tempo smears the whole-track peak at the beat, which can let
  // a dotted or triplet periodicity win; short windows hardly drift, so
  // they vote on the tempo and the whole-track peak is sought near it.
  const voted = votedLag(det, minLag, maxLag, hopSec);
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (voted && Math.abs(Math.log(lag / voted)) > 0.08) continue;
    const bpm = 60 / (lag * hopSec);
    // Log-gaussian preference centred near 120 BPM.
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const harmonic = lag * 2 <= maxLag ? 0.4 * acCache[lag * 2] : 0;
    const score = (acCache[lag] + harmonic) * w;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }

  // Confidence: winning peak vs the autocorrelation average.
  let acMean = 0;
  let acCount = 0;
  for (let lag = minLag; lag <= maxLag; lag++) { acMean += acCache[lag]; acCount++; }
  acMean /= Math.max(1, acCount);
  const confidence = bestLag > 0 && acMean > 0
    ? Math.max(0, Math.min(1, (acCache[bestLag] / acMean - 1) / 4))
    : 0;
  // No periodicity at all (silence, a blip, a drone), or less than a bar
  // of music to hear one in: no tempo, but the sections still stand.
  if (confidence <= 0 || aCols < 4 * bestLag) {
    const bounds = withSilence(sectionBounds(bandFeat, colPow, gate, hopSec, a0, a1), offSec, endSec, durSec);
    return { ...NO_TEMPO, sections: labelSections(bounds, durSec, bandFeat, colPow, gate, hopSec) };
  }

  // Parabolic refinement around the winning lag.
  let refined = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = acCache[bestLag - 1], y1 = acCache[bestLag], y2 = acCache[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    // Only a real peak refines, and never past its neighbours.
    if (denom < -1e-12) refined = bestLag + Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom));
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
  for (let c = a0; c <= a1; c++) { lowTotal += lowEnv[c]; fullTotal += env[c]; }
  const phaseBase = lowTotal > fullTotal * 0.004 ? lowEnv.subarray(a0, a1 + 1) : det;
  // Squaring makes sharp attacks (kicks) out-vote slow energy swells.
  const phaseEnv = new Float64Array(aCols);
  for (let c = 0; c < aCols; c++) phaseEnv[c] = phaseBase[c] * phaseBase[c];
  let bestOff = 0;
  let bestSum = -1;
  const steps = Math.min(64, Math.floor(period * 4));
  for (let oi = 0; oi < steps; oi++) {
    const off = (oi / steps) * period;
    let s = 0;
    for (let c = off; c < aCols; c += period) s += phaseEnv[Math.round(c)] ?? 0;
    if (s > bestSum) { bestSum = s; bestOff = off; }
  }
  // Flux lands in the first window containing an onset, whose start time is
  // about half a window early — compensate so beats sit on the true onsets.
  const latencySec = TEMPO_FFT / 2 / fs;
  let firstBeatSec = offSec + bestOff * hopSec + latencySec;
  const periodSec = refined * hopSec;
  firstBeatSec = ((firstBeatSec % periodSec) + periodSec) % periodSec;

  // ── tempo over time ───────────────────────────────────────────────
  const localCurve = tempoCurve(det, refined, hopSec);
  const curve = localCurve && { ...localCurve, startSec: localCurve.startSec + offSec };
  // Beats follow the same kick-led onsets as the phase above, so they land
  // on the beat rather than on off-beat hats and claps.
  const beats = trackBeats(phaseEnv, localCurve, refined, hopSec, latencySec).map((t) => t + offSec);
  const fit = fitFixedGrid(beats);
  const drift = curve && fit && confidence >= DRIFT_MIN_CONFIDENCE
    ? assessDrift(curve, fit, bpm, offSec, endSec)
    : null;
  // The best fixed grid through the tracked beats is a finer tempo and
  // phase than the whole-track estimate, so a steady track adopts it.
  let bpmOut = bpm;
  if (fit && confidence >= DRIFT_MIN_CONFIDENCE) {
    bpmOut = 60 / fit.beatSec;
    if (!drift && fit.maxSlipSec <= slipLimitSec(bpm)) {
      firstBeatSec = ((fit.firstBeatSec % fit.beatSec) + fit.beatSec) % fit.beatSec;
    }
  }

  // ── section detection ─────────────────────────────────────────────
  const beatSecF = 60 / bpmOut;
  const rawBounds = sectionBounds(bandFeat, colPow, gate, hopSec, a0, a1);

  // ── bar anchoring ─────────────────────────────────────────────────
  // Sections start on downbeats. A steady track uses one fixed bar grid;
  // a drifting one takes its bar lines from the tracked beats, since a
  // fixed grid would put them in the wrong places.
  let firstBarSec = firstBeatSec;
  let downbeat = 0;
  let snapped: number[];
  if (drift && beats.length >= 8) {
    downbeat = barPhaseFromBeats(beats, rawBounds, lowEnv, hopSec, latencySec);
    firstBeatSec = beats[0];
    firstBarSec = beats[downbeat];
    snapped = rawBounds.map((b) => {
      const d = nearestDownbeat(beats, b, downbeat);
      const barLen = 4 * localBeatSec(beats, b);
      return Math.abs(d - b) <= barLen ? Math.max(0, d) : b;
    });
  } else {
    // Choose the beat offset (0–3) that puts bar lines closest to the
    // detected boundaries.
    const barSec = beatSecF * 4;
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
    snapped = rawBounds.map((b) => {
      const m = ((b - firstBarSec) % barSec + barSec) % barSec;
      const down = b - m;
      const up = down + barSec;
      const target = m < barSec / 2 ? down : up;
      return Math.abs(target - b) <= barSec ? Math.max(0, target) : b;
    });
  }

  const bounds = withSilence(snapped, offSec, endSec, durSec);
  const sections = labelSections(bounds, durSec, bandFeat, colPow, gate, hopSec);
  return { bpm: bpmOut, firstBeatSec, firstBarSec, confidence, sections, curve, beats, downbeat, drift };
}

/** Silence at least this long before or after the music is a section. */
const SILENT_SECTION_SEC = 2;

/**
 * The music's own section changes, plus where it starts and stops when
 * real silence lies before or after it. Those two are exact, not bar lines.
 */
function withSilence(bounds: number[], musicStartSec: number, musicEndSec: number, durSec: number): number[] {
  const inner = bounds.filter((b) => b > musicStartSec + 1 && b < musicEndSec - 1);
  return [
    ...(musicStartSec >= SILENT_SECTION_SEC ? [musicStartSec] : []),
    ...inner,
    ...(durSec - musicEndSec >= SILENT_SECTION_SEC ? [musicEndSec] : []),
  ];
}

/**
 * Section changes inside the music [a0, a1]: checkerboard novelty on the
 * band features (how different the next ~2 s sounds from the previous
 * ~2 s, every quarter second), peaks above the music's typical change.
 * Silence would dwarf every real change, so windows that touch any don't
 * set that bar.
 */
function sectionBounds(
  bandFeat: Float64Array, colPow: Float64Array, gate: number, hopSec: number, a0: number, a1: number,
): number[] {
  const cols = colPow.length;
  const quiet = new Int32Array(cols + 1);   // silent columns before each index
  for (let c = 0; c < cols; c++) quiet[c + 1] = quiet[c] + (colPow[c] <= gate ? 1 : 0);
  const W = Math.round(2.0 / hopSec);
  const stride = Math.max(1, Math.round(0.25 / hopSec));
  const novelty: { sec: number; v: number; inMusic: boolean; clean: boolean }[] = [];
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
    const inMusic = c - W >= a0 && c + W <= a1 + 1;
    novelty.push({ sec: c * hopSec, v: Math.sqrt(dist), inMusic, clean: inMusic && quiet[c + W] === quiet[c - W] });
  }
  let ref = novelty.filter((p) => p.clean);
  if (ref.length < 8) ref = novelty.filter((p) => p.inMusic);
  if (ref.length < 8) ref = novelty;
  let nvMean = 0;
  for (const p of ref) nvMean += p.v;
  nvMean /= Math.max(1, ref.length);
  let nvVar = 0;
  for (const p of ref) nvVar += (p.v - nvMean) * (p.v - nvMean);
  const nvStd = Math.sqrt(nvVar / Math.max(1, ref.length));
  const threshold = nvMean + nvStd * 1.2;
  const minGapSec = 8;
  const rawBounds: number[] = [];
  for (let i = 1; i < novelty.length - 1; i++) {
    const p = novelty[i];
    if (p.inMusic && p.v > threshold && p.v >= novelty[i - 1].v && p.v >= novelty[i + 1].v) {
      if (rawBounds.length === 0 || p.sec - rawBounds[rawBounds.length - 1] >= minGapSec) {
        rawBounds.push(p.sec);
      } else if (p.v > (novelty.find((q) => q.sec === rawBounds[rawBounds.length - 1])?.v ?? 0)) {
        rawBounds[rawBounds.length - 1] = p.sec;
      }
    }
  }

  // A build-up (a riser, a crescendo) draws the 2 s novelty early, a bar
  // or so ahead of the change; the change itself is where the sound turns
  // over within half a second, so each one moves to the sharpest turn
  // near it.
  const Ws = Math.round(0.5 / hopSec);
  const cum = new Float64Array((cols + 1) * N_BANDS);
  for (let c = 0; c < cols; c++) {
    for (let b = 0; b < N_BANDS; b++) cum[(c + 1) * N_BANDS + b] = cum[c * N_BANDS + b] + bandFeat[c * N_BANDS + b];
  }
  const turn = (c: number): number => {
    let dist = 0;
    for (let b = 0; b < N_BANDS; b++) {
      const before = cum[c * N_BANDS + b] - cum[(c - Ws) * N_BANDS + b];
      const after = cum[(c + Ws) * N_BANDS + b] - cum[c * N_BANDS + b];
      dist += ((after - before) / Ws) ** 2;
    }
    return dist;
  };
  return rawBounds.map((t) => {
    const lo = Math.max(a0 + Ws, Math.round((t - REFINE_BACK_SEC) / hopSec));
    const hi = Math.min(a1 + 1 - Ws, Math.round((t + REFINE_AHEAD_SEC) / hopSec));
    let best = -1, bestV = -1;
    for (let c = lo; c <= hi; c++) {
      const v = turn(c);
      if (v > bestV) { bestV = v; best = c; }
    }
    return best >= 0 ? best * hopSec : t;
  });
}

/** How far around a 2 s novelty peak the sharp turn is sought. */
const REFINE_BACK_SEC = 1;
const REFINE_AHEAD_SEC = 2.5;

/**
 * Sections between the boundaries, labelled by energy (terciles of the
 * music's mean band energy); a stretch that is nearly all silence says so.
 */
function labelSections(
  bounds: number[], durSec: number, bandFeat: Float64Array, colPow: Float64Array, gate: number, hopSec: number,
): SongSection[] {
  const cols = colPow.length;
  const boundsAll = [0, ...bounds.filter((b) => b > 1 && b < durSec - 2), durSec];
  const means: number[] = [];
  const silent: boolean[] = [];
  for (let i = 0; i < boundsAll.length - 1; i++) {
    const c0 = Math.floor(boundsAll[i] / hopSec);
    const c1 = Math.min(cols, Math.floor(boundsAll[i + 1] / hopSec));
    let m = 0, cnt = 0, quiet = 0;
    for (let c = c0; c < c1; c++) {
      for (let b = 0; b < N_BANDS; b++) m += bandFeat[c * N_BANDS + b];
      if (colPow[c] <= gate) quiet++;
      cnt++;
    }
    means.push(cnt > 0 ? m / cnt : -10);
    silent.push(cnt > 0 && quiet >= 0.9 * cnt);
  }
  const sorted = means.filter((_, i) => !silent[i]).sort((a, b) => a - b);
  const t1 = sorted[Math.floor(sorted.length / 3)];
  const t2 = sorted[Math.floor((sorted.length * 2) / 3)];
  const first = silent.indexOf(false);
  const last = silent.lastIndexOf(false);
  const sections: SongSection[] = [];
  for (let i = 0; i < boundsAll.length - 1; i++) {
    let label = silent[i] ? 'SILENCE' : means[i] <= t1 ? 'LOW' : means[i] >= t2 ? 'PEAK' : 'MID';
    if (i === first && label !== 'PEAK') label = 'INTRO';
    if (i === last && i > first && label !== 'PEAK') label = 'OUTRO';
    sections.push({ startSec: boundsAll[i], endSec: boundsAll[i + 1], label });
  }
  return sections;
}

interface FixedGridFit {
  beatSec: number;
  firstBeatSec: number;
  /** Furthest the beats get from this grid, over nine-beat medians. */
  maxSlipSec: number;
  maxSlipAtSec: number;
}

/**
 * The best fixed grid through the tracked beats (least squares on beat
 * index). Slip is read from residuals smoothed over nine beats so one
 * mistimed beat can't count as the grid sliding.
 */
function fitFixedGrid(beats: number[]): FixedGridFit | null {
  const K = beats.length;
  if (K < 16) return null;
  let sk = 0, st = 0, skk = 0, skt = 0;
  for (let k = 0; k < K; k++) { sk += k; st += beats[k]; skk += k * k; skt += k * beats[k]; }
  const beatSec = (K * skt - sk * st) / (K * skk - sk * sk);
  const firstBeatSec = (st - beatSec * sk) / K;
  if (!(beatSec > 0)) return null;
  const resid = beats.map((t, k) => t - (firstBeatSec + beatSec * k));
  let maxSlipSec = 0;
  let maxSlipAtSec = 0;
  for (let k = 0; k < K; k++) {
    const nb = resid.slice(Math.max(0, k - 4), k + 5).sort((a, b) => a - b);
    const d = Math.abs(nb[Math.floor(nb.length / 2)]);
    if (d > maxSlipSec) { maxSlipSec = d; maxSlipAtSec = beats[k]; }
  }
  return { beatSec, firstBeatSec, maxSlipSec, maxSlipAtSec };
}

/** Beats further than this off a fixed grid are audibly off it. */
function slipLimitSec(bpm: number): number {
  return Math.max(DRIFT_MIN_SLIP_SEC, 60 / bpm / 8);
}

// ── tempo vote ──────────────────────────────────────────────────────────
const VOTE_WIN_SEC = 20;
const VOTE_HOP_SEC = 10;

/**
 * Each 20 s window picks its own beat lag with the whole-track scoring;
 * the lag most windows agree on (within 4%) wins. Null for tracks too
 * short to hold several windows.
 */
function votedLag(det: Float64Array, minLag: number, maxLag: number, hopSec: number): number | null {
  const cols = det.length;
  const W = Math.round(VOTE_WIN_SEC / hopSec);
  const hop = Math.round(VOTE_HOP_SEC / hopSec);
  if (cols < W + 2 * hop || maxLag * 2 >= W) return null;
  const votes: number[] = [];
  const ac = new Float64Array(maxLag * 2 + 2);
  for (let c0 = 0; c0 + W <= cols; c0 += hop) {
    for (let lag = minLag; lag <= Math.min(maxLag * 2, W - 1); lag++) {
      let s = 0;
      for (let i = c0 + lag; i < c0 + W; i++) s += det[i] * det[i - lag];
      ac[lag] = s / (W - lag);
    }
    let best = 0, bestScore = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const w = Math.exp(-0.5 * Math.pow(Math.log2(60 / (lag * hopSec) / 120) / 0.9, 2));
      const score = (ac[lag] + 0.4 * ac[lag * 2]) * w;
      if (score > bestScore) { bestScore = score; best = lag; }
    }
    if (best > 0) votes.push(best);
  }
  if (votes.length < 3) return null;
  let winner = votes[0], most = 0;
  for (const v of votes) {
    let n = 0;
    for (const u of votes) if (Math.abs(Math.log(u / v)) <= 0.04) n++;
    if (n > most) { most = n; winner = v; }
  }
  // Centre on the agreeing votes rather than one of them.
  const agree = votes.filter((u) => Math.abs(Math.log(u / winner)) <= 0.04).sort((a, b) => a - b);
  return agree[Math.floor(agree.length / 2)];
}

// ── tempo curve ─────────────────────────────────────────────────────────
const CURVE_WIN_SEC = 12;
const CURVE_STEP_SEC = 1;
/** Normalized bar-lag autocorrelation below which a window has no pulse. */
const CURVE_MIN_CONF = 0.15;

/**
 * Local tempo in overlapping windows. Each window finds its beat lag first
 * (the nearest rival periodicities, dotted and triplet feels, sit 25% or
 * more away), then refines on the lag of four such beats, which gives four
 * times the timing resolution per beat.
 */
function tempoCurve(det: Float64Array, period: number, hopSec: number): TempoCurve | null {
  const cols = det.length;
  const W = Math.round(CURVE_WIN_SEC / hopSec);
  const step = Math.round(CURVE_STEP_SEC / hopSec);
  if (cols < W || period <= 0) return null;

  const r = new Float64Array(Math.ceil(period * 4 * 1.2) + 4);
  const peakLag = (c0: number, lo: number, hi: number): { lag: number; r: number } => {
    lo = Math.max(2, lo);
    hi = Math.min(W - 2, hi);
    for (let lag = lo - 1; lag <= hi + 1; lag++) {
      let s = 0;
      for (let i = c0 + lag; i < c0 + W; i++) s += det[i] * det[i - lag];
      r[lag] = s / (W - lag);
    }
    let best = lo;
    for (let lag = lo; lag <= hi; lag++) if (r[lag] > r[best]) best = lag;
    const y0 = r[best - 1], y1 = r[best], y2 = r[best + 1];
    const den = y0 - 2 * y1 + y2;
    const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    return { lag: best + off, r: y1 };
  };

  const raw: number[] = [];
  for (let c0 = 0; c0 + W <= cols; c0 += step) {
    let e0 = 0;
    for (let i = c0; i < c0 + W; i++) e0 += det[i] * det[i];
    e0 /= W;
    if (e0 <= 1e-12) { raw.push(NaN); continue; }
    const beat = peakLag(c0, Math.floor(period * 0.88), Math.ceil(period * 1.12));
    const bar = peakLag(c0, Math.floor(4 * beat.lag * 0.97), Math.ceil(4 * beat.lag * 1.03));
    raw.push(bar.r / e0 >= CURVE_MIN_CONF ? 60 / ((bar.lag / 4) * hopSec) : NaN);
  }
  // A five-point median removes single-window outliers.
  const bpm = raw.map((v, i) => {
    if (!Number.isFinite(v)) return NaN;
    const nb = raw.slice(Math.max(0, i - 2), i + 3).filter(Number.isFinite).sort((a, b) => a - b);
    return nb[Math.floor(nb.length / 2)];
  });
  return { startSec: (W / 2) * hopSec, stepSec: step * hopSec, bpm };
}

/** Curve values with NaN gaps bridged linearly and held at the ends. */
export function bridged(values: number[]): number[] | null {
  const idx: number[] = [];
  values.forEach((v, i) => { if (Number.isFinite(v)) idx.push(i); });
  if (idx.length === 0) return null;
  const out = values.slice();
  for (let i = 0; i < out.length; i++) {
    if (Number.isFinite(out[i])) continue;
    let a = -1, b = -1;
    for (const j of idx) { if (j < i) a = j; else { b = j; break; } }
    out[i] = a < 0 ? values[b] : b < 0 ? values[a] : values[a] + ((values[b] - values[a]) * (i - a)) / (b - a);
  }
  return out;
}

// ── beat tracking ───────────────────────────────────────────────────────
/**
 * Dynamic-programming beat tracker (after Ellis, 2007): each beat is the
 * best onset one local period after the previous one, where the local
 * period comes from the tempo curve, so the beats follow a drifting tempo
 * instead of a fixed one. Beat times are refined to a fraction of a frame.
 */
function trackBeats(
  det: Float64Array, curve: TempoCurve | null, period: number, hopSec: number, latencySec: number,
): number[] {
  const cols = det.length;
  if (cols < period * 4) return [];

  // Onset strength in units of its standard deviation, lightly smoothed.
  let mean = 0;
  for (let c = 0; c < cols; c++) mean += det[c];
  mean /= cols;
  let sd = 0;
  for (let c = 0; c < cols; c++) sd += (det[c] - mean) * (det[c] - mean);
  sd = Math.sqrt(sd / cols) || 1;
  const sigma = Math.max(1, period / 32);
  const half = Math.ceil(3 * sigma);
  const kern: number[] = [];
  for (let k = -half; k <= half; k++) kern.push(Math.exp(-0.5 * (k / sigma) ** 2));
  const O = new Float64Array(cols);
  for (let c = 0; c < cols; c++) {
    let s = 0;
    for (let k = -half; k <= half; k++) {
      const j = c + k;
      if (j >= 0 && j < cols) s += det[j] * kern[k + half];
    }
    O[c] = s / sd;
  }

  // Local period in frames, per frame.
  const P = new Float64Array(cols).fill(period);
  const curveBpm = curve ? bridged(curve.bpm) : null;
  if (curve && curveBpm) {
    for (let c = 0; c < cols; c++) {
      const x = (c * hopSec - curve.startSec) / curve.stepSec;
      const i = Math.max(0, Math.min(curveBpm.length - 1, Math.floor(x)));
      const j = Math.min(curveBpm.length - 1, i + 1);
      const u = Math.max(0, Math.min(1, x - i));
      const b = curveBpm[i] + (curveBpm[j] - curveBpm[i]) * u;
      if (b > 0) P[c] = 60 / (b * hopSec);
    }
  }

  // The curve already follows the tempo, so the tracker only has to find
  // the phase: a stiff period keeps it on the beat through passages with
  // no drums instead of chasing pads and delay echoes.
  const TIGHTNESS = 1000;
  const score = new Float64Array(cols);
  const back = new Int32Array(cols).fill(-1);
  for (let t = 0; t < cols; t++) {
    const p = P[t];
    const lo = Math.max(0, Math.round(t - 2 * p));
    const hi = Math.round(t - p / 2);
    let best = -Infinity;
    let arg = -1;
    for (let q = lo; q <= hi; q++) {
      const lr = Math.log((t - q) / p);
      const v = score[q] - TIGHTNESS * lr * lr;
      if (v > best) { best = v; arg = q; }
    }
    score[t] = O[t] + (arg >= 0 ? best : 0);
    back[t] = arg;
  }
  // The last beat: the best-scoring frame within the final local period.
  let last = cols - 1;
  let lastScore = -Infinity;
  for (let t = Math.max(0, Math.floor(cols - P[cols - 1])); t < cols; t++) {
    if (score[t] > lastScore) { lastScore = score[t]; last = t; }
  }
  const frames: number[] = [];
  for (let t = last; t >= 0; t = back[t]) frames.push(t);
  frames.reverse();

  // Sub-frame timing: settle on the onset peak (a real onset only) and
  // interpolate its apex.
  const out: number[] = [];
  for (const f0 of frames) {
    let f = f0;
    for (let k = -2; k <= 2; k++) {
      const j = f0 + k;
      if (j > 0 && j < cols - 1 && O[j] > 1 && O[j] > O[f]) f = j;
    }
    let off = 0;
    if (f > 0 && f < cols - 1) {
      const a = O[f - 1], b = O[f], c = O[f + 1];
      const den = a - 2 * b + c;
      if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
    }
    const t = (f + off) * hopSec + latencySec;
    if (out.length === 0 || t > out[out.length - 1]) out.push(t);
  }
  return out;
}

// ── drift ───────────────────────────────────────────────────────────────
/** A range narrower than this share of the tempo is steady. */
const DRIFT_MIN_RANGE = 0.0035;
/** A range this wide is drift however little the beats have slid yet. */
const DRIFT_CLEAR_RANGE = 0.01;
/** Beats this far off the best fixed grid (or an eighth of a beat) matter. */
const DRIFT_MIN_SLIP_SEC = 0.06;

/**
 * Drift needs the tempo curve to move (so a timing glitch in the beat
 * tracker can't raise it) and, unless it moves a lot, the beats to slide
 * off any fixed grid (so curve noise alone can't either). Regions are
 * measured against the tempo the track sets out at, which is usually the
 * tempo it was meant to have, and end where the music does, not in the
 * silence after it.
 */
function assessDrift(
  curve: TempoCurve, fit: FixedGridFit, bpm: number, musicStartSec: number, musicEndSec: number,
): TempoDrift | null {
  const at = (i: number) => curve.startSec + i * curve.stepSec;
  const valid: { i: number; v: number }[] = [];
  curve.bpm.forEach((v, i) => { if (Number.isFinite(v)) valid.push({ i, v }); });
  if (valid.length < Math.max(8, curve.bpm.length * 0.5)) return null;

  const sorted = valid.map((p) => p.v).sort((a, b) => a - b);
  const pct = (q: number) => sorted[Math.round(q * (sorted.length - 1))];
  const minBpm = pct(0.05);
  const maxBpm = pct(0.95);
  const vals = bridged(curve.bpm)!;

  // A short track has little time to slide far, so a large tempo change
  // counts on its own.
  const range = maxBpm - minBpm;
  if (range < DRIFT_MIN_RANGE * bpm) return null;
  if (fit.maxSlipSec < slipLimitSec(bpm) && range < DRIFT_CLEAR_RANGE * bpm) return null;
  const maxSlip = fit.maxSlipSec;
  const maxSlipAt = fit.maxSlipAtSec;

  // The reference: the median of the first ~16 s that carry a pulse, or
  // of its first few seconds when the track is already moving by then.
  const tol = Math.max(0.25, bpm * 0.002);
  let head = valid.slice(0, Math.max(3, Math.round(16 / curve.stepSec))).map((p) => p.v);
  if (Math.max(...head) - Math.min(...head) > 2 * tol) head = head.slice(0, 3);
  head.sort((a, b) => a - b);
  const refBpm = head[Math.floor(head.length / 2)];

  // Hysteresis: a region opens beyond the tolerance and closes back inside
  // half of it; each start is walked back to where the departure began.
  const spans: [number, number][] = [];
  let open = -1;
  for (let i = 0; i < vals.length; i++) {
    const dev = Math.abs(vals[i] - refBpm);
    if (open < 0 && dev > tol) open = i;
    else if (open >= 0 && dev < tol / 2) { spans.push([open, i - 1]); open = -1; }
  }
  if (open >= 0) spans.push([open, vals.length - 1]);
  for (const s of spans) {
    while (s[0] > 0 && Math.abs(vals[s[0] - 1] - refBpm) > tol / 4) s[0]--;
  }
  // Merge spans a few seconds apart; drop blips.
  const merged: [number, number][] = [];
  for (const s of spans) {
    const prev = merged[merged.length - 1];
    if (prev && at(s[0]) - at(prev[1]) < 6) prev[1] = Math.max(prev[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  let kept = merged.filter(([a, b]) => at(b) - at(a) >= 4);
  if (kept.length === 0) {
    // Flagged but never far from the reference for long: show where it
    // strays most.
    let pk = 0;
    for (let i = 0; i < vals.length; i++) if (Math.abs(vals[i] - refBpm) > Math.abs(vals[pk] - refBpm)) pk = i;
    const lim = Math.abs(vals[pk] - refBpm) / 2;
    let a = pk, b = pk;
    while (a > 0 && Math.abs(vals[a - 1] - refBpm) > lim) a--;
    while (b < vals.length - 1 && Math.abs(vals[b + 1] - refBpm) > lim) b++;
    kept = [[a, b]];
  }
  const lastIdx = vals.length - 1;
  const regions: DriftRegion[] = kept.map(([a, b]) => {
    let pk = a;
    for (let i = a; i <= b; i++) if (Math.abs(vals[i] - refBpm) > Math.abs(vals[pk] - refBpm)) pk = i;
    return {
      startSec: a === 0 ? musicStartSec : at(a),
      endSec: b === lastIdx ? musicEndSec : at(b),
      peakSec: at(pk),
      peakBpm: vals[pk],
    };
  });

  return {
    refBpm,
    endBpm: valid[valid.length - 1].v,
    minBpm,
    maxBpm,
    maxSlipSec: maxSlip,
    maxSlipAtSec: maxSlipAt,
    regions,
  };
}

// ── bars from tracked beats ─────────────────────────────────────────────
/** The downbeat phase (0–3) for tracked beats. */
function barPhaseFromBeats(
  beats: number[], bounds: number[], lowEnv: Float64Array, hopSec: number, latencySec: number,
): number {
  if (bounds.length > 0) {
    let bestK = 0;
    let bestDist = Infinity;
    for (let k = 0; k < 4; k++) {
      let sum = 0;
      for (const b of bounds) sum += Math.abs(nearestDownbeat(beats, b, k) - b);
      if (sum < bestDist) { bestDist = sum; bestK = k; }
    }
    return bestK;
  }
  // No section changes to go by: the kick usually lands hardest on the one.
  let bestK = 0;
  let bestE = -1;
  for (let k = 0; k < 4; k++) {
    let e = 0;
    for (let i = k; i < beats.length; i += 4) {
      const f = Math.round((beats[i] - latencySec) / hopSec);
      if (f >= 0 && f < lowEnv.length) e += lowEnv[f] * lowEnv[f];
    }
    if (e > bestE) { bestE = e; bestK = k; }
  }
  return bestK;
}

/** Index of the last beat at or before `t` (−1 when `t` precedes them all). */
function beatIndexBefore(beats: number[], t: number): number {
  let lo = 0, hi = beats.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Time of the bar line (a beat whose index ≡ phase, mod 4) nearest `t`. */
function nearestDownbeat(beats: number[], t: number, phase: number): number {
  const i = Math.max(phase, beatIndexBefore(beats, t));
  const below = i - ((((i - phase) % 4) + 4) % 4);
  let best = beats[below] ?? beats[phase];
  for (const j of [below, below + 4]) {
    if (j >= 0 && j < beats.length && Math.abs(beats[j] - t) < Math.abs(best - t)) best = beats[j];
  }
  return best;
}

/** Local beat length at `t`, from the tracked beats. */
function localBeatSec(beats: number[], t: number): number {
  const i = Math.min(beats.length - 2, Math.max(0, beatIndexBefore(beats, t)));
  return beats[i + 1] - beats[i];
}
