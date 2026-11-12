// Main-thread audio engine: owns the AudioContext (48 kHz), the worklet
// playback node, the analysers for the spectrum, the source buffers, and the
// offline render workers. All UI actions route through here.
import { ChainParams, NOMINAL_LUFS, stagingGainDbFor } from './dsp/params';
import type { EncodeOptions } from './encode';
import type { SongSection, TempoCurve, TempoDrift } from './analysis/tempo';
import { planRepair, REPAIR_MAX_STRETCH, type RepairPlan } from './analysis/repair';
import type { SourceChecks } from './analysis/source-checks';
import { encodeWavFloat } from './wav';
import { scaleTempo } from '../lib/tempo-scale';
import { decodeAiff, aiffFormat } from './aiff';

export type { SourceChecks } from './analysis/source-checks';

export type { SongSection, TempoCurve, TempoDrift, DriftRegion } from './analysis/tempo';

export interface MeterFrame {
  playhead: number;
  playing: boolean;
  idle: boolean;
  momentary: number;
  shortTerm: number;
  integrated: number;
  truePeakDb: number;
  /** True peak of each side over the frame. */
  peakLDb: number;
  peakRDb: number;
  compGrDb: number;
  limiterGrDb: number;
  deharshGrDb: number;
  /** What the peak clipper took off (0 with CLIP out). */
  clipGrDb: number;
  correlation: number;
  /** The same below 150 Hz: where a mono fold-down loses its bass. */
  correlationLow: number;
}

export interface SourceInfo {
  name: string;
  durationSec: number;
  sampleRate: number;      // post-resample rate (48000)
  originalSampleRate: number;
  originalBitDepth: number | null;
  channels: number;
  lufs: number;
  /** Loudness range (EBU R128), LU. */
  lra: number;
  /** The loudest 400 ms and the loudest 3 s, LUFS. */
  maxMomentary: number;
  maxShortTerm: number;
  truePeakDb: number;
  samplePeakDb: number;
  /** L/R RMS imbalance in dB; positive = right louder. */
  balanceOffsetDb: number;
  /** Source pathology measurements (AI-music checks). */
  diagnostics: SourceDiagnostics;
  /** What the file says about how it was made: bandwidth, edges, flat tops. */
  checks: SourceChecks;
  /** True when the file came in at another rate and the app's own filter converted it. */
  converted: boolean;
  /** NaN/∞ samples in the file, replaced with silence on load. */
  repairedSamples: number;
}

/** A source as a file, before the analysis fills in the rest. */
type SourceFile = Pick<SourceInfo,
  'name' | 'durationSec' | 'sampleRate' | 'originalSampleRate' | 'originalBitDepth' | 'repairedSamples' | 'channels' | 'converted'>;

/** A stereo pair with the worker's analysis of it: ready to become the source in one step. */
interface Take {
  l: Float32Array;
  r: Float32Array;
  file: SourceFile;
  analyzed: any;
}

/** A moment of a repair → the same moment of the file (identity without a repair). */
function originalSec(plan: RepairPlan | null, sec: number): number {
  return plan ? plan.warp(sec * TARGET_RATE) / TARGET_RATE : sec;
}

/** A moment of the file → the same moment of its repair (identity without a repair). */
function repairedSec(plan: RepairPlan | null, sec: number): number {
  if (!plan) return sec;
  const s = sec * TARGET_RATE;
  let lo = 0, hi = plan.outLength;
  for (let i = 0; i < 48; i++) {
    const m = (lo + hi) / 2;
    if (plan.warp(m) < s) lo = m; else hi = m;
  }
  return lo / TARGET_RATE;
}

/** A take change, and where a moment of the last take is in the new one. */
export interface TakeSwap {
  info: SourceInfo;
  map: (sec: number) => number;
}

export interface SourceDiagnostics {
  /** Side-vs-mid energy below 140 Hz, dB. High = bass smeared into the sides. */
  sideBassRelDb: number;
  /** >4.5 kHz share of the mono programme, dB. High = harsh/bright. */
  harshRelDb: number;
  /** Energy-weighted mean stereo correlation. */
  corrMean: number;
  /** 5th-percentile windowed correlation. Low = phasey, mono-unsafe. */
  corrWorst: number;
  /** A side with nothing on it at all. */
  deadChannel?: 'left' | 'right' | null;
}

const NO_CHECKS: SourceChecks = {
  cutoffHz: null, cutoffDropDb: 0, headSilenceSec: 0, tailSilenceSec: 0, startLevelDb: -200, endLevelDb: -200,
  abruptStart: false, abruptEnd: false, clippedRuns: 0, dcOffset: 0,
};

export interface TempoInfo {
  /** 0 when the track has no pulse to measure (silence, a drone, a blip). */
  bpm: number;
  firstBeatSec: number;
  firstBarSec: number;
  confidence: number;
  sections: SongSection[];
  /** Local tempo over time; null when the track is too short to measure. */
  curve: TempoCurve | null;
  /** Beat times tracked through the music (s); `downbeat` indexes a bar line. */
  beats: number[];
  downbeat: number;
  /** Set when the tempo drifts; the grid and CLICK then follow `beats`. */
  drift: TempoDrift | null;
}

export interface WaveformLevel {
  /** Samples per bucket at this pyramid level. */
  spb: number;
  mins: Float32Array;
  maxs: Float32Array;
  rms: Float32Array;
}

export interface WaveformPeaks {
  /** Fine → coarse peak pyramid. */
  levels: WaveformLevel[];
}

export interface ExportStats {
  integratedLufs: number;
  truePeakDb: number;
  samplePeakDb: number;
  appliedGainDb: number;
  limiterMaxGrDb: number;
  clipMaxGrDb?: number;
  /** False when the source was too quiet (or short) to measure: unity gain. */
  loudnessMeasured?: boolean;
  /** False when the target was out of reach under the ceiling: `integratedLufs` is where it landed. */
  targetReached?: boolean;
  targetLufs?: number;
  ceilingDb?: number;
  /** Loudness range, peak-to-loudness, and the loudest moments of the master. */
  lra?: number;
  plr?: number;
  maxMomentary?: number;
  maxShortTerm?: number;
  /** True peak of a lossy file once decoded (codecs overshoot); undefined for lossless. */
  codecPeakDb?: number;
  durationSec: number;
  sampleRate: number;
  bitDepth: number;
  dither?: 'tpdf' | 'shaped';
  format: string;
  mp3Kbps?: number;
  opusKbps?: number;
  bytes: number;
}

/** What a report of a master draws: its waveform and loudness lane, small. */
export interface RenderReport {
  wave: { mins: number[]; maxs: number[] };
  lane: number[];
  laneStepSec: number;
}

export interface RenderResult {
  data: ArrayBuffer;
  ext: string;
  mime: string;
  stats: ExportStats;
  report?: RenderReport;
  /** Companion formats encoded from the same render. */
  extras?: { data: ArrayBuffer; ext: string; mime: string; format: string; bytes: number }[];
}

/** What the full solve found for the console as it stands: where an export would land. */
export interface MasterEstimate {
  lufs: number;
  /** False when the target can't be had under the ceiling. */
  reached: boolean;
  measured: boolean;
  appliedGainDb: number;
  limiterMaxGrDb: number;
  clipMaxGrDb: number;
  truePeakDb: number;
  lra: number;
}

export interface ExportProgress {
  phase: string;
  pct: number;
}

const TARGET_RATE = 48000;
const WAVEFORM_BUCKETS = 4096;
const SCOPE_SAMPLES = 2048;
const SPECTRUM_FFT = 8192;
/** Tracks longer than this are only solved in full while OUT is showing (a solve holds a copy of the track). */
const AUTO_SOLVE_MAX_SEC = 20 * 60;

/**
 * The settings that decide how a master sounds, as one string: two
 * consoles with the same key render the same file. Monitoring (REF, MON,
 * the click) and the gains the engine fills in are left out.
 */
function soundKey(p: ChainParams): string {
  const { bypass, limiterDelta, monitor, monitorGainDb, metronome, gridBpm, gridFirstBeatSec,
    stagingGainDb, outputGainDb, refOutputGainDb, ...sound } = p;
  void bypass; void limiterDelta; void monitor; void monitorGainDb; void metronome; void gridBpm;
  void gridFirstBeatSec; void stagingGainDb; void outputGainDb; void refOutputGainDb;
  return JSON.stringify(sound);
}

type MeterListener = (m: MeterFrame) => void;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserPre: AnalyserNode | null = null;
  private scopeL: AnalyserNode | null = null;
  private scopeR: AnalyserNode | null = null;
  private scopeBufL: Float32Array<ArrayBuffer> = new Float32Array(SCOPE_SAMPLES);
  private scopeBufR: Float32Array<ArrayBuffer> = new Float32Array(SCOPE_SAMPLES);
  private worker: Worker | null = null;
  private srcL: Float32Array | null = null;
  private srcR: Float32Array | null = null;
  private meterListeners = new Set<MeterListener>();
  // The analysis worker answers strictly in request order, so each reply
  // resolves the oldest waiter of its type (a single slot let a second
  // request steal the first one's reply).
  private analyzeWaiters: ((v: any) => void)[] = [];
  private tempoWaiters: ((v: any) => void)[] = [];
  private spectrogramWaiters: ((v: any) => void)[] = [];
  /** Bumps whenever the loaded source changes; stale results are dropped. */
  private gen = 0;
  private renderHandlers: {
    onProgress: (p: ExportProgress) => void;
    onDone: (result: RenderResult) => void;
    onError: (message: string) => void;
  } | null = null;

  // Preview-gain calibration state.
  private excerptL: Float32Array | null = null;
  private excerptR: Float32Array | null = null;
  private chainDeltaDb = 0;
  private calibSeq = 0;
  private calibTimer: ReturnType<typeof setTimeout> | null = null;
  private lastParams: ChainParams | null = null;
  private rendering = false;

  source: SourceInfo | null = null;
  waveform: WaveformPeaks | null = null;
  spectrumData: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  spectrumPreData: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private spectrumDb: Float32Array<ArrayBuffer> = new Float32Array(0);
  private spectrumPreDb: Float32Array<ArrayBuffer> = new Float32Array(0);
  /** Lazily computed source spectrogram (log-frequency, dB-mapped bytes). */
  spectrogram: { cols: number; bands: number; data: Uint8Array } | null = null;
  private spectrogramPending: Promise<any> | null = null;

  /** Detected tempo grid + sections for the loaded track. */
  tempo: TempoInfo | null = null;
  private tempoPending: Promise<TempoInfo | null> | null = null;

  /** Short-term loudness lane of the source (one point per stepSec). */
  loudnessLane: { stepSec: number; values: Float32Array } | null = null;

  onMeters(fn: MeterListener): () => void {
    this.meterListeners.add(fn);
    return () => this.meterListeners.delete(fn);
  }

  // One context for the life of the app. Callers that race here (a drop
  // firing two loads, a batch scan during the first load) must share the
  // same in-flight creation: two contexts mean two worklets posting meter
  // frames into the same listeners, and the UI flickers between them.
  private ctxPromise: Promise<AudioContext> | null = null;

  private ensureContext(): Promise<AudioContext> {
    if (!this.ctxPromise) {
      this.ctxPromise = this.createContext().catch((err) => {
        this.ctxPromise = null;
        throw err;
      });
    }
    return this.ctxPromise;
  }

  private async createContext(): Promise<AudioContext> {
    const ctx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('./audio/jmaster-processor.js');
    const node = new AudioWorkletNode(ctx, 'jmaster-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 2,
      outputChannelCount: [2, 2],
    });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = SPECTRUM_FFT;
    analyser.smoothingTimeConstant = 0.7;
    // The byte readout maps this range onto 0..255 (the default tops out at
    // −30 dB, which a loud master's bass sat pinned against).
    analyser.minDecibels = -100;
    analyser.maxDecibels = 0;
    node.connect(analyser, 0);
    analyser.connect(ctx.destination);
    // "Before" analyser fed by the worklet's loudness-matched source output.
    const analyserPre = ctx.createAnalyser();
    analyserPre.fftSize = SPECTRUM_FFT;
    analyserPre.smoothingTimeConstant = 0.7;
    analyserPre.minDecibels = -100;
    analyserPre.maxDecibels = 0;
    node.connect(analyserPre, 1);
    this.analyserPre = analyserPre;
    // Stereo tap for the vectorscope: L and R on their own analysers
    // (AnalyserNode alone would downmix to mono).
    const splitter = ctx.createChannelSplitter(2);
    node.connect(splitter, 0);
    const scopeL = ctx.createAnalyser();
    const scopeR = ctx.createAnalyser();
    scopeL.fftSize = SCOPE_SAMPLES;
    scopeR.fftSize = SCOPE_SAMPLES;
    splitter.connect(scopeL, 0);
    splitter.connect(scopeR, 1);
    this.scopeL = scopeL;
    this.scopeR = scopeR;
    this.spectrumData = new Uint8Array(analyser.frequencyBinCount);
    this.spectrumPreData = new Uint8Array(analyserPre.frequencyBinCount);
    this.spectrumDb = new Float32Array(analyser.frequencyBinCount);
    this.spectrumPreDb = new Float32Array(analyserPre.frequencyBinCount);
    node.port.onmessage = (e) => {
      if (e.data.type === 'meters') {
        for (const fn of this.meterListeners) fn(e.data as MeterFrame);
      } else if (e.data.type === 'ended') {
        for (const fn of this.meterListeners) {
          fn({
            playhead: this.srcL ? this.srcL.length : 0,
            playing: false, idle: false,
            momentary: -70, shortTerm: -70, integrated: -70,
            truePeakDb: -70, peakLDb: -70, peakRDb: -70,
            compGrDb: 0, limiterGrDb: 0, deharshGrDb: 0, clipGrDb: 0, correlation: 1, correlationLow: 1,
          });
        }
      }
    };
    this.ctx = ctx;
    this.node = node;
    this.analyser = analyser;
    return ctx;
  }

  /**
   * A worker that crashes (out of memory on a huge file, say) must still
   * answer everything it owed, or a load, a tempo or an export would wait
   * forever; the next request starts a fresh one.
   */
  private failMainWorker(): void {
    const w = this.worker;
    this.worker = null;
    w?.terminate();
    this.rendering = false;
    const h = this.renderHandlers;
    this.renderHandlers = null;
    h?.onError('THE AUDIO WORKER STOPPED');
    for (const f of this.analyzeWaiters.splice(0)) f({ type: 'analyzed', failed: true });
    for (const f of this.tempoWaiters.splice(0)) f({ type: 'tempo', failed: true, bpm: 0 });
    for (const f of this.spectrogramWaiters.splice(0)) f({ type: 'spectrogram', failed: true });
    for (const [, f] of this.mainPending) f({ type: 'render-error', message: 'THE AUDIO WORKER STOPPED' });
    this.mainPending.clear();
  }

  /** Requests to the main worker that answer by id (rate conversion). */
  private mainPending = new Map<number, (v: any) => void>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker('./audio/jmaster-render-worker.js');
    this.worker.onerror = () => this.failMainWorker();
    this.worker.onmessageerror = () => this.failMainWorker();
    this.worker.onmessage = (e) => {
      const d = e.data;
      if (d.reqId !== undefined && this.mainPending.has(d.reqId)) {
        const f = this.mainPending.get(d.reqId)!;
        this.mainPending.delete(d.reqId);
        f(d);
      } else if (d.type === 'analyzed') {
        this.analyzeWaiters.shift()?.(d);
      } else if (d.type === 'progress' && this.renderHandlers) {
        this.renderHandlers.onProgress({ phase: d.phase, pct: d.pct });
      } else if (d.type === 'done' && this.renderHandlers) {
        this.rendering = false;
        const h = this.renderHandlers;
        this.renderHandlers = null;
        h.onDone({ data: d.wav, ext: d.ext, mime: d.mime, stats: d.stats, report: d.report, extras: d.extras ?? [] });
        // A calibration that came due mid-render was skipped: take it now.
        if (this.lastParams) this.scheduleCalibration(this.lastParams);
      } else if (d.type === 'render-error' && this.renderHandlers) {
        this.rendering = false;
        const h = this.renderHandlers;
        this.renderHandlers = null;
        h.onError(String(d.message));
        if (this.lastParams) this.scheduleCalibration(this.lastParams);
      } else if (d.type === 'calibrated') {
        if (d.seq === this.calibSeq) {
          this.chainDeltaDb = Math.max(-8, Math.min(8, d.chainDeltaDb));
          if (this.lastParams) this.pushParams(this.lastParams);
        }
      } else if (d.type === 'spectrogram') {
        this.spectrogramWaiters.shift()?.(d);
      } else if (d.type === 'tempo') {
        this.tempoWaiters.shift()?.(d);
      }
    };
    return this.worker;
  }

  // Loads run strictly one at a time (they share the worklet, the analysis
  // resolver and every cache below). A load still queued when a newer one
  // arrives is skipped and resolves null.
  private loadQueue: Promise<unknown> = Promise.resolve();
  private loadSeq = 0;

  /** The newest load that has finished (landed, failed or been overtaken). */
  private settledSeq = 0;

  /**
   * Decodes, converts to 48 kHz, analyzes, and arms the worklet.
   * `isCurrent` lets the caller withdraw a load it has since moved on from
   * (a newer request whose own bytes never arrived): it is asked right
   * before the track would be installed, so the engine can never end up
   * holding a track the console isn't showing.
   */
  loadFile(
    data: ArrayBuffer, name: string, onPhase?: (phase: string) => void, isCurrent?: () => boolean,
  ): Promise<SourceInfo | null> {
    const seq = ++this.loadSeq;
    // A new track makes a repair of the old one pointless.
    this.cancelRepair();
    const run = this.loadQueue.then(() =>
      (seq === this.loadSeq && (isCurrent?.() ?? true) ? this.loadFileNow(data, name, seq, onPhase, isCurrent) : null));
    this.loadQueue = run.catch(() => undefined);
    // Registered before the caller's own wait, so it has run by the time
    // the caller hears back.
    const settle = () => { this.settledSeq = Math.max(this.settledSeq, seq); };
    run.then(settle, settle);
    return run;
  }

  /** A load is still decoding or analyzing. */
  private loadPending(): boolean {
    return this.settledSeq < this.loadSeq;
  }

  private async loadFileNow(
    data: ArrayBuffer,
    name: string,
    seq: number,
    onPhase?: (phase: string) => void,
    isCurrent?: () => boolean,
  ): Promise<SourceInfo | null> {
    const live = () => seq === this.loadSeq && (isCurrent?.() ?? true);
    onPhase?.('DECODING');
    await this.ensureContext();
    // Decode before touching any state, so an unreadable file leaves the
    // current track fully intact.
    const dec = await this.decodeToEngineRate(data, (from) => {
      if (live()) onPhase?.(`CONVERTING ${(from / 1000).toFixed(1)} → 48 KHZ`);
    });
    // A newer load arrived while this one decoded: it wins, and this one
    // must not swap the engine to a track the console will never show.
    if (!live()) return null;
    onPhase?.('ANALYSING LOUDNESS · PEAKS · STEREO');
    const take = await this.analyzeTake(dec.l, dec.r, {
      name,
      durationSec: dec.durationSec,
      sampleRate: TARGET_RATE,
      originalSampleRate: dec.nativeRate,
      originalBitDepth: dec.bitDepth,
      repairedSamples: dec.repaired,
      channels: dec.channels,
      converted: dec.converted,
    }, dec.clippedRuns);
    if (!live()) return null;
    this.original = null;
    this.repair = null;
    // A double or half-time reading belongs to the file it was made on.
    this.tempoScale = 1;
    return this.installTake(take);
  }

  /**
   * A file as 48 kHz stereo. It is decoded at its OWN rate (a context at
   * that rate decodes without converting) and brought to 48 kHz by the
   * app's filter, which is flat to 20 kHz; the browser's own conversion
   * rolled the top of a 44.1 kHz file off by 0.65 dB at 18 kHz. The two
   * channels convert side by side, one in each worker.
   */
  private async decodeToEngineRate(data: ArrayBuffer, onConvert?: (fromRate: number) => void): Promise<{
    l: Float32Array; r: Float32Array; durationSec: number; nativeRate: number; bitDepth: number | null;
    channels: number; repaired: number; converted: boolean; clippedRuns?: number;
  }> {
    const ctx = await this.ensureContext();
    const sniffed = sniffFormat(data);
    // AIFF is read here: the browser's decoder doesn't take it.
    let decoded: Pcm | null = pcmOfAiff(data);
    const native = sniffed.sampleRate;
    if (!decoded && native && native !== TARGET_RATE && native >= 8000 && native <= 384000 && typeof OfflineAudioContext !== 'undefined') {
      try {
        decoded = await new OfflineAudioContext(2, 1, native).decodeAudioData(data.slice(0));
      } catch {
        decoded = null;   // a rate this build can't open a context at: fall back below
      }
    }
    if (!decoded) decoded = await ctx.decodeAudioData(data.slice(0));
    const stereo = toStereo(decoded);
    const base = {
      durationSec: decoded.duration,
      nativeRate: native ?? decoded.sampleRate,
      bitDepth: sniffed.bitDepth,
      channels: decoded.numberOfChannels,
      repaired: stereo.repaired,
    };
    if (decoded.sampleRate === TARGET_RATE) return { ...stereo, ...base, converted: false };
    onConvert?.(decoded.sampleRate);
    const from = decoded.sampleRate;
    const mono = decoded.numberOfChannels === 1;
    const [a, b] = await Promise.all([
      this.resampleVia(this.ensureWorker(), this.mainPending, stereo.l, from, mono ? undefined : stereo.r),
      mono ? null : this.resampleVia(this.ensureBatchWorker(), this.batchPending, stereo.r, from),
    ]);
    const l = a.x;
    const r = b ? b.x : new Float32Array(l);
    return { l, r, ...base, converted: true, clippedRuns: mono ? undefined : a.clippedRuns };
  }

  private resampleVia(
    worker: Worker, pending: Map<number, any>, x: Float32Array, fromRate: number, pair?: Float32Array,
  ): Promise<{ x: Float32Array; clippedRuns?: number }> {
    const reqId = ++this.batchReqSeq;
    const cx = new Float32Array(x);
    const cp = pair ? new Float32Array(pair) : null;
    return new Promise((resolve, reject) => {
      const done = (d: any) => {
        if (d.type === 'resampled') resolve({ x: new Float32Array(d.x), clippedRuns: d.clippedRuns });
        else reject(new Error(String(d.message ?? 'conversion failed')));
      };
      // The two workers keep their waiters in differently shaped maps.
      if (pending === this.mainPending) this.mainPending.set(reqId, done);
      else this.batchPending.set(reqId, { resolve: done });
      worker.postMessage(
        { type: 'resample', reqId, x: cx.buffer, inRate: fromRate, outRate: TARGET_RATE, pair: cp?.buffer },
        cp ? [cx.buffer, cp.buffer] : [cx.buffer],
      );
    });
  }

  /** A stereo pair and its analysis (loudness, peaks, stereo, the waveform) from the worker. */
  private async analyzeTake(l: Float32Array, r: Float32Array, file: SourceFile, clippedRuns?: number): Promise<Take> {
    const al = new Float32Array(l);
    const ar = new Float32Array(r);
    const worker = this.ensureWorker();
    const analyzed: any = await new Promise((resolve) => {
      this.analyzeWaiters.push(resolve);
      worker.postMessage(
        { type: 'analyze', l: al.buffer, r: ar.buffer, fs: TARGET_RATE, buckets: WAVEFORM_BUCKETS, clippedRuns },
        [al.buffer, ar.buffer],
      );
    });
    if (analyzed.failed) throw new Error('analysis failed');
    return { l, r, file, analyzed };
  }

  /**
   * Makes an analyzed take the loaded source, all in one step: the worklet
   * plays it, its waveform and figures show, and every cache of the last
   * take goes. Nothing awaits in between, so nobody ever sees half of one
   * take and half of another.
   */
  private installTake(take: Take): SourceInfo {
    const { l, r, file, analyzed } = take;
    this.gen++;
    this.take = take;
    this.spectrogram = null;
    this.spectrogramPending = null;
    this.tempo = null;
    this.tempoRaw = null;
    this.tempoPending = null;
    this.sourceProfile = null;
    this.profilePending = null;
    this.clearProcessedPreview();
    this.solved = null;
    this.srcL = l;
    this.srcR = r;

    // Worklet gets its own copy (transferred).
    const wl = new Float32Array(l);
    const wr = new Float32Array(r);
    this.node!.port.postMessage({ type: 'load', l: wl.buffer, r: wr.buffer }, [wl.buffer, wr.buffer]);

    this.waveform = {
      levels: analyzed.levels.map((lv: any) => ({
        spb: lv.spb,
        mins: new Float32Array(lv.mins),
        maxs: new Float32Array(lv.maxs),
        rms: new Float32Array(lv.rms),
      })),
    };
    this.loudnessLane = analyzed.stSeries
      ? { stepSec: analyzed.stStepSec ?? 0.5, values: new Float32Array(analyzed.stSeries) }
      : null;

    // Loudest 6 s excerpt (by RMS buckets) for preview-gain calibration.
    {
      const coarse = this.waveform.levels[this.waveform.levels.length - 1];
      const rms = coarse.rms;
      const total = this.srcL.length;
      const excerptLen = Math.min(total, 6 * TARGET_RATE);
      const bucketsPerExcerpt = Math.max(1, Math.round((excerptLen / total) * rms.length));
      let best = 0, bestSum = -1, run = 0;
      for (let b = 0; b < rms.length; b++) {
        run += rms[b] * rms[b];
        if (b >= bucketsPerExcerpt) run -= rms[b - bucketsPerExcerpt] * rms[b - bucketsPerExcerpt];
        if (b >= bucketsPerExcerpt - 1 && run > bestSum) {
          bestSum = run;
          best = b - bucketsPerExcerpt + 1;
        }
      }
      const startSample = Math.min(total - excerptLen, Math.floor((best / rms.length) * total));
      this.excerptL = this.srcL.slice(startSample, startSample + excerptLen);
      this.excerptR = this.srcR.slice(startSample, startSample + excerptLen);
      this.chainDeltaDb = 0;
      // A calibration still out for the previous track must not land here.
      this.calibSeq++;
      if (this.calibTimer) { clearTimeout(this.calibTimer); this.calibTimer = null; }
    }
    this.source = {
      ...file,
      lufs: analyzed.lufs,
      lra: analyzed.lra ?? 0,
      maxMomentary: analyzed.maxMomentary ?? -70,
      maxShortTerm: analyzed.maxShortTerm ?? -70,
      truePeakDb: analyzed.truePeakDb,
      samplePeakDb: analyzed.samplePeakDb,
      balanceOffsetDb: analyzed.balanceOffsetDb ?? 0,
      diagnostics: analyzed.diagnostics ?? {
        sideBassRelDb: -60, harshRelDb: -60, corrMean: 1, corrWorst: 1, deadChannel: null,
      },
      checks: analyzed.checks ?? NO_CHECKS,
    };

    // A previous track's preview source is stale now; release it in the
    // worker. Re-priming happens lazily on the first preview request.
    if (this.primedSource) {
      this.batchWorker?.postMessage({ type: 'unprime' });
      this.primedSource = null;
    }
    return this.source;
  }

  /** Computes staging/output gains and pushes the full param set down. */
  updateParams(p: ChainParams): void {
    if (!this.node) return;
    this.lastParams = p;
    this.pushParams(p);
    this.scheduleCalibration(p);
    this.scheduleSolve(p);
  }

  /**
   * What the last full solve found, and for which settings. While the
   * console still matches them, playback runs at exactly the gain the
   * export will use, through the same limiter: what you hear is the file.
   * After a change, until the next solve lands, the gain is the quick
   * estimate plus the limiter's share as last measured.
   */
  private solved: { key: string; estimate: MasterEstimate; quickGainDb: number } | null = null;
  /** Where an export of the console as it stands would land (null until solved, or after a change). */
  masterEstimate: MasterEstimate | null = null;

  /** The gain into the output stages from the chain's measured loudness change alone. */
  private quickGainDb(p: ChainParams): number {
    return p.targetLufs - NOMINAL_LUFS - this.chainDeltaDb;
  }

  private pushParams(p: ChainParams): void {
    if (!this.node) return;
    const src = this.source;
    const unmeasured = !!src && src.lufs <= -70;
    let outputGainDb = this.quickGainDb(p);
    const sv = this.solved;
    if (sv && sv.estimate.measured) {
      outputGainDb = sv.key === soundKey(p)
        ? sv.estimate.appliedGainDb
        // What the limiter cost in loudness last time carries over as the
        // best guess, so the level doesn't lurch between solves.
        : outputGainDb + Math.max(0, Math.min(12, sv.estimate.appliedGainDb - sv.quickGainDb));
    }
    const params: ChainParams = {
      ...p,
      stagingGainDb: src ? stagingGainDbFor(src.lufs) : 0,
      // A source with no measurable loudness plays at unity, as it exports.
      outputGainDb: unmeasured ? 0 : outputGainDb,
      refOutputGainDb: unmeasured ? 0 : p.targetLufs - NOMINAL_LUFS,
      songLengthSec: src ? src.durationSec : 0,
    };
    this.node.port.postMessage({ type: 'params', params });
  }

  /** Debounced: measures the chain's loudness delta on the loud excerpt. */
  private scheduleCalibration(p: ChainParams): void {
    if (!this.excerptL || !this.excerptR || !this.source) return;
    if (this.calibTimer) clearTimeout(this.calibTimer);
    this.calibTimer = setTimeout(() => {
      if (this.rendering || !this.excerptL || !this.excerptR || !this.source) return;
      const worker = this.ensureWorker();
      const seq = ++this.calibSeq;
      const l = new Float32Array(this.excerptL);
      const r = new Float32Array(this.excerptR);
      worker.postMessage(
        { type: 'calibrate', seq, l: l.buffer, r: r.buffer, fs: TARGET_RATE, params: p, sourceLufs: this.source.lufs },
        [l.buffer, r.buffer],
      );
    }, 350);
  }

  async play(): Promise<void> {
    if (!this.ctx || !this.node) return;
    await this.ctx.resume();
    this.node.port.postMessage({ type: 'play' });
  }

  pause(): void { this.node?.port.postMessage({ type: 'pause' }); }
  stop(): void { this.node?.port.postMessage({ type: 'stop' }); }

  seekSec(sec: number): void {
    this.node?.port.postMessage({ type: 'seek', sample: sec * TARGET_RATE });
  }

  /**
   * The beats a drifting track's CLICK follows (seconds), with the index of
   * a downbeat for the accent; null returns the CLICK to the fixed grid.
   */
  setClickBeats(beats: number[] | null, downbeat: number): void {
    this.node?.port.postMessage({ type: 'beats', beats, downbeat });
  }

  /** Loops playback over [startSec, endSec); null clears the loop. */
  setLoop(startSec: number | null, endSec: number | null): void {
    this.node?.port.postMessage(
      startSec === null || endSec === null
        ? { type: 'loop', start: null, end: null }
        : { type: 'loop', start: startSec * TARGET_RATE, end: endSec * TARGET_RATE },
    );
  }

  /** Fills spectrumData with the current byte frequency data; returns it. */
  readSpectrum(): Uint8Array {
    if (this.analyser) this.analyser.getByteFrequencyData(this.spectrumData);
    return this.spectrumData;
  }

  /** Same for the pre-processing (source) analyser. */
  readSpectrumPre(): Uint8Array {
    if (this.analyserPre) this.analyserPre.getByteFrequencyData(this.spectrumPreData);
    return this.spectrumPreData;
  }

  /** The output's spectrum in dBFS per bin (bin k is k × sampleRate / fftSize Hz). */
  readSpectrumDb(): Float32Array {
    if (this.analyser) this.analyser.getFloatFrequencyData(this.spectrumDb);
    return this.spectrumDb;
  }

  /** The loudness-matched source's, the same way. */
  readSpectrumPreDb(): Float32Array {
    if (this.analyserPre) this.analyserPre.getFloatFrequencyData(this.spectrumPreDb);
    return this.spectrumPreDb;
  }

  /** The last SCOPE_SAMPLES of the output, per channel (vectorscope). */
  readScope(): { l: Float32Array; r: Float32Array } | null {
    if (!this.scopeL || !this.scopeR) return null;
    this.scopeL.getFloatTimeDomainData(this.scopeBufL);
    this.scopeR.getFloatTimeDomainData(this.scopeBufR);
    return { l: this.scopeBufL, r: this.scopeBufR };
  }

  /** Spectral profile of the loaded source (cached). */
  sourceProfile: { bands: Float32Array; lufs: number; sideRatioDb: number } | null = null;

  /** Spectral profile of arbitrary buffers via the batch worker. */
  async profileBuffers(l: Float32Array, r: Float32Array): Promise<{
    bands: Float32Array; lufs: number; sideRatioDb: number;
  }> {
    const worker = this.ensureBatchWorker();
    const reqId = ++this.batchReqSeq;
    const cl = new Float32Array(l);
    const cr = new Float32Array(r);
    const d: any = await new Promise((resolve) => {
      this.batchPending.set(reqId, { resolve });
      worker.postMessage(
        { type: 'profile', reqId, l: cl.buffer, r: cr.buffer, fs: TARGET_RATE },
        [cl.buffer, cr.buffer],
      );
    });
    if (d.type === 'render-error') throw new Error(d.message);
    return { bands: new Float32Array(d.bands), lufs: d.lufs, sideRatioDb: d.sideRatioDb };
  }

  private profilePending: Promise<{ bands: Float32Array; lufs: number; sideRatioDb: number } | null> | null = null;

  /** Profile of the loaded source (computed once, however many ask at once). */
  requestSourceProfile(): Promise<{ bands: Float32Array; lufs: number; sideRatioDb: number } | null> {
    if (this.sourceProfile) return Promise.resolve(this.sourceProfile);
    if (this.profilePending) return this.profilePending;
    if (!this.srcL || !this.srcR) return Promise.resolve(null);
    const gen = this.gen;
    const pending = this.profileBuffers(this.srcL, this.srcR).then((profile) => {
      if (gen !== this.gen) return null;
      this.sourceProfile = profile;
      this.profilePending = null;
      return profile;
    }, (err) => {
      if (gen === this.gen) this.profilePending = null;
      throw err;
    });
    this.profilePending = pending;
    return pending;
  }

  /**
   * Detects the track's tempo grid + sections (async, cached per track).
   * Resolves null if the track changed while the analysis was running.
   */
  requestTempo(): Promise<TempoInfo | null> {
    if (this.tempo) return Promise.resolve(this.tempo);
    if (this.tempoPending) return this.tempoPending;
    if (!this.srcL || !this.srcR) return Promise.resolve(null);
    const worker = this.ensureWorker();
    const gen = this.gen;
    const l = new Float32Array(this.srcL);
    const r = new Float32Array(this.srcR);
    const pending = new Promise<TempoInfo | null>((resolve) => {
      this.tempoWaiters.push((d) => {
        // The analysis itself failed (the worker stopped): nothing was
        // measured, so nothing is kept, and the next request tries again.
        if (d.failed) {
          if (gen === this.gen) this.tempoPending = null;
          resolve(null);
          return;
        }
        // bpm 0: measured, and there is no pulse (the sections still hold).
        const t: TempoInfo = {
          bpm: d.bpm > 0 ? d.bpm : 0,
          firstBeatSec: d.firstBeatSec ?? 0,
          firstBarSec: d.firstBarSec ?? d.firstBeatSec ?? 0,
          confidence: d.bpm > 0 ? d.confidence : 0,
          sections: d.sections ?? [],
          curve: d.curve ?? null,
          beats: d.beats ?? [],
          downbeat: d.downbeat ?? 0,
          drift: d.drift ?? null,
        };
        if (gen !== this.gen) { resolve(null); return; }
        this.tempoRaw = t;
        this.tempo = atScale(t, this.tempoScale);
        this.tempoPending = null;
        resolve(this.tempo);
      });
      worker.postMessage(
        { type: 'tempo', l: l.buffer, r: r.buffer, fs: TARGET_RATE },
        [l.buffer, r.buffer],
      );
    });
    this.tempoPending = pending;
    return pending;
  }

  /** The tempo as analysed, before any double or half-time reading of it. */
  private tempoRaw: TempoInfo | null = null;
  /** How the analysed tempo is read: 1, or a power of two either way. */
  tempoScale = 1;

  /**
   * Reads the tempo at another octave (a 174 BPM break and its 87 BPM
   * half-time are the same music): the grid, the click, the drift figures
   * and a repair's target all move together. Returns the tempo as it now
   * reads, or null while there is none to re-read.
   */
  setTempoScale(scale: number): TempoInfo | null {
    if (![0.25, 0.5, 1, 2, 4].includes(scale)) return null;
    const factor = scale / this.tempoScale;
    this.tempoScale = scale;
    if (factor === 1) return this.tempo;
    if (this.original) this.original = { ...this.original, tempo: atScale(this.original.tempoRaw, scale) };
    if (this.repair) this.repair = { ...this.repair, targetBpm: this.repair.targetBpm * factor };
    if (!this.tempoRaw) return null;
    this.tempo = atScale(this.tempoRaw, scale);
    return this.tempo;
  }

  rescaleTempo(factor: 2 | 0.5): TempoInfo | null {
    if (!this.tempoRaw || !(this.tempoRaw.bpm > 0)) return null;
    return this.setTempoScale(this.tempoScale * factor);
  }

  // ── drift repair ────────────────────────────────────────────────────
  /** The take that is the source now. */
  private take: Take | null = null;
  /** The file as decoded (with its analysis and tempo), kept while a drift repair stands in for it. */
  private original: { take: Take; tempo: TempoInfo; tempoRaw: TempoInfo } | null = null;
  /** The repair in place: its target, and the warp for mapping times between the two. */
  repair: { targetBpm: number; plan: RepairPlan; originalDurationSec: number } | null = null;

  /** The worker stretching a repair, and how to settle its promise early. */
  private repairWorker: Worker | null = null;
  private repairSettle: ((d: any) => void) | null = null;

  /**
   * Stretches the track onto a steady `targetBpm` and puts the result in
   * its place; the file as decoded stays for revertRepair. A repair always
   * starts from the file, so a second one replaces the first. The stretch,
   * and the analysis of what it made, run in a worker of their own (a load
   * never waits behind it, and a load cancels it); the swap is one step.
   * Resolves null when cancelled or when the track changed meanwhile.
   */
  async repairDrift(targetBpm: number, onProgress?: (pct: number) => void): Promise<TakeSwap | null> {
    if (this.loadPending()) return null;
    const gen = this.gen;
    let base = this.original;
    if (!base) {
      const tempo = await this.requestTempo();
      if (gen !== this.gen || !tempo || !this.take) return null;
      base = { take: this.take, tempo, tempoRaw: this.tempoRaw ?? tempo };
    }
    const curve = base.tempo.curve;
    if (!curve) throw new Error('no tempo curve to repair from');
    const plan = planRepair(curve, targetBpm, TARGET_RATE, base.take.l.length);
    if (Math.max(plan.maxStretch, -plan.minStretch) > REPAIR_MAX_STRETCH) {
      throw new Error(`more than ${Math.round(REPAIR_MAX_STRETCH * 100)}% from the song's own tempo`);
    }
    this.cancelRepair();
    const worker = new Worker('./audio/jmaster-render-worker.js');
    this.repairWorker = worker;
    const from = base;
    const d: any = await new Promise((resolve) => {
      const settle = (v: any) => {
        if (this.repairWorker === worker) {
          this.repairWorker = null;
          this.repairSettle = null;
        }
        worker.terminate();
        resolve(v);
      };
      this.repairSettle = settle;
      worker.onerror = () => settle({ failed: true, message: 'THE AUDIO WORKER STOPPED' });
      worker.onmessageerror = () => settle({ failed: true, message: 'THE AUDIO WORKER STOPPED' });
      worker.onmessage = (e) => {
        if (e.data.type === 'repair-progress') onProgress?.(e.data.pct);
        else if (e.data.type === 'repaired') settle(e.data);
      };
      const l = new Float32Array(from.take.l);
      const r = new Float32Array(from.take.r);
      worker.postMessage(
        { type: 'repair', l: l.buffer, r: r.buffer, fs: TARGET_RATE, curve, targetBpm },
        [l.buffer, r.buffer],
      );
    });
    if (d.cancelled) return null;
    if (d.failed) throw new Error(String(d.message ?? 'repair failed'));
    // A load or another take got in while it stretched: this repair is of
    // something no longer here.
    if (gen !== this.gen || this.loadPending()) return null;
    const outL = new Float32Array(d.l);
    const outR = new Float32Array(d.r);
    const lastPlan = this.repair?.plan ?? null;
    this.original = from;
    this.repair = { targetBpm, plan, originalDurationSec: from.take.file.durationSec };
    const info = this.installTake({
      l: outL, r: outR,
      file: { ...from.take.file, durationSec: outL.length / TARGET_RATE },
      analyzed: d.analyzed,
    });
    return { info, map: (sec) => repairedSec(plan, originalSec(lastPlan, sec)) };
  }

  /** Stops a repair's stretch; its promise resolves null. False when none was running. */
  cancelRepair(): boolean {
    const settle = this.repairSettle;
    if (!settle) return false;
    settle({ cancelled: true });
    return true;
  }

  /** What a repair starts from: the file's own tempo analysis and length (null until measured). */
  repairBase(): { tempo: TempoInfo; durationSec: number } | null {
    if (this.original) return { tempo: this.original.tempo, durationSec: this.original.take.file.durationSec };
    if (this.tempo && this.source) return { tempo: this.tempo, durationSec: this.source.durationSec };
    return null;
  }

  /**
   * Puts the file back in place of its drift repair, at once: its analysis
   * and tempo were kept, so nothing is measured again.
   */
  revertRepair(): TakeSwap | null {
    const o = this.original;
    if (!o || this.loadPending()) return null;
    this.cancelRepair();
    const lastPlan = this.repair?.plan ?? null;
    this.original = null;
    this.repair = null;
    const info = this.installTake(o.take);
    this.tempo = o.tempo;
    this.tempoRaw = o.tempoRaw;
    return { info, map: (sec) => originalSec(lastPlan, sec) };
  }

  /** A moment of the file → the same moment of its repair (identity without one). */
  toRepairedSec(sec: number): number {
    return repairedSec(this.repair?.plan ?? null, sec);
  }

  /** A moment of the repair → the same moment of the file (identity without one). */
  toOriginalSec(sec: number): number {
    return originalSec(this.repair?.plan ?? null, sec);
  }

  /** The repaired track as a 32-bit float WAV (a stretch can peak past full scale); null without a repair. */
  repairedWav(): ArrayBuffer | null {
    if (!this.repair || !this.srcL || !this.srcR) return null;
    return encodeWavFloat(this.srcL, this.srcR, TARGET_RATE);
  }

  /** The loaded track as it plays (its repair, when one stands in), for a batch or album render of it. */
  currentAudio(): { l: Float32Array; r: Float32Array; durationSec: number; lufs: number } | null {
    if (!this.srcL || !this.srcR || !this.source) return null;
    return { l: this.srcL, r: this.srcR, durationSec: this.source.durationSec, lufs: this.source.lufs };
  }

  /** Computes (once per track) and returns the source spectrogram. */
  requestSpectrogram(): Promise<{ cols: number; bands: number; data: Uint8Array } | null> {
    if (this.spectrogram) return Promise.resolve(this.spectrogram);
    if (this.spectrogramPending) return this.spectrogramPending;
    if (!this.srcL || !this.srcR) return Promise.resolve(null);
    const worker = this.ensureWorker();
    const gen = this.gen;
    const l = new Float32Array(this.srcL);
    const r = new Float32Array(this.srcR);
    const pending = new Promise<{ cols: number; bands: number; data: Uint8Array } | null>((resolve) => {
      this.spectrogramWaiters.push((d) => {
        if (d.failed) { this.spectrogramPending = null; resolve(null); return; }
        if (gen !== this.gen) { resolve(null); return; }
        this.spectrogram = { cols: d.cols, bands: d.bands, data: new Uint8Array(d.data) };
        this.spectrogramPending = null;
        resolve(this.spectrogram);
      });
      worker.postMessage(
        { type: 'spectrogram', l: l.buffer, r: r.buffer, fs: TARGET_RATE },
        [l.buffer, r.buffer],
      );
    });
    this.spectrogramPending = pending;
    return pending;
  }

  get sampleRate(): number { return TARGET_RATE; }
  get lengthSamples(): number { return this.srcL ? this.srcL.length : 0; }

  startExport(
    params: ChainParams,
    encode: EncodeOptions,
    onProgress: (p: ExportProgress) => void,
    onDone: (result: RenderResult) => void,
    onError: (message: string) => void,
    extras: EncodeOptions[] = [],
  ): void {
    if (!this.srcL || !this.srcR || !this.source) { onError('NO TRACK LOADED'); return; }
    // A second render would take over the first one's answer.
    if (this.renderHandlers) { onError('A RENDER IS ALREADY RUNNING'); return; }
    const worker = this.ensureWorker();
    this.renderHandlers = { onProgress, onDone, onError };
    this.rendering = true;
    const l = new Float32Array(this.srcL);
    const r = new Float32Array(this.srcR);
    const fullParams: ChainParams = {
      ...params,
      songLengthSec: this.source.durationSec,
    };
    worker.postMessage(
      {
        type: 'render',
        l: l.buffer,
        r: r.buffer,
        fs: TARGET_RATE,
        params: fullParams,
        sourceLufs: this.source.lufs,
        encode,
        extras,
      },
      [l.buffer, r.buffer],
    );
  }

  // ── batch processing ────────────────────────────────────────────────
  // A dedicated worker so album batches never fight the preview worker.
  private batchWorker: Worker | null = null;
  private batchPending = new Map<number, {
    resolve: (v: any) => void;
    onProgress?: (p: ExportProgress) => void;
  }>();
  private batchReqSeq = 0;

  private failBatchWorker(): void {
    const w = this.batchWorker;
    this.batchWorker = null;
    w?.terminate();
    this.primedSource = null;
    for (const [reqId, entry] of this.batchPending) {
      entry.resolve({ type: 'render-error', reqId, message: 'THE AUDIO WORKER STOPPED' });
    }
    this.batchPending.clear();
  }

  private ensureBatchWorker(): Worker {
    if (this.batchWorker) return this.batchWorker;
    this.batchWorker = new Worker('./audio/jmaster-render-worker.js');
    this.batchWorker.onerror = () => this.failBatchWorker();
    this.batchWorker.onmessageerror = () => this.failBatchWorker();
    this.batchWorker.onmessage = (e) => {
      const d = e.data;
      const entry = d.reqId !== undefined ? this.batchPending.get(d.reqId) : undefined;
      if (!entry) return;
      if (d.type === 'progress') {
        entry.onProgress?.({ phase: d.phase, pct: d.pct });
      } else if (d.type === 'analyzed' || d.type === 'done' || d.type === 'previewed' || d.type === 'render-error' || d.type === 'profiled' || d.type === 'resampled') {
        this.batchPending.delete(d.reqId);
        entry.resolve(d);
      }
    };
    return this.batchWorker;
  }

  /** Decodes bytes to 48 kHz stereo float (converted like a loaded track) without touching the loaded one. */
  async decodeOnly(data: ArrayBuffer): Promise<{ l: Float32Array; r: Float32Array; durationSec: number; clippedRuns?: number }> {
    const d = await this.decodeToEngineRate(data);
    return { l: d.l, r: d.r, durationSec: d.durationSec, clippedRuns: d.clippedRuns };
  }

  /** Full analysis (LUFS, diagnostics, balance, the source checks) of buffers via the batch worker. */
  async analyzeBuffers(l: Float32Array, r: Float32Array, clippedRuns?: number): Promise<{
    lufs: number;
    truePeakDb: number;
    balanceOffsetDb: number;
    diagnostics: SourceDiagnostics;
    checks: SourceChecks;
  }> {
    const worker = this.ensureBatchWorker();
    const reqId = ++this.batchReqSeq;
    const cl = new Float32Array(l);
    const cr = new Float32Array(r);
    const res: any = await new Promise((resolve) => {
      this.batchPending.set(reqId, { resolve });
      worker.postMessage(
        { type: 'analyze', reqId, l: cl.buffer, r: cr.buffer, fs: TARGET_RATE, buckets: 64, clippedRuns },
        [cl.buffer, cr.buffer],
      );
    });
    if (res.type === 'render-error' || res.failed) throw new Error(res.message ?? 'analysis failed');
    return {
      lufs: res.lufs,
      truePeakDb: res.truePeakDb,
      balanceOffsetDb: res.balanceOffsetDb ?? 0,
      diagnostics: res.diagnostics ?? { sideBassRelDb: -60, harshRelDb: -60, corrMean: 1, corrWorst: 1, deadChannel: null },
      checks: res.checks ?? NO_CHECKS,
    };
  }

  /**
   * The true peak of an encoded file once a player decodes it. Lossy
   * codecs don't keep the waveform, only how it sounds, and their output
   * can stand above the ceiling the master was limited to.
   */
  async measureEncodedPeak(data: ArrayBuffer): Promise<number> {
    const d = await this.decodeToEngineRate(data);
    return (await this.analyzeBuffers(d.l, d.r)).truePeakDb;
  }

  /** Integrated LUFS of arbitrary buffers via the batch worker. */
  async measureLufs(l: Float32Array, r: Float32Array): Promise<number> {
    return (await this.analyzeBuffers(l, r)).lufs;
  }

  // ── the solve: the master as it would export, kept current ──────────
  // Every settled change to the console is rendered in full in the
  // background (debounced, in the batch worker, on a copy of the track it
  // keeps). From it come the OUT waveform and loudness lane, where an
  // export would land (and whether the target can be reached at all), and
  // the gain the live preview plays at: the export's own.
  processedPreview: {
    spb: number; mins: Float32Array; maxs: Float32Array; rms: Float32Array;
    lane: { stepSec: number; values: Float32Array };
    integrated: number;
  } | null = null;
  /** A solve is due or running: what is shown is for older settings. */
  previewPending = false;
  /** Notified whenever previewPending, processedPreview or masterEstimate changes (UI mirror). */
  onPreviewUpdate: (() => void) | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped per request and by every clear: only the latest reply lands. */
  private previewSeq = 0;
  /** A solve is with the worker. */
  private solveInFlight = false;
  /** Settings that arrived while one was: solved next. */
  private solveQueued: { params: ChainParams; seq: number } | null = null;
  /** OUT is showing: tracks too long to solve unasked are solved while it is. */
  private previewWanted = false;
  /** Which source the batch worker holds a primed preview copy of. */
  private primedSource: SourceInfo | null = null;

  /** Whether the console is solved in the background for this track. */
  private solveEnabled(): boolean {
    const src = this.source;
    return !!src && (this.previewWanted || src.durationSec <= AUTO_SOLVE_MAX_SEC);
  }

  private scheduleSolve(params: ChainParams, delayMs = 900): void {
    if (!this.srcL || !this.srcR || !this.source || !this.solveEnabled()) return;
    // Already solved for exactly these settings (a monitor switch, say).
    if (this.solved?.key === soundKey(params) && this.processedPreview && !this.previewPending) return;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    // The seq moves now, at the request: a reply for older settings that
    // lands meanwhile is stale from this moment, not from when this one
    // is finally sent.
    const seq = ++this.previewSeq;
    this.masterEstimate = null;
    this.previewPending = true;
    this.onPreviewUpdate?.();
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      if (seq !== this.previewSeq) return;
      // One at a time: the newest settings wait for the worker, and any
      // older ones waiting are simply replaced.
      if (this.solveInFlight) { this.solveQueued = { params, seq }; return; }
      void this.runSolve(params, seq);
    }, delayMs);
  }

  private async runSolve(params: ChainParams, seq: number): Promise<void> {
    if (!this.srcL || !this.srcR || !this.source) return;
    const source = this.source;
    const worker = this.ensureBatchWorker();
    this.solveInFlight = true;
    if (this.primedSource !== source) {
      const pl = new Float32Array(this.srcL);
      const pr = new Float32Array(this.srcR);
      worker.postMessage(
        { type: 'prime', l: pl.buffer, r: pr.buffer, fs: TARGET_RATE, sourceLufs: source.lufs },
        [pl.buffer, pr.buffer],
      );
      this.primedSource = source;
    }
    const reqId = ++this.batchReqSeq;
    const fullParams: ChainParams = { ...params, songLengthSec: source.durationSec };
    const quick = this.quickGainDb(params);
    const d: any = await new Promise((resolve) => {
      this.batchPending.set(reqId, { resolve });
      worker.postMessage({ type: 'preview', reqId, params: fullParams });
    });
    this.solveInFlight = false;
    // Settings changed while it rendered: theirs is the solve that counts.
    const queued = this.solveQueued;
    this.solveQueued = null;
    if (queued && this.source === source) {
      void this.runSolve(queued.params, queued.seq);
      return;
    }
    // A newer request (still in its debounce), a new track or a clear: not ours to show.
    if (seq !== this.previewSeq || this.source !== source) return;
    if (d.type === 'previewed' && !d.unprimed) {
      this.processedPreview = {
        spb: d.spb,
        mins: new Float32Array(d.mins),
        maxs: new Float32Array(d.maxs),
        rms: new Float32Array(d.rms),
        lane: { stepSec: d.stStepSec ?? 0.5, values: new Float32Array(d.stSeries) },
        integrated: d.integrated,
      };
      const estimate: MasterEstimate = {
        lufs: d.integrated, reached: d.reached !== false, measured: d.measured !== false,
        appliedGainDb: d.appliedGainDb ?? 0, limiterMaxGrDb: d.limiterMaxGrDb ?? 0, clipMaxGrDb: d.clipMaxGrDb ?? 0,
        truePeakDb: d.truePeakDb ?? -70, lra: d.lra ?? 0,
      };
      this.solved = { key: soundKey(params), estimate, quickGainDb: quick };
      this.masterEstimate = estimate;
      // Playback takes the solved gain (when the console still matches).
      if (this.lastParams) this.pushParams(this.lastParams);
    }
    this.previewPending = false;
    this.onPreviewUpdate?.();
  }

  /** OUT switched on: make sure there is a master to show. */
  scheduleProcessedPreview(params: ChainParams, delayMs = 2000): void {
    this.previewWanted = true;
    this.scheduleSolve(params, delayMs);
  }

  clearProcessedPreview(): void {
    if (this.previewTimer) { clearTimeout(this.previewTimer); this.previewTimer = null; }
    this.previewSeq++;
    this.solveQueued = null;
    this.processedPreview = null;
    this.masterEstimate = null;
    this.previewPending = false;
    this.onPreviewUpdate?.();
  }

  /**
   * OUT is off. A track short enough to be solved unasked keeps its master
   * (playback still runs on it); a longer one gives the worker's copy of
   * the track back.
   */
  releasePreview(): void {
    this.previewWanted = false;
    if (this.solveEnabled()) return;
    this.clearProcessedPreview();
    this.solved = null;
    if (this.lastParams) this.pushParams(this.lastParams);
    if (this.primedSource) {
      this.batchWorker?.postMessage({ type: 'unprime' });
      this.primedSource = null;
    }
  }

  // ── codec audition: loop the same excerpt as codec vs lossless ──────
  private auditionNodes: {
    srcA: AudioBufferSourceNode; srcB: AudioBufferSourceNode;
    gainA: GainNode; gainB: GainNode;
  } | null = null;

  /** The loudest-section excerpt used for calibration (copies). */
  getExcerpt(): { l: Float32Array; r: Float32Array } | null {
    if (!this.excerptL || !this.excerptR) return null;
    return { l: new Float32Array(this.excerptL), r: new Float32Array(this.excerptR) };
  }

  async auditionStart(master: AudioBuffer, codec: AudioBuffer): Promise<void> {
    const ctx = await this.ensureContext();
    this.auditionStop();
    this.pause();
    const mk = (buf: AudioBuffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = ctx.createGain();
      src.connect(gain);
      gain.connect(ctx.destination);
      return { src, gain };
    };
    const a = mk(master);
    const b = mk(codec);
    a.gain.gain.value = 0;
    b.gain.gain.value = 1; // start on the codec — that's the question being asked
    const t = ctx.currentTime + 0.05;
    a.src.start(t);
    b.src.start(t);
    this.auditionNodes = { srcA: a.src, srcB: b.src, gainA: a.gain, gainB: b.gain };
    await ctx.resume();
  }

  auditionSetMode(mode: 'codec' | 'master'): void {
    if (!this.auditionNodes || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.auditionNodes.gainA.gain.setTargetAtTime(mode === 'master' ? 1 : 0, t, 0.01);
    this.auditionNodes.gainB.gain.setTargetAtTime(mode === 'codec' ? 1 : 0, t, 0.01);
  }

  auditionStop(): void {
    if (!this.auditionNodes) return;
    try {
      this.auditionNodes.srcA.stop();
      this.auditionNodes.srcB.stop();
    } catch { /* already stopped */ }
    this.auditionNodes.gainA.disconnect();
    this.auditionNodes.gainB.disconnect();
    this.auditionNodes = null;
  }

  /** Decodes arbitrary encoded bytes into an AudioBuffer at engine rate. */
  async decodeToBuffer(data: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = await this.ensureContext();
    return ctx.decodeAudioData(data.slice(0));
  }

  /** Full mastering render of arbitrary buffers via the batch worker. */
  async renderBuffers(
    l: Float32Array,
    r: Float32Array,
    params: ChainParams,
    sourceLufs: number,
    durationSec: number,
    encode: EncodeOptions,
    onProgress?: (p: ExportProgress) => void,
  ): Promise<RenderResult> {
    const worker = this.ensureBatchWorker();
    const reqId = ++this.batchReqSeq;
    const cl = new Float32Array(l);
    const cr = new Float32Array(r);
    const fullParams: ChainParams = { ...params, songLengthSec: durationSec };
    const d: any = await new Promise((resolve) => {
      this.batchPending.set(reqId, { resolve, onProgress });
      worker.postMessage(
        {
          type: 'render', reqId,
          l: cl.buffer, r: cr.buffer, fs: TARGET_RATE,
          params: fullParams, sourceLufs, encode,
        },
        [cl.buffer, cr.buffer],
      );
    });
    if (d.type === 'render-error') throw new Error(d.message);
    return { data: d.wav, ext: d.ext, mime: d.mime, stats: d.stats, report: d.report };
  }
}

/**
 * The decoded audio as a stereo pair (copies). Mono plays on both sides;
 * surround folds down with the standard speaker downmix (Web Audio's,
 * after ITU-R BS.775): centre and surrounds at −3 dB, LFE left out. A
 * fold-down that sums past full scale is brought back to it, so the
 * untouched REF can't clip. Unknown layouts keep their first two channels.
 */
/** What the decode path needs of decoded audio (an AudioBuffer is one). */
type Pcm = Pick<AudioBuffer, 'numberOfChannels' | 'length' | 'sampleRate' | 'duration' | 'getChannelData'>;

function pcmOfAiff(data: ArrayBuffer): Pcm | null {
  const a = decodeAiff(data);
  if (!a) return null;
  const length = a.channels[0].length;
  return {
    numberOfChannels: a.channels.length,
    length,
    sampleRate: a.sampleRate,
    duration: length / a.sampleRate,
    getChannelData: (i: number) => a.channels[i] as Float32Array<ArrayBuffer>,
  };
}

export function toStereo(buf: Pcm): { l: Float32Array; r: Float32Array; repaired: number } {
  const { l, r } = foldDown(buf);
  // A float file can carry NaN or ∞ samples; one would silence the whole
  // chain from there on, so each becomes silence (and is counted).
  let repaired = 0;
  for (let i = 0; i < l.length; i++) {
    if (!Number.isFinite(l[i])) { l[i] = 0; repaired++; }
    if (!Number.isFinite(r[i])) { r[i] = 0; repaired++; }
  }
  // A fold-down that sums past full scale comes back to it.
  if (buf.numberOfChannels > 2) {
    let peak = 0;
    for (let i = 0; i < l.length; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
    if (peak > 1) {
      const k = 1 / peak;
      for (let i = 0; i < l.length; i++) { l[i] *= k; r[i] *= k; }
    }
  }
  return { l, r, repaired };
}

function foldDown(buf: Pcm): { l: Float32Array; r: Float32Array } {
  const ch = buf.numberOfChannels;
  const at = (i: number) => buf.getChannelData(i);
  if (ch === 1) return { l: new Float32Array(at(0)), r: new Float32Array(at(0)) };
  // Channel order per layout: which feed the left and right (C feeds both).
  const g = Math.SQRT1_2;
  const layouts: Record<number, { left: [number, number][]; right: [number, number][] }> = {
    3: { left: [[0, 1], [2, g]], right: [[1, 1], [2, g]] },                                    // L R C
    4: { left: [[0, 0.5], [2, 0.5]], right: [[1, 0.5], [3, 0.5]] },                            // L R SL SR
    5: { left: [[0, 1], [2, g], [3, g]], right: [[1, 1], [2, g], [4, g]] },                    // L R C SL SR
    6: { left: [[0, 1], [2, g], [4, g]], right: [[1, 1], [2, g], [5, g]] },                    // L R C LFE SL SR
    8: { left: [[0, 1], [2, g], [4, g], [6, g]], right: [[1, 1], [2, g], [5, g], [7, g]] },    // 7.1: + BL BR
  };
  const map = layouts[ch];
  if (!map) return { l: new Float32Array(at(0)), r: new Float32Array(at(1)) };
  const n = buf.length;
  const mix = (feeds: [number, number][]) => {
    const out = new Float32Array(n);
    for (const [c, gain] of feeds) {
      const x = at(c);
      for (let i = 0; i < n; i++) out[i] += gain * x[i];
    }
    return out;
  };
  return { l: mix(map.left), r: mix(map.right) };
}

/**
 * The file's own sample rate and bit depth, read from its header (the
 * decoder hands back 48 kHz whatever came in). Lossy formats have no bit
 * depth. Null where the header doesn't say.
 */
export function sniffFormat(data: ArrayBuffer): { sampleRate: number | null; bitDepth: number | null } {
  const none = { sampleRate: null, bitDepth: null };
  try {
    const v = new DataView(data);
    const b = new Uint8Array(data);
    const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    if (b.length < 16) return none;
    // AIFF: the COMM chunk.
    if (tag(0) === 'FORM') return aiffFormat(data) ?? none;
    // WAV: the fmt chunk.
    if (tag(0) === 'RIFF' && tag(8) === 'WAVE') {
      let off = 12;
      while (off + 8 <= b.length) {
        const size = v.getUint32(off + 4, true);
        if (tag(off) === 'fmt ') return { sampleRate: v.getUint32(off + 12, true), bitDepth: v.getUint16(off + 22, true) };
        off += 8 + size + (size & 1);
      }
      return none;
    }
    // Skip an ID3v2 tag (MP3, sometimes FLAC).
    let o = 0;
    if (tag(0).startsWith('ID3')) {
      o = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f)) + (b[5] & 0x10 ? 10 : 0);
    }
    // FLAC: STREAMINFO follows the magic.
    if (tag(o) === 'fLaC') {
      const si = o + 8;
      return {
        sampleRate: (b[si + 10] << 12) | (b[si + 11] << 4) | (b[si + 12] >> 4),
        bitDepth: (((b[si + 12] & 1) << 4) | (b[si + 13] >> 4)) + 1,
      };
    }
    // Ogg: the first packet is Vorbis's or Opus's identification header.
    if (tag(0) === 'OggS') {
      const p = 27 + b[26];
      if (b[p] === 1 && tag(p + 1) === 'vorb') return { sampleRate: v.getUint32(p + 12, true), bitDepth: null };
      if (tag(p) === 'Opus') return { sampleRate: 48000, bitDepth: null }; // Opus always decodes at 48 kHz
      return none;
    }
    // MP4/M4A: the mp4a sample entry carries the rate (16.16 fixed point).
    if (tag(4) === 'ftyp') {
      const lim = Math.min(b.length - 32, 8 << 20);
      for (let i = 8; i < lim; i++) {
        if (b[i] === 0x6d && b[i + 1] === 0x70 && b[i + 2] === 0x34 && b[i + 3] === 0x61) { // 'mp4a'
          return { sampleRate: v.getUint16(i + 28, false) || null, bitDepth: null };
        }
      }
      return none;
    }
    // MP3: the first frame header after any tag.
    for (let i = o; i < Math.min(b.length - 4, o + 65536); i++) {
      if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
      const ver = (b[i + 1] >> 3) & 3;       // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
      const layer = (b[i + 1] >> 1) & 3;
      const idx = (b[i + 2] >> 2) & 3;
      if (ver === 1 || layer === 0 || idx === 3) continue;
      const base = [44100, 48000, 32000][idx];
      return { sampleRate: ver === 3 ? base : ver === 2 ? base / 2 : base / 4, bitDepth: null };
    }
  } catch { /* unreadable header: say nothing */ }
  return none;
}

/** A tempo analysis read at `scale` times its own tempo (a power of two). */
function atScale(t: TempoInfo, scale: number): TempoInfo {
  let out = t;
  for (let k = scale; k > 1; k /= 2) out = scaleTempo(out, 2);
  for (let k = scale; k < 1; k *= 2) out = scaleTempo(out, 0.5);
  return out;
}

export const engine = new AudioEngine();
