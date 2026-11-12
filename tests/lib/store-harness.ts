// Boots the real store under node: browser globals stubbed, the engine's
// audio replaced by stand-ins that answer at once, the Electron bridge a
// plain object. Nothing here can open a window or a native dialog.
//
// The store is a module singleton, so each test FILE gets one store (the
// runner bundles every file on its own); tests inside a file share it and
// run in order.

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const CLEAN_CHECKS = {
  cutoffHz: null, cutoffDropDb: 0, headSilenceSec: 0, tailSilenceSec: 0, startLevelDb: -90, endLevelDb: -90,
  abruptStart: false, abruptEnd: false, clippedRuns: 0, dcOffset: 0,
};
export const CLEAN_DIAG = { sideBassRelDb: -30, harshRelDb: -20, corrMean: 0.8, corrWorst: 0.5, deadChannel: null };

export function fakeSource(name: string, over: Record<string, unknown> = {}): any {
  return {
    name, durationSec: 200, sampleRate: 48000, originalSampleRate: 44100, originalBitDepth: 16, channels: 2,
    lufs: -12, lra: 5, maxMomentary: -8, maxShortTerm: -9, truePeakDb: -0.5, samplePeakDb: -0.6, balanceOffsetDb: 0,
    diagnostics: { ...CLEAN_DIAG }, checks: { ...CLEAN_CHECKS }, converted: true, repairedSamples: 0,
    ...over,
  };
}

export interface Render { params: any; encode: any; lufs: number }

export interface Booted {
  useStore: any;
  mod: any;
  engine: any;
  /** What localStorage holds. */
  mem: Map<string, string>;
  /** How many times localStorage was written. */
  writes: { n: number };
  /** Moves the clock the undo history reads. */
  tick(ms: number): void;
  /** Writes any settings still waiting (what closing the window does). */
  flush(): void;
  toasts(): string[];
  /** Overrides for the next source the engine "loads". */
  next: { source: Record<string, unknown> };
  /** Every render the batch or album asked for. */
  renders: Render[];
  /** The Electron bridge; tests fill in what they need. */
  bridge: Record<string, any>;
  /** Files the bridge can "read", by path. */
  files: Map<string, ArrayBuffer>;
  tempo: { value: any };
}

export async function boot(opts: { blob?: string } = {}): Promise<Booted> {
  const mem = new Map<string, string>();
  if (opts.blob !== undefined) mem.set('jmaster-settings', opts.blob);
  const writes = { n: 0 };
  const g = globalThis as any;
  const handlers: Record<string, (() => void)[]> = {};
  g.window = g;
  g.addEventListener = (type: string, fn: () => void) => { (handlers[type] ??= []).push(fn); };
  g.removeEventListener = () => undefined;
  g.localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { writes.n++; mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
  };
  g.document = {
    title: '',
    documentElement: { setAttribute() { /* theme */ } },
    createElement() { throw new Error('no DOM in the harness'); },
  };
  // Toasts dismiss themselves seconds later: never worth holding the run open for.
  const realSetTimeout = g.setTimeout;
  g.setTimeout = (fn: () => void, ms?: number, ...rest: unknown[]) => {
    const t = realSetTimeout(fn, ms, ...rest);
    if ((ms ?? 0) >= 1000) t.unref?.();
    return t;
  };
  const now = { t: 1_000_000 };
  Date.now = () => now.t;

  const files = new Map<string, ArrayBuffer>();
  const bridge: Record<string, any> = {
    readFileByPath: async (path: string) => {
      const f = files.get(path);
      if (!f) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      return f.slice(0);
    },
    saveFileTo: async (dir: string, name: string) => `${dir}\\${name}`,
  };
  g.jmaster = bridge;

  const mod: any = await import('../../src/state/store');
  const eng: any = await import('../../src/audio/engine');
  const engine = eng.engine;
  const next = { source: {} as Record<string, unknown> };
  const renders: Render[] = [];
  const tempo = { value: null as any };

  engine.loadFile = async (_bytes: ArrayBuffer, name: string, onPhase?: (p: string) => void, isCurrent?: () => boolean) => {
    onPhase?.('DECODING');
    const over = next.source;
    next.source = {};
    await sleep(/slow/.test(name) ? 40 : 4);
    if (isCurrent && !isCurrent()) return null;
    const src = fakeSource(name, over);
    engine.source = src;
    engine.tempoScale = 1;
    return src;
  };
  engine.requestTempo = () => Promise.resolve(tempo.value);
  engine.requestSourceProfile = async () => ({ bands: new Float32Array(30), lufs: -12, sideRatioDb: -10 });
  engine.profileBuffers = async () => ({ bands: new Float32Array(30).fill(1), lufs: -9, sideRatioDb: -8 });
  engine.updateParams = (p: any) => { engine.__params = p; };
  engine.scheduleProcessedPreview = () => undefined;
  engine.releasePreview = () => undefined;
  engine.setClickBeats = () => undefined;
  engine.seekSec = () => undefined;
  engine.setLoop = () => undefined;
  engine.play = async () => undefined;
  engine.pause = () => undefined;
  engine.stop = () => undefined;
  engine.auditionStop = () => undefined;
  engine.measureLufs = async () => -13;
  // A file's first byte is its "content": 1 = harsh highs, 2 = bass in the sides.
  engine.decodeOnly = async (bytes: ArrayBuffer) => {
    await sleep(2);
    const l = new Float32Array(8);
    l[0] = new Uint8Array(bytes)[0] ?? 0;
    return { l, r: new Float32Array(8), durationSec: 100, clippedRuns: 0 };
  };
  engine.analyzeBuffers = async (l: Float32Array) => {
    await sleep(2);
    return {
      lufs: -13, truePeakDb: -1, balanceOffsetDb: 0,
      diagnostics: { ...CLEAN_DIAG, ...(l[0] === 1 ? { harshRelDb: -5 } : l[0] === 2 ? { sideBassRelDb: -6 } : {}) },
      checks: { ...CLEAN_CHECKS },
    };
  };
  engine.renderBuffers = async (_l: Float32Array, _r: Float32Array, params: any, lufs: number, durationSec: number, encode: any) => {
    await sleep(3);
    renders.push({ params, encode, lufs });
    // A 16-bit stereo WAV of one CD frame, for the album path to read.
    const data = new ArrayBuffer(44 + 588 * 4);
    new DataView(data).setUint32(40, 588 * 4, true);
    return {
      data, ext: encode.format, mime: 'audio/wav',
      stats: {
        integratedLufs: params.targetLufs, truePeakDb: params.ceilingDb, samplePeakDb: params.ceilingDb - 0.2,
        appliedGainDb: 3, limiterMaxGrDb: 1, durationSec, sampleRate: encode.sampleRate ?? 48000,
        bitDepth: encode.bitDepth, format: encode.format, bytes: data.byteLength, targetReached: true,
      },
    };
  };

  const useStore = mod.useStore;
  return {
    useStore, mod, engine, mem, writes, next, renders, bridge, files, tempo,
    tick: (ms) => { now.t += ms; },
    flush: () => { for (const fn of [...(handlers.pagehide ?? [])]) fn(); },
    toasts: () => useStore.getState().toasts.map((t: any) => `[${t.kind}] ${t.text}`),
  };
}
