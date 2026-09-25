// Main-thread audio engine: owns the AudioContext (48 kHz), the worklet
// playback node, the analysers for the spectrum, the source buffers, and the
// offline render workers. All UI actions route through here.
import { ChainParams, NOMINAL_LUFS } from './dsp/params';
import type { EncodeOptions } from './encode';

export interface MeterFrame {
  playhead: number;
  playing: boolean;
  idle: boolean;
  momentary: number;
  shortTerm: number;
  integrated: number;
  truePeakDb: number;
  compGrDb: number;
  limiterGrDb: number;
  deharshGrDb: number;
  correlation: number;
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
  truePeakDb: number;
  samplePeakDb: number;
  /** L/R RMS imbalance in dB; positive = right louder. */
  balanceOffsetDb: number;
  /** Source pathology measurements (AI-music checks). */
  diagnostics: SourceDiagnostics;
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
}

export interface SongSection {
  startSec: number;
  endSec: number;
  label: string;
}

export interface TempoInfo {
  bpm: number;
  firstBeatSec: number;
  firstBarSec: number;
  confidence: number;
  sections: SongSection[];
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
  durationSec: number;
  sampleRate: number;
  bitDepth: number;
  format: string;
  mp3Kbps?: number;
  opusKbps?: number;
  bytes: number;
}

export interface RenderResult {
  data: ArrayBuffer;
  ext: string;
  mime: string;
  stats: ExportStats;
}

export interface ExportProgress {
  phase: string;
  pct: number;
}

const TARGET_RATE = 48000;
const WAVEFORM_BUCKETS = 4096;
const SCOPE_SAMPLES = 2048;

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
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.82;
    node.connect(analyser, 0);
    analyser.connect(ctx.destination);
    // "Before" analyser fed by the worklet's loudness-matched source output.
    const analyserPre = ctx.createAnalyser();
    analyserPre.fftSize = 4096;
    analyserPre.smoothingTimeConstant = 0.82;
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
    node.port.onmessage = (e) => {
      if (e.data.type === 'meters') {
        for (const fn of this.meterListeners) fn(e.data as MeterFrame);
      } else if (e.data.type === 'ended') {
        for (const fn of this.meterListeners) {
          fn({
            playhead: this.srcL ? this.srcL.length : 0,
            playing: false, idle: false,
            momentary: -70, shortTerm: -70, integrated: -70,
            truePeakDb: -70, compGrDb: 0, limiterGrDb: 0, deharshGrDb: 0, correlation: 1,
          });
        }
      }
    };
    this.ctx = ctx;
    this.node = node;
    this.analyser = analyser;
    return ctx;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker('./audio/jmaster-render-worker.js');
    this.worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'analyzed') {
        this.analyzeWaiters.shift()?.(d);
      } else if (d.type === 'progress' && this.renderHandlers) {
        this.renderHandlers.onProgress({ phase: d.phase, pct: d.pct });
      } else if (d.type === 'done' && this.renderHandlers) {
        this.rendering = false;
        this.renderHandlers.onDone({ data: d.wav, ext: d.ext, mime: d.mime, stats: d.stats });
        this.renderHandlers = null;
      } else if (d.type === 'render-error' && this.renderHandlers) {
        this.rendering = false;
        this.renderHandlers.onProgress({ phase: `FAILED · ${d.message}`, pct: 1 });
        this.renderHandlers = null;
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

  /** Decodes, resamples to 48 kHz, analyzes, and arms the worklet. */
  loadFile(data: ArrayBuffer, name: string, onPhase?: (phase: string) => void): Promise<SourceInfo | null> {
    const seq = ++this.loadSeq;
    const run = this.loadQueue.then(() =>
      (seq === this.loadSeq ? this.loadFileNow(data, name, onPhase) : null));
    this.loadQueue = run.catch(() => undefined);
    return run;
  }

  private async loadFileNow(
    data: ArrayBuffer,
    name: string,
    onPhase?: (phase: string) => void,
  ): Promise<SourceInfo> {
    const originalBitDepth = sniffWavBitDepth(data);
    onPhase?.('DECODING');
    const ctx = await this.ensureContext();
    // decodeAudioData resamples to the context rate (48 kHz) for us. Decode
    // before touching any state, so an unreadable file leaves the current
    // track fully intact.
    const decoded = await ctx.decodeAudioData(data.slice(0));
    onPhase?.('ANALYSING LOUDNESS · PEAKS · STEREO');
    this.gen++;
    this.spectrogram = null;
    this.spectrogramPending = null;
    this.tempo = null;
    this.tempoPending = null;
    this.sourceProfile = null;
    this.clearProcessedPreview();
    const channels = decoded.numberOfChannels;
    const L = decoded.getChannelData(0);
    const R = channels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0);
    this.srcL = new Float32Array(L);
    this.srcR = new Float32Array(R);

    // Worklet gets its own copy (transferred).
    const wl = new Float32Array(this.srcL);
    const wr = new Float32Array(this.srcR);
    this.node!.port.postMessage({ type: 'load', l: wl.buffer, r: wr.buffer }, [wl.buffer, wr.buffer]);

    // Analysis + waveform in the worker (transferred copies again).
    const al = new Float32Array(this.srcL);
    const ar = new Float32Array(this.srcR);
    const worker = this.ensureWorker();
    const analyzed: any = await new Promise((resolve) => {
      this.analyzeWaiters.push(resolve);
      worker.postMessage(
        { type: 'analyze', l: al.buffer, r: ar.buffer, fs: TARGET_RATE, buckets: WAVEFORM_BUCKETS },
        [al.buffer, ar.buffer],
      );
    });

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
    }
    this.source = {
      name,
      durationSec: decoded.duration,
      sampleRate: TARGET_RATE,
      originalSampleRate: sniffWavSampleRate(data) ?? decoded.sampleRate,
      originalBitDepth,
      channels,
      lufs: analyzed.lufs,
      lra: analyzed.lra ?? 0,
      truePeakDb: analyzed.truePeakDb,
      samplePeakDb: analyzed.samplePeakDb,
      balanceOffsetDb: analyzed.balanceOffsetDb ?? 0,
      diagnostics: analyzed.diagnostics ?? {
        sideBassRelDb: -60, harshRelDb: -60, corrMean: 1, corrWorst: 1,
      },
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
  }

  private pushParams(p: ChainParams): void {
    if (!this.node) return;
    const src = this.source;
    const params: ChainParams = {
      ...p,
      stagingGainDb: src ? NOMINAL_LUFS - src.lufs : 0,
      outputGainDb: p.targetLufs - NOMINAL_LUFS - this.chainDeltaDb,
      refOutputGainDb: p.targetLufs - NOMINAL_LUFS,
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
    return { bands: new Float32Array(d.bands), lufs: d.lufs, sideRatioDb: d.sideRatioDb };
  }

  /** Profile of the loaded source (computed once). */
  async requestSourceProfile(): Promise<{ bands: Float32Array; lufs: number; sideRatioDb: number } | null> {
    if (this.sourceProfile) return this.sourceProfile;
    if (!this.srcL || !this.srcR) return null;
    const gen = this.gen;
    const profile = await this.profileBuffers(this.srcL, this.srcR);
    if (gen !== this.gen) return null;
    this.sourceProfile = profile;
    return profile;
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
        const t: TempoInfo | null = d.bpm > 0
          ? {
              bpm: d.bpm,
              firstBeatSec: d.firstBeatSec,
              firstBarSec: d.firstBarSec ?? d.firstBeatSec,
              confidence: d.confidence,
              sections: d.sections ?? [],
            }
          : null;
        if (gen !== this.gen) { resolve(null); return; }
        this.tempo = t;
        this.tempoPending = null;
        resolve(t);
      });
      worker.postMessage(
        { type: 'tempo', l: l.buffer, r: r.buffer, fs: TARGET_RATE },
        [l.buffer, r.buffer],
      );
    });
    this.tempoPending = pending;
    return pending;
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
  ): void {
    if (!this.srcL || !this.srcR || !this.source) return;
    const worker = this.ensureWorker();
    this.renderHandlers = { onProgress, onDone };
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

  private ensureBatchWorker(): Worker {
    if (this.batchWorker) return this.batchWorker;
    this.batchWorker = new Worker('./audio/jmaster-render-worker.js');
    this.batchWorker.onmessage = (e) => {
      const d = e.data;
      const entry = d.reqId !== undefined ? this.batchPending.get(d.reqId) : undefined;
      if (!entry) return;
      if (d.type === 'progress') {
        entry.onProgress?.({ phase: d.phase, pct: d.pct });
      } else if (d.type === 'analyzed' || d.type === 'done' || d.type === 'previewed' || d.type === 'render-error' || d.type === 'profiled') {
        this.batchPending.delete(d.reqId);
        entry.resolve(d);
      }
    };
    return this.batchWorker;
  }

  /** Decodes bytes to 48 kHz stereo float without touching the loaded track. */
  async decodeOnly(data: ArrayBuffer): Promise<{ l: Float32Array; r: Float32Array; durationSec: number }> {
    const ctx = await this.ensureContext();
    const decoded = await ctx.decodeAudioData(data.slice(0));
    const l = new Float32Array(decoded.getChannelData(0));
    const r = new Float32Array(
      decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0),
    );
    return { l, r, durationSec: decoded.duration };
  }

  /** Full analysis (LUFS, diagnostics, balance) of buffers via the batch worker. */
  async analyzeBuffers(l: Float32Array, r: Float32Array): Promise<{
    lufs: number;
    balanceOffsetDb: number;
    diagnostics: SourceDiagnostics;
  }> {
    const worker = this.ensureBatchWorker();
    const reqId = ++this.batchReqSeq;
    const cl = new Float32Array(l);
    const cr = new Float32Array(r);
    const res: any = await new Promise((resolve) => {
      this.batchPending.set(reqId, { resolve });
      worker.postMessage(
        { type: 'analyze', reqId, l: cl.buffer, r: cr.buffer, fs: TARGET_RATE, buckets: 64 },
        [cl.buffer, cr.buffer],
      );
    });
    return {
      lufs: res.lufs,
      balanceOffsetDb: res.balanceOffsetDb ?? 0,
      diagnostics: res.diagnostics ?? { sideBassRelDb: -60, harshRelDb: -60, corrMean: 1, corrWorst: 1 },
    };
  }

  /** Integrated LUFS of arbitrary buffers via the batch worker. */
  async measureLufs(l: Float32Array, r: Float32Array): Promise<number> {
    return (await this.analyzeBuffers(l, r)).lufs;
  }

  // ── processed-master preview (debounced full-chain render → peaks) ──
  processedPreview: {
    spb: number; mins: Float32Array; maxs: Float32Array; rms: Float32Array;
    lane: { stepSec: number; values: Float32Array };
    integrated: number;
  } | null = null;
  previewPending = false;
  /** Notified whenever previewPending or processedPreview changes (UI mirror). */
  onPreviewUpdate: (() => void) | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  /** Which source the batch worker holds a primed preview copy of. */
  private primedSource: SourceInfo | null = null;

  scheduleProcessedPreview(params: ChainParams, delayMs = 2000): void {
    if (!this.srcL || !this.srcR || !this.source) return;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewPending = true;
    this.onPreviewUpdate?.();
    this.previewTimer = setTimeout(() => {
      void (async () => {
        const worker = this.ensureBatchWorker();
        // Lazy prime: the worker caches the source only once previews are
        // actually in use, so OUT-less sessions never pay the memory.
        if (this.primedSource !== this.source) {
          const pl = new Float32Array(this.srcL!);
          const pr = new Float32Array(this.srcR!);
          worker.postMessage(
            { type: 'prime', l: pl.buffer, r: pr.buffer, fs: TARGET_RATE, sourceLufs: this.source!.lufs },
            [pl.buffer, pr.buffer],
          );
          this.primedSource = this.source;
        }
        const reqId = ++this.batchReqSeq;
        const fullParams: ChainParams = { ...params, songLengthSec: this.source!.durationSec };
        const d: any = await new Promise((resolve) => {
          this.batchPending.set(reqId, { resolve });
          worker.postMessage({ type: 'preview', reqId, params: fullParams });
        });
        if (d.type === 'previewed' && !d.unprimed) {
          this.processedPreview = {
            spb: d.spb,
            mins: new Float32Array(d.mins),
            maxs: new Float32Array(d.maxs),
            rms: new Float32Array(d.rms),
            lane: { stepSec: d.stStepSec ?? 0.5, values: new Float32Array(d.stSeries) },
            integrated: d.integrated,
          };
        }
        this.previewPending = false;
        this.onPreviewUpdate?.();
      })();
    }, delayMs);
  }

  clearProcessedPreview(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.processedPreview = null;
    this.previewPending = false;
    this.onPreviewUpdate?.();
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
    return { data: d.wav, ext: d.ext, mime: d.mime, stats: d.stats };
  }
}

/** Reads the fmt chunk of a RIFF/WAVE header, if present. */
function sniffWavBitDepth(data: ArrayBuffer): number | null {
  try {
    const v = new DataView(data);
    if (v.getUint32(0, false) !== 0x52494646) return null; // 'RIFF'
    if (v.getUint32(8, false) !== 0x57415645) return null; // 'WAVE'
    let off = 12;
    while (off + 8 <= v.byteLength) {
      const id = v.getUint32(off, false);
      const size = v.getUint32(off + 4, true);
      if (id === 0x666d7420) return v.getUint16(off + 22, true); // 'fmt '
      off += 8 + size + (size & 1);
    }
  } catch { /* not a wav */ }
  return null;
}

function sniffWavSampleRate(data: ArrayBuffer): number | null {
  try {
    const v = new DataView(data);
    if (v.getUint32(0, false) !== 0x52494646) return null;
    if (v.getUint32(8, false) !== 0x57415645) return null;
    let off = 12;
    while (off + 8 <= v.byteLength) {
      const id = v.getUint32(off, false);
      const size = v.getUint32(off + 4, true);
      if (id === 0x666d7420) return v.getUint32(off + 12, true);
      off += 8 + size + (size & 1);
    }
  } catch { /* not a wav */ }
  return null;
}

export const engine = new AudioEngine();
