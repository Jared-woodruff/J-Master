import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  ChainParams, FadeCurve, MacroValues, PRESETS, PLATFORMS,
  defaultParams, defaultAdvEq, AdvEqBand, MATCH_EQ_CENTERS,
} from '../audio/dsp/params';
import {
  engine, MeterFrame, SourceInfo, ExportStats, ExportProgress,
} from '../audio/engine';
import type { EncodeOptions, ExportFormat, TrackTags } from '../audio/encode';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'run' | 'fault';
}

export interface ConsoleSnapshot {
  macros: MacroValues;
  targetLufs: number;
  ceilingDb: number;
  balanceDb: number;
  presetId: string | null;
  platformId: string | null;
  matchEqGains?: number[];
  advEq?: AdvEqBand[];
  stems?: { bass: number; drums: number; vocal: number; air: number };
}

/** Everything undo/redo and project files consider "the console". */
export interface ConsoleState extends ConsoleSnapshot {
  bassMono: boolean;
  fadeInSec: number;
  fadeOutSec: number;
  fadeInCurve: FadeCurve;
  fadeOutCurve: FadeCurve;
}

function captureConsole(s: JMasterState): ConsoleState {
  return {
    macros: { ...s.macros },
    targetLufs: s.targetLufs,
    ceilingDb: s.ceilingDb,
    balanceDb: s.balanceDb,
    presetId: s.presetId,
    platformId: s.platformId,
    bassMono: s.bassMono,
    fadeInSec: s.fadeInSec,
    fadeOutSec: s.fadeOutSec,
    fadeInCurve: s.fadeInCurve,
    fadeOutCurve: s.fadeOutCurve,
    matchEqGains: [...s.matchEqGains],
    advEq: s.advEq.map((b) => ({ ...b })),
    stems: { ...s.stems },
  };
}

interface HistoryEntry {
  snap: ConsoleState;
  /** Which control produced the entry — continuous gestures collapse. */
  field: string;
  at: number;
}

const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];
const HISTORY_MAX = 100;
const GESTURE_MS = 800;

export interface DiagIssue {
  id: string;
  label: string;
  /** Measured value, spec-sheet style. */
  spec: string;
  /** What APPLY will do. */
  fixLabel: string;
  action: { type: 'bassMono' } | { type: 'width'; value: number }
        | { type: 'balance' } | { type: 'smooth'; value: number };
  checked: boolean;
}

export interface DiagCheck {
  label: string;
  spec: string;
  pass: boolean;
}

/** Derives AI-music pathology issues + the full check sheet from measurements. */
function deriveDiagnosis(
  d: import('../audio/engine').SourceDiagnostics,
  balanceOffsetDb: number,
): { issues: DiagIssue[]; checks: DiagCheck[] } {
  const src = { balanceOffsetDb };
  const issues: DiagIssue[] = [];
  const checks: DiagCheck[] = [];

  const bassBad = d.sideBassRelDb > -12;
  checks.push({
    label: 'BASS PLACEMENT',
    spec: `SIDE ${d.sideBassRelDb.toFixed(1)} dB VS MID · <140 HZ`,
    pass: !bassBad,
  });
  if (bassBad) {
    issues.push({
      id: 'bassmono', label: 'BASS IN SIDES',
      spec: `SIDE LOW ${d.sideBassRelDb.toFixed(1)} dB VS MID`,
      fixLabel: 'MONO BELOW 140 HZ',
      action: { type: 'bassMono' }, checked: true,
    });
  }

  const widthBad = d.corrWorst < 0.15 || d.corrMean < 0.5;
  checks.push({
    label: 'WIDTH STABILITY',
    spec: `CORR MEAN ${d.corrMean.toFixed(2)} · WORST ${d.corrWorst.toFixed(2)}`,
    pass: !widthBad,
  });
  if (widthBad) {
    const suggested = d.corrWorst < 0 || d.corrMean < 0.35 ? 0.85 : 0.92;
    issues.push({
      id: 'width', label: 'UNSTABLE WIDTH',
      spec: `CORR MEAN ${d.corrMean.toFixed(2)} · WORST ${d.corrWorst.toFixed(2)}`,
      fixLabel: `WIDTH ${Math.round(suggested * 100)}%`,
      action: { type: 'width', value: suggested }, checked: true,
    });
  }

  const leanBad = Math.abs(src.balanceOffsetDb) >= 0.3;
  checks.push({
    label: 'IMAGE BALANCE',
    spec: `${src.balanceOffsetDb >= 0 ? 'R' : 'L'} ${Math.abs(src.balanceOffsetDb).toFixed(1)} dB HOT`,
    pass: !leanBad,
  });
  if (leanBad) {
    issues.push({
      id: 'balance', label: 'IMAGE LEAN',
      spec: `${src.balanceOffsetDb >= 0 ? 'RIGHT' : 'LEFT'} ${Math.abs(src.balanceOffsetDb).toFixed(1)} dB HOT`,
      fixLabel: 'AUTO-CENTER',
      action: { type: 'balance' }, checked: true,
    });
  }

  const harshBad = d.harshRelDb > -10;
  checks.push({
    label: 'HF TEXTURE',
    spec: `>4.5 KHZ ${d.harshRelDb.toFixed(1)} dB REL`,
    pass: !harshBad,
  });
  if (harshBad) {
    const suggested = d.harshRelDb > -7 ? 0.5 : 0.3;
    issues.push({
      id: 'smooth', label: 'HARSH HIGHS',
      spec: `>4.5 KHZ ${d.harshRelDb.toFixed(1)} dB REL`,
      fixLabel: `SMOOTH ${Math.round(suggested * 100)}%`,
      action: { type: 'smooth', value: suggested }, checked: true,
    });
  }

  return { issues, checks };
}

async function openProject(
  jsonText: string,
  set: (p: Partial<JMasterState>) => void,
  get: () => JMasterState,
): Promise<void> {
  try {
    const proj = JSON.parse(jsonText) as ProjectFile;
    if (proj.app !== 'J-Master') throw new Error('not a J-Master project');
    const bridge = (window as any).jmaster;
    // Audio first, so loadFile's per-track resets don't clobber the console.
    if (proj.track?.path && bridge?.readFileByPath) {
      try {
        const bytes: ArrayBuffer = await bridge.readFileByPath(proj.track.path);
        suppressDiagOnce = true;
        await get().loadFile(bytes, proj.track.name, proj.track.path);
      } catch {
        get().pushToast(`AUDIO NOT FOUND · ${proj.track.name.toUpperCase()} · LOAD IT MANUALLY`, 'fault');
      }
    } else if (proj.track) {
      get().pushToast(`LOAD ${proj.track.name.toUpperCase()} MANUALLY TO CONTINUE`, 'info');
    }
    set({
      snapshots: proj.snapshots ?? { A: null, B: null },
      activeSlot: proj.activeSlot ?? 'A',
      meta: proj.meta ?? get().meta,
      exportFormat: proj.export?.format ?? 'wav',
      exportBitDepth: proj.export?.bitDepth ?? 24,
      exportMp3Kbps: proj.export?.mp3Kbps ?? 320,
      exportOpusKbps: proj.export?.opusKbps ?? 192,
      batchDir: proj.batch?.dir ?? get().batchDir,
    });
    applyConsole(proj.console, set, get);
    batchSources.clear();
    const items: BatchItem[] = [];
    for (const it of proj.batch?.items ?? []) {
      if (!it.path) continue;
      const id = batchSeq++;
      batchSources.set(id, { path: it.path });
      items.push({ id, name: it.name, status: 'pending', pct: 0, phase: '', presetId: it.presetId, isrc: it.isrc });
    }
    set({ batchItems: items });
    void scanBatchItems(set as any, get);
    get().pushToast('PROJECT OPENED', 'run');
  } catch {
    get().pushToast('PROJECT FILE UNREADABLE', 'fault');
  }
}

export type BatchStatus = 'pending' | 'working' | 'done' | 'failed';

export interface BatchItem {
  id: number;
  name: string;
  status: BatchStatus;
  pct: number;
  phase: string;
  /** Preset override for this track; null/undefined = current console. */
  presetId?: string | null;
  /** ISRC for CD/album assembly (12 chars, e.g. AUJMW2600001). */
  isrc?: string;
  /** Background pre-scan results. */
  scanned?: boolean;
  lufs?: number;
  balanceOffsetDb?: number;
  fixes?: DiagIssue[];
  fixesEnabled?: boolean;
  outLufs?: number;
  outPath?: string;
  error?: string;
}

let batchScanRunning = false;

// Non-serializable per-item file sources live outside the store.
const batchSources = new Map<number, { path?: string; file?: File }>();
let batchSeq = 1;
let batchCancelled = false;

export function masterFileName(sourceName: string, encode: EncodeOptions): string {
  const base = sourceName.replace(/\.[^.]+$/, '');
  if (encode.format === 'mp3') return `${base} — Master ${encode.mp3Kbps}.mp3`;
  if (encode.format === 'opus') return `${base} — Master OPUS${encode.opusKbps ?? 192}.opus`;
  return `${base} — Master 48k${encode.bitDepth}.${encode.format}`;
}

export interface ExportHistoryEntry {
  name: string;
  path: string | null;
  format: string;
  bytes: number;
  lufs: number;
  truePeakDb: number;
  when: string;
}

/** .jmaster project document (version 1). */
interface ProjectFile {
  app: 'J-Master';
  fileVersion: 1;
  savedAt: string;
  track: { name: string; path: string | null } | null;
  console: ConsoleState;
  snapshots: { A: ConsoleSnapshot | null; B: ConsoleSnapshot | null };
  activeSlot: 'A' | 'B';
  meta: JMasterState['meta'];
  export: { format: ExportFormat; bitDepth: 16 | 24; mp3Kbps: 192 | 256 | 320; opusKbps: 128 | 192 | 256 };
  batch: { dir: string | null; items: { name: string; path: string | null; presetId: string | null; isrc?: string }[] };
}

let suppressDiagOnce = false;

interface JMasterState {
  loaded: boolean;
  loading: boolean;
  loadError: string | null;
  source: SourceInfo | null;
  /** Filesystem path of the loaded audio (Electron), for project files. */
  trackPath: string | null;

  macros: MacroValues;
  presetId: string | null;
  platformId: string | null;
  targetLufs: number;
  ceilingDb: number;
  fadeInSec: number;
  fadeOutSec: number;
  fadeInCurve: FadeCurve;
  fadeOutCurve: FadeCurve;
  bypass: boolean;
  limiterDelta: boolean;
  balanceDb: number;
  bassMono: boolean;
  matchEqGains: number[];
  advEq: AdvEqBand[];
  stems: { bass: number; drums: number; vocal: number; air: number };
  advEqOpen: boolean;
  matchOpen: boolean;
  matchRef: {
    name: string; lufs: number; sideRatioDb: number;
    deltaGains: number[]; suggestedWidth: number;
  } | null;
  matchLoading: boolean;
  masterItReport: { presetName: string; reasons: string[] } | null;
  masterItBusy: boolean;
  audition: { active: boolean; mode: 'codec' | 'master'; busy: boolean };
  metronome: boolean;
  gridEnabled: boolean;
  loudnessLane: boolean;
  tempo: import('../audio/engine').TempoInfo | null;

  diagOpen: boolean;
  diagIssues: DiagIssue[];
  diagChecks: DiagCheck[];
  autoFix: boolean;

  /** A/B console snapshots for loudness-matched comparisons. */
  activeSlot: 'A' | 'B';
  snapshots: { A: ConsoleSnapshot | null; B: ConsoleSnapshot | null };

  playing: boolean;
  playheadSec: number;
  meters: MeterFrame | null;

  theme: 'plate' | 'paper';
  waveView: 'wave' | 'spec';
  exportOpen: boolean;
  exporting: ExportProgress | null;
  exportStats: ExportStats | null;
  exportSavedTo: string | null;
  exportFormat: ExportFormat;
  exportBitDepth: 16 | 24;
  exportMp3Kbps: 192 | 256 | 320;
  exportOpusKbps: 128 | 192 | 256;
  exportHistory: ExportHistoryEntry[];
  processedView: boolean;
  /** OUT comparison layout: ghost overlay (false) or split lanes (true). */
  outSplit: boolean;
  /** Shared release metadata written into exports (title is per-track). */
  meta: { artist: string; album: string; year: string; genre: string; catalog: string; comment: string };
  toasts: Toast[];

  batchOpen: boolean;
  batchItems: BatchItem[];
  batchRunning: boolean;
  batchDir: string | null;

  albumOpen: boolean;
  albumUpc: string;
  albumGapSec: number;
  albumAssembling: { phase: string; pct: number } | null;
  albumResult: { imagePath: string; cuePath: string; totalMin: number } | null;

  loadFile(data: ArrayBuffer, name: string, path?: string | null): Promise<void>;
  setMacro(key: keyof MacroValues, value: number): void;
  applyPreset(id: string): void;
  applyPlatform(id: string): void;
  nudgeTarget(delta: number): void;
  nudgeCeiling(delta: number): void;
  setFade(which: 'in' | 'out', sec: number): void;
  setFadeCurve(which: 'in' | 'out', curve: FadeCurve): void;
  setBypass(on: boolean): void;
  setLimiterDelta(on: boolean): void;
  setBalance(db: number): void;
  autoCenter(): void;
  setMetronome(on: boolean): void;
  setGridEnabled(on: boolean): void;
  setLoudnessLane(on: boolean): void;
  switchSlot(slot: 'A' | 'B'): void;
  openDiag(open: boolean): void;
  toggleDiagIssue(id: string): void;
  setAutoFix(on: boolean): void;
  applyDiagFixes(): void;
  undoDepth: number;
  redoDepth: number;
  undo(): void;
  redo(): void;
  saveProject(): Promise<void>;
  openMatch(open: boolean): void;
  loadReference(): Promise<void>;
  applyMatch(): void;
  clearMatch(): void;
  setAdvEqOpen(open: boolean): void;
  setAdvBand(index: number, patch: Partial<AdvEqBand>): void;
  resetAdvEq(): void;
  setStem(lane: 'bass' | 'drums' | 'vocal' | 'air', db: number): void;
  startAudition(): Promise<void>;
  setAuditionMode(mode: 'codec' | 'master'): void;
  stopAudition(): void;
  openAlbum(open: boolean): void;
  setAlbumUpc(upc: string): void;
  setAlbumGap(sec: number): void;
  setItemIsrc(id: number, isrc: string): void;
  moveBatchItem(id: number, delta: -1 | 1): void;
  assembleAlbum(): Promise<void>;
  masterIt(): Promise<void>;
  closeMasterItReport(): void;
  togglePlay(): void;
  stop(): void;
  seekSec(sec: number): void;
  setTheme(theme: 'plate' | 'paper'): void;
  setWaveView(view: 'wave' | 'spec'): void;
  openExport(open: boolean): void;
  setExportFormat(format: ExportFormat): void;
  setExportBitDepth(depth: 16 | 24): void;
  setExportMp3Kbps(kbps: 192 | 256 | 320): void;
  setExportOpusKbps(kbps: 128 | 192 | 256): void;
  setProcessedView(on: boolean): void;
  setOutSplit(on: boolean): void;
  toggleItemFixes(id: number): void;
  setMeta(field: keyof JMasterState['meta'], value: string): void;
  startExport(fileName: string, title: string): void;

  openBatch(open: boolean): void;
  addBatchFiles(): Promise<void>;
  addBatchDroppedFiles(files: File[]): void;
  setBatchItemPreset(id: number, presetId: string | null): void;
  clearBatch(): void;
  chooseBatchDir(): Promise<void>;
  startBatch(): Promise<void>;
  cancelBatch(): void;

  pushToast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
}

export function encodeOptionsFrom(s: JMasterState): EncodeOptions {
  return {
    format: s.exportFormat,
    bitDepth: s.exportBitDepth,
    mp3Kbps: s.exportMp3Kbps,
    opusKbps: s.exportOpusKbps,
  };
}

export function tagsFrom(
  s: JMasterState,
  title: string,
  trackNumber?: number,
  trackTotal?: number,
): TrackTags {
  return {
    title: title || undefined,
    artist: s.meta.artist || undefined,
    album: s.meta.album || undefined,
    year: s.meta.year || undefined,
    genre: s.meta.genre || undefined,
    catalog: s.meta.catalog || undefined,
    comment: s.meta.comment || undefined,
    trackNumber,
    trackTotal,
  };
}

/** "SOUTHERN ROCK" → "Southern Rock" for genre tags. */
function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])\w/g, (c) => c.toUpperCase());
}

let toastSeq = 1;

export function chainParamsFrom(s: JMasterState): ChainParams {
  const base = defaultParams();
  return {
    ...base,
    tone: s.macros.tone,
    shape: s.macros.shape,
    air: s.macros.air,
    character: s.macros.character,
    density: s.macros.density,
    impact: s.macros.impact,
    width: s.macros.width,
    targetLufs: s.targetLufs,
    ceilingDb: s.ceilingDb,
    fadeInSec: s.fadeInSec,
    fadeOutSec: s.fadeOutSec,
    fadeInCurve: s.fadeInCurve,
    fadeOutCurve: s.fadeOutCurve,
    bypass: s.bypass,
    limiterDelta: s.limiterDelta,
    smooth: s.macros.smooth,
    balanceDb: s.balanceDb,
    bassMono: s.bassMono,
    matchEqGains: s.matchEqGains,
    advEq: s.advEq,
    stemBassDb: s.stems.bass,
    stemDrumsDb: s.stems.drums,
    stemVocalDb: s.stems.vocal,
    stemAirDb: s.stems.air,
    metronome: s.metronome,
    gridBpm: s.tempo?.bpm ?? 0,
    // Click counts beats from the first bar so accents land on downbeats.
    gridFirstBeatSec: s.tempo?.firstBarSec ?? s.tempo?.firstBeatSec ?? 0,
  };
}

function pushParams(get: () => JMasterState): void {
  const params = chainParamsFrom(get());
  engine.updateParams(params);
  // Keep the processed-master overlay tracking the console (debounced).
  if (get().processedView) engine.scheduleProcessedPreview(params);
}

/** Background pre-scan: analyze queued batch tracks for loudness + fixes. */
async function scanBatchItems(
  set: (fn: (s: JMasterState) => Partial<JMasterState>) => void,
  get: () => JMasterState,
): Promise<void> {
  if (batchScanRunning) return;
  batchScanRunning = true;
  const patch = (id: number, p: Partial<BatchItem>) =>
    set((st) => ({
      batchItems: st.batchItems.map((it) => (it.id === id ? { ...it, ...p } : it)),
    }));
  try {
    for (;;) {
      if (get().batchRunning) break;
      const item = get().batchItems.find((it) => !it.scanned && it.status === 'pending');
      if (!item) break;
      const src = batchSources.get(item.id);
      if (!src) { patch(item.id, { scanned: true }); continue; }
      try {
        patch(item.id, { phase: 'SCANNING' });
        const bridge = (window as any).jmaster;
        const bytes: ArrayBuffer = src.path
          ? await bridge.readFileByPath(src.path)
          : await src.file!.arrayBuffer();
        const { l, r } = await engine.decodeOnly(bytes);
        const a = await engine.analyzeBuffers(l, r);
        const { issues } = deriveDiagnosis(a.diagnostics, a.balanceOffsetDb);
        patch(item.id, {
          scanned: true, phase: '',
          lufs: a.lufs, balanceOffsetDb: a.balanceOffsetDb,
          fixes: issues, fixesEnabled: issues.length > 0,
        });
      } catch {
        patch(item.id, { scanned: true, phase: '' });
      }
    }
  } finally {
    batchScanRunning = false;
  }
}

/** Records the pre-change console state; continuous knob gestures collapse. */
let historySet: ((p: Partial<JMasterState>) => void) | null = null;
function record(get: () => JMasterState, field: string): void {
  const now = Date.now();
  const top = undoStack[undoStack.length - 1];
  if (top && top.field === field && now - top.at < GESTURE_MS) {
    top.at = now;
    return;
  }
  undoStack.push({ snap: captureConsole(get()), field, at: now });
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
  historySet?.({ undoDepth: undoStack.length, redoDepth: 0 });
}

function applyConsole(snap: ConsoleState, set: (p: Partial<JMasterState>) => void, get: () => JMasterState): void {
  set({
    macros: { ...snap.macros },
    targetLufs: snap.targetLufs,
    ceilingDb: snap.ceilingDb,
    balanceDb: snap.balanceDb,
    presetId: snap.presetId,
    platformId: snap.platformId,
    bassMono: snap.bassMono,
    fadeInSec: snap.fadeInSec,
    fadeOutSec: snap.fadeOutSec,
    fadeInCurve: snap.fadeInCurve,
    fadeOutCurve: snap.fadeOutCurve,
    matchEqGains: snap.matchEqGains ? [...snap.matchEqGains] : [],
    advEq: snap.advEq ? snap.advEq.map((b) => ({ ...b })) : defaultAdvEq(),
    stems: snap.stems ? { ...snap.stems } : { bass: 0, drums: 0, vocal: 0, air: 0 },
  });
  pushParams(get);
}

export const useStore = create<JMasterState>()(persist((set, get) => {
  historySet = set;
  engine.onMeters((m) => {
    set({
      meters: m,
      playing: m.playing,
      playheadSec: m.playhead / engine.sampleRate,
    });
  });

  return {
    loaded: false,
    loading: false,
    loadError: null,
    source: null,
    trackPath: null,

    macros: { tone: 0, shape: 0, air: 0, smooth: 0, character: 0, density: 0, impact: 0, width: 1 },
    presetId: 'flat',
    platformId: null,
    targetLufs: -14,
    ceilingDb: -1,
    fadeInSec: 0,
    fadeOutSec: 0,
    fadeInCurve: 'smooth',
    fadeOutCurve: 'smooth',
    bypass: false,
    limiterDelta: false,
    balanceDb: 0,
    bassMono: false,
    matchEqGains: [],
    advEq: defaultAdvEq(),
    stems: { bass: 0, drums: 0, vocal: 0, air: 0 },
    advEqOpen: false,
    matchOpen: false,
    matchRef: null,
    matchLoading: false,
    masterItReport: null,
    masterItBusy: false,
    audition: { active: false, mode: 'codec' as const, busy: false },
    metronome: false,
    gridEnabled: true,
    loudnessLane: true,
    tempo: null,
    activeSlot: 'A' as const,
    snapshots: { A: null, B: null },
    diagOpen: false,
    diagIssues: [],
    diagChecks: [],
    autoFix: false,
    undoDepth: 0,
    redoDepth: 0,

    playing: false,
    playheadSec: 0,
    meters: null,

    theme: 'plate',
    waveView: 'wave',
    exportOpen: false,
    exporting: null,
    exportStats: null,
    exportSavedTo: null,
    exportFormat: 'wav',
    exportBitDepth: 24,
    exportMp3Kbps: 320,
    exportOpusKbps: 192 as const,
    exportHistory: [],
    processedView: false,
    outSplit: false,
    meta: {
      artist: '',
      album: '',
      year: String(new Date().getFullYear()),
      genre: '',
      catalog: '',
      comment: 'Mastered with J-Master · JMW Software',
    },
    toasts: [],

    batchOpen: false,
    batchItems: [],
    batchRunning: false,
    batchDir: null,

    albumOpen: false,
    albumUpc: '',
    albumGapSec: 2,
    albumAssembling: null,
    albumResult: null,

    async loadFile(data, name, path = null) {
      // Project files route through the project loader.
      if (name.toLowerCase().endsWith('.jmaster')) {
        await openProject(new TextDecoder().decode(data), set, get);
        return;
      }
      set({ loading: true, loadError: null });
      try {
        const source = await engine.loadFile(data, name);
        const { issues, checks } = deriveDiagnosis(source.diagnostics, source.balanceOffsetDb);
        set({
          loaded: true, loading: false, source, trackPath: path,
          playing: false, playheadSec: 0,
          tempo: null, balanceDb: 0, bassMono: false, metronome: false,
          diagIssues: issues, diagChecks: checks, diagOpen: false,
        });
        pushParams(get);
        get().pushToast(`LOADED ${name.toUpperCase()}`, 'run');
        const skipDiag = suppressDiagOnce;
        suppressDiagOnce = false;
        if (issues.length > 0 && !skipDiag) {
          if (get().autoFix) {
            get().applyDiagFixes();
          } else {
            set({ diagOpen: true });
          }
        }
        // Tempo detection runs in the background; the grid appears when ready.
        void engine.requestTempo().then((t) => {
          set({ tempo: t });
          pushParams(get);
        });
      } catch (err) {
        set({ loading: false, loadError: String(err) });
        get().pushToast('DECODE FAILED. UNSUPPORTED FILE.', 'fault');
      }
    },

    setMacro(key, value) {
      record(get, `macro:${key}`);
      set((s) => ({ macros: { ...s.macros, [key]: value }, presetId: null }));
      pushParams(get);
    },

    openMatch(open) {
      set({ matchOpen: open });
    },

    async loadReference() {
      const s = get();
      if (!s.loaded || s.matchLoading) return;
      // Pick the reference file (native dialog or browser input).
      const bridge = (window as any).jmaster;
      let bytes: ArrayBuffer | null = null;
      let name = '';
      if (bridge?.openFile) {
        const res = await bridge.openFile();
        if (!res || res.name.toLowerCase().endsWith('.jmaster')) return;
        bytes = res.data;
        name = res.name;
      } else {
        const picked = await new Promise<File | null>((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.wav,.flac,.mp3,.ogg,.m4a,audio/*';
          input.onchange = () => resolve(input.files?.[0] ?? null);
          input.click();
        });
        if (!picked) return;
        bytes = await picked.arrayBuffer();
        name = picked.name;
      }
      if (!bytes) return;
      set({ matchLoading: true });
      try {
        const src = await engine.requestSourceProfile();
        const { l, r } = await engine.decodeOnly(bytes);
        const ref = await engine.profileBuffers(l, r);
        if (!src) throw new Error('no source profile');
        // Shape-only delta: remove the mean so loudness stays a separate axis.
        const raw = new Array(ref.bands.length);
        let mean = 0;
        for (let i = 0; i < ref.bands.length; i++) {
          raw[i] = ref.bands[i] - src.bands[i];
          mean += raw[i];
        }
        mean /= raw.length;
        for (let i = 0; i < raw.length; i++) raw[i] -= mean;
        // Light smoothing across neighbours.
        const smoothed = raw.map((v, i) => {
          const a = raw[Math.max(0, i - 1)], b = raw[Math.min(raw.length - 1, i + 1)];
          return (a + 2 * v + b) / 4;
        });
        // Resample the 30 profile bands onto the 10 match-EQ centres, cap ±6.
        const deltaGains = MATCH_EQ_CENTERS.map((f) => {
          const pos = (Math.log(f / 20) / Math.log(1000)) * smoothed.length - 0.5;
          const i0 = Math.max(0, Math.min(smoothed.length - 1, Math.floor(pos)));
          const i1 = Math.min(smoothed.length - 1, i0 + 1);
          const t = Math.max(0, Math.min(1, pos - i0));
          const v = smoothed[i0] * (1 - t) + smoothed[i1] * t;
          return +Math.max(-6, Math.min(6, v)).toFixed(1);
        });
        // Width: side energy scales with width², so dB diff / 40 in log10.
        const suggestedWidth = +Math.max(0.7, Math.min(1.6,
          Math.pow(10, (ref.sideRatioDb - src.sideRatioDb) / 40))).toFixed(2);
        set({
          matchRef: { name, lufs: ref.lufs, sideRatioDb: ref.sideRatioDb, deltaGains, suggestedWidth },
          matchLoading: false,
        });
      } catch (err) {
        set({ matchLoading: false });
        get().pushToast('REFERENCE ANALYSIS FAILED', 'fault');
      }
    },

    applyMatch() {
      const s = get();
      if (!s.matchRef) return;
      record(get, 'match');
      set((st) => ({
        matchEqGains: [...s.matchRef!.deltaGains],
        targetLufs: Math.max(-24, Math.min(-6, +s.matchRef!.lufs.toFixed(1))),
        macros: { ...st.macros, width: s.matchRef!.suggestedWidth },
        presetId: null,
        platformId: null,
        matchOpen: false,
      }));
      pushParams(get);
      get().pushToast(`MATCHED TO ${s.matchRef.name.toUpperCase()}`, 'run');
    },

    clearMatch() {
      record(get, 'match');
      set({ matchEqGains: [], matchRef: null });
      pushParams(get);
    },

    setAdvEqOpen(open) {
      set({ advEqOpen: open });
    },

    setAdvBand(index, patch) {
      record(get, `adveq:${index}`);
      set((s) => ({
        advEq: s.advEq.map((b, i) => (i === index ? { ...b, ...patch } : b)),
      }));
      pushParams(get);
    },

    resetAdvEq() {
      record(get, 'adveq-reset');
      set({ advEq: defaultAdvEq() });
      pushParams(get);
    },

    setStem(lane, db) {
      record(get, `stem:${lane}`);
      set((s) => ({ stems: { ...s.stems, [lane]: Math.max(-3, Math.min(3, db)) } }));
      pushParams(get);
    },

    async startAudition() {
      const s = get();
      if (!s.loaded || s.audition.busy) return;
      if (s.exportFormat !== 'mp3' && s.exportFormat !== 'opus') return;
      const excerpt = engine.getExcerpt();
      if (!excerpt || !s.source) return;
      set({ audition: { active: false, mode: 'codec', busy: true } });
      try {
        const params = { ...chainParamsFrom(s), fadeInSec: 0, fadeOutSec: 0 };
        const dur = excerpt.l.length / engine.sampleRate;
        // The same mastered excerpt, once lossless and once through the codec.
        const wav = await engine.renderBuffers(
          excerpt.l, excerpt.r, params, s.source.lufs, dur,
          { format: 'wav', bitDepth: 24, mp3Kbps: 320 });
        const codec = await engine.renderBuffers(
          excerpt.l, excerpt.r, params, s.source.lufs, dur,
          encodeOptionsFrom(s));
        const masterBuf = await engine.decodeToBuffer(wav.data);
        const codecBuf = await engine.decodeToBuffer(codec.data);
        await engine.auditionStart(masterBuf, codecBuf);
        set({ audition: { active: true, mode: 'codec', busy: false } });
      } catch {
        set({ audition: { active: false, mode: 'codec', busy: false } });
        get().pushToast('AUDITION FAILED', 'fault');
      }
    },

    setAuditionMode(mode) {
      engine.auditionSetMode(mode);
      set((s) => ({ audition: { ...s.audition, mode } }));
    },

    stopAudition() {
      engine.auditionStop();
      set({ audition: { active: false, mode: 'codec', busy: false } });
    },

    openAlbum(open) {
      set({ albumOpen: open, albumResult: open ? null : get().albumResult });
    },

    setAlbumUpc(upc) {
      set({ albumUpc: upc.replace(/\D/g, '').slice(0, 13) });
    },

    setAlbumGap(sec) {
      set({ albumGapSec: Math.max(0, Math.min(5, +sec.toFixed(1))) });
    },

    setItemIsrc(id, isrc) {
      const clean = isrc.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
      set((s) => ({
        batchItems: s.batchItems.map((it) => (it.id === id ? { ...it, isrc: clean } : it)),
      }));
    },

    moveBatchItem(id, delta) {
      set((s) => {
        const idx = s.batchItems.findIndex((it) => it.id === id);
        const to = idx + delta;
        if (idx < 0 || to < 0 || to >= s.batchItems.length) return {};
        const items = [...s.batchItems];
        const [moved] = items.splice(idx, 1);
        items.splice(to, 0, moved);
        return { batchItems: items };
      });
    },

    async assembleAlbum() {
      const s = get();
      const bridge = (window as any).jmaster;
      if (!bridge?.appendFile || !bridge?.patchFile || !bridge?.writeFileNew) {
        get().pushToast('ALBUM ASSEMBLY NEEDS THE DESKTOP APP', 'fault');
        return;
      }
      if (s.batchItems.length === 0 || s.albumAssembling) return;
      if (!s.batchDir) {
        await get().chooseBatchDir();
        if (!get().batchDir) return;
      }
      const dir = get().batchDir!;
      const items = get().batchItems;
      const albumTitle = s.meta.album || 'Album';
      const performer = s.meta.artist || 'Unknown Artist';
      const params = chainParamsFrom(s);
      const gapFrames = Math.round(s.albumGapSec * 75);
      const FRAME_SAMPLES = 588;

      const setPhase = (phase: string, pct: number) => set({ albumAssembling: { phase, pct } });
      setPhase('STARTING', 0);
      try {
        // WAV header placeholder — sizes patched at the end.
        const header = new ArrayBuffer(44);
        {
          const v = new DataView(header);
          const ws = (o: number, str: string) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
          ws(0, 'RIFF'); v.setUint32(4, 0, true); ws(8, 'WAVE');
          ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
          v.setUint32(24, 44100, true); v.setUint32(28, 44100 * 4, true);
          v.setUint16(32, 4, true); v.setUint16(34, 16, true);
          ws(36, 'data'); v.setUint32(40, 0, true);
        }
        const imagePath: string = await bridge.writeFileNew(dir, `${albumTitle} — CD Image.wav`, header);

        let totalSamples = 0;
        const cueTracks: { title: string; isrc?: string; startFrame: number; lengthSec: number }[] = [];

        for (let idx = 0; idx < items.length; idx++) {
          const item = items[idx];
          const src = batchSources.get(item.id);
          if (!src) continue;
          const base = (idx / items.length);
          setPhase(`TRACK ${idx + 1}/${items.length} · RENDERING`, base);
          const bytes: ArrayBuffer = src.path
            ? await bridge.readFileByPath(src.path)
            : await src.file!.arrayBuffer();
          const { l, r, durationSec } = await engine.decodeOnly(bytes);
          const lufs = item.lufs ?? (await engine.measureLufs(l, r));

          let itemParams = params;
          const override = item.presetId ? PRESETS.find((p) => p.id === item.presetId) : null;
          if (override) {
            itemParams = { ...params, ...override.macros, targetLufs: override.targetLufs, ceilingDb: override.ceilingDb };
          }
          if (item.fixesEnabled && item.fixes && item.fixes.length > 0) {
            itemParams = { ...itemParams };
            for (const fix of item.fixes) {
              switch (fix.action.type) {
                case 'bassMono': itemParams.bassMono = true; break;
                case 'width': itemParams.width = Math.min(itemParams.width, fix.action.value); break;
                case 'smooth': itemParams.smooth = Math.max(itemParams.smooth, fix.action.value); break;
                case 'balance': itemParams.balanceDb = Math.max(-3, Math.min(3, -(item.balanceOffsetDb ?? 0))); break;
              }
            }
          }
          const rendered = await engine.renderBuffers(
            l, r, itemParams, lufs, durationSec,
            { format: 'wav', bitDepth: 24, mp3Kbps: 320 },
            (p) => setPhase(`TRACK ${idx + 1}/${items.length} · ${p.phase}`, base + (p.pct * 0.7) / items.length),
          );

          setPhase(`TRACK ${idx + 1}/${items.length} · 44.1K CONVERT`, base + 0.75 / items.length);
          // Resample the mastered track to CD rate via Chromium's decoder.
          const cdLen = Math.ceil((rendered.data.byteLength / 6 / 48000) * 44100) + 4410;
          const ctx = new OfflineAudioContext(2, cdLen, 44100);
          const dec = await ctx.decodeAudioData(rendered.data.slice(0));
          const cl = dec.getChannelData(0);
          const cr = dec.numberOfChannels > 1 ? dec.getChannelData(1) : cl;
          const nS = dec.length;
          const padded = Math.ceil(nS / FRAME_SAMPLES) * FRAME_SAMPLES;
          const pcm = new ArrayBuffer(padded * 4);
          const pv = new DataView(pcm);
          for (let i = 0; i < nS; i++) {
            const dl = (Math.random() + Math.random() - 1) / 32767;
            const dr = (Math.random() + Math.random() - 1) / 32767;
            pv.setInt16(i * 4, Math.max(-32768, Math.min(32767, Math.round((cl[i] + dl) * 32767))), true);
            pv.setInt16(i * 4 + 2, Math.max(-32768, Math.min(32767, Math.round((cr[i] + dr) * 32767))), true);
          }
          setPhase(`TRACK ${idx + 1}/${items.length} · WRITING`, base + 0.9 / items.length);
          cueTracks.push({
            title: item.name.replace(/\.[^.]+$/, ''),
            isrc: item.isrc,
            startFrame: totalSamples / FRAME_SAMPLES,
            lengthSec: padded / 44100,
          });
          // Stream to disk in 4 MB slices to bound memory.
          for (let off = 0; off < pcm.byteLength; off += 4 << 20) {
            await bridge.appendFile(imagePath, pcm.slice(off, Math.min(pcm.byteLength, off + (4 << 20))));
          }
          totalSamples += padded;
          if (idx < items.length - 1 && gapFrames > 0) {
            await bridge.appendFile(imagePath, new ArrayBuffer(gapFrames * FRAME_SAMPLES * 4));
            totalSamples += gapFrames * FRAME_SAMPLES;
          }
        }

        // Patch the RIFF/data sizes.
        setPhase('FINALISING IMAGE', 0.96);
        const dataSize = totalSamples * 4;
        const riff = new ArrayBuffer(4);
        new DataView(riff).setUint32(0, 36 + dataSize, true);
        await bridge.patchFile(imagePath, 4, riff);
        const dsz = new ArrayBuffer(4);
        new DataView(dsz).setUint32(0, dataSize, true);
        await bridge.patchFile(imagePath, 40, dsz);

        // CUE sheet with CD-TEXT.
        const mmssff = (frame: number) => {
          const ff = frame % 75;
          const totalSec = Math.floor(frame / 75);
          const mm = Math.floor(totalSec / 60);
          const ss = totalSec % 60;
          return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
        };
        const imageFile = imagePath.split(/[\\/]/).pop()!;
        let cue = '';
        if (s.albumUpc.length === 13) cue += `CATALOG ${s.albumUpc}\n`;
        cue += `TITLE "${albumTitle}"\nPERFORMER "${performer}"\nFILE "${imageFile}" WAVE\n`;
        cueTracks.forEach((t, i) => {
          cue += `  TRACK ${String(i + 1).padStart(2, '0')} AUDIO\n`;
          cue += `    TITLE "${t.title}"\n`;
          cue += `    PERFORMER "${performer}"\n`;
          if (t.isrc && t.isrc.length === 12) cue += `    ISRC ${t.isrc}\n`;
          cue += `    INDEX 01 ${mmssff(t.startFrame)}\n`;
        });
        const enc = new TextEncoder();
        const cuePath: string = await bridge.writeFileNew(dir, `${albumTitle}.cue`, enc.encode(cue).buffer);

        // Manifest.
        let manifest = `${albumTitle} — ${performer}\nAssembled by J-Master (JMW Software)\n`;
        manifest += `Image: ${imageFile} · 44.1 kHz / 16-bit · ${(totalSamples / 44100 / 60).toFixed(1)} min\n`;
        if (s.albumUpc) manifest += `UPC/EAN: ${s.albumUpc}\n`;
        manifest += `\n`;
        cueTracks.forEach((t, i) => {
          manifest += `${String(i + 1).padStart(2, '0')}  ${mmssff(t.startFrame)}  ${t.title}${t.isrc ? `  [${t.isrc}]` : ''}\n`;
        });
        await bridge.writeFileNew(dir, `${albumTitle} — manifest.txt`, enc.encode(manifest).buffer);

        set({
          albumAssembling: null,
          albumResult: { imagePath, cuePath, totalMin: totalSamples / 44100 / 60 },
        });
        get().pushToast(`CD IMAGE ASSEMBLED · ${cueTracks.length} TRACKS`, 'run');
      } catch (err) {
        set({ albumAssembling: null });
        get().pushToast(`ASSEMBLY FAILED · ${String(err).slice(0, 60)}`, 'fault');
      }
    },

    async masterIt() {
      const s = get();
      if (!s.loaded || s.masterItBusy) return;
      set({ masterItBusy: true });
      try {
        const tempo = await engine.requestTempo();
        const prof = await engine.requestSourceProfile();
        const reasons: string[] = [];
        // Spectral shares relative to the overall mean.
        let presetPick = 'pop';
        if (prof) {
          const bands = prof.bands;
          const mean = bands.reduce((a, b) => a + b, 0) / bands.length;
          const bandAt = (fLo: number, fHi: number) => {
            let sum = 0, cnt = 0;
            for (let i = 0; i < bands.length; i++) {
              const f = 20 * Math.pow(1000, (i + 0.5) / bands.length);
              if (f >= fLo && f < fHi) { sum += bands[i]; cnt++; }
            }
            return cnt > 0 ? sum / cnt - mean : -60;
          };
          const subDb = bandAt(20, 90);
          const brightDb = bandAt(6000, 16000);
          const midDb = bandAt(250, 2000);
          const bpm = tempo?.bpm ?? 0;
          reasons.push(`TEMPO ${bpm > 0 ? bpm.toFixed(1) + ' BPM' : 'UNCLEAR'}`);
          reasons.push(`SUB ${subDb >= 0 ? '+' : ''}${subDb.toFixed(1)} dB · BRIGHT ${brightDb >= 0 ? '+' : ''}${brightDb.toFixed(1)} dB · MID ${midDb >= 0 ? '+' : ''}${midDb.toFixed(1)} dB`);
          if (bpm >= 155 && subDb > 2) { presetPick = 'dnb'; reasons.push('FAST + SUB-HEAVY → DRUM & BASS'); }
          else if (bpm >= 118 && bpm <= 138 && subDb > 1.5) { presetPick = 'house'; reasons.push('CLUB TEMPO + SUB → EDM / HOUSE'); }
          else if (bpm >= 95 && bpm < 118 && subDb > 1.5) { presetPick = 'electronic'; reasons.push('MID TEMPO + SUB → ELECTRONIC'); }
          else if (bpm >= 80 && bpm <= 108 && subDb > 3.5) { presetPick = 'hiphop'; reasons.push('SUB-DOMINANT GROOVE → HIP-HOP'); }
          else if (bpm > 0 && bpm < 92 && brightDb < -5) { presetPick = 'rnb'; reasons.push('SLOW + DARK TOP → R&B'); }
          else if (brightDb > 1.5 && bpm >= 100 && bpm <= 145) { presetPick = 'pop'; reasons.push('BRIGHT + POP TEMPO → POP'); }
          else if (midDb > 1) { presetPick = 'rock'; reasons.push('MID-FORWARD → ROCK'); }
          else { presetPick = 'pop'; reasons.push('NO STRONG SIGNATURE → POP (SAFE)'); }
        } else {
          reasons.push('NO PROFILE — POP (SAFE)');
        }
        const preset = PRESETS.find((p) => p.id === presetPick)!;
        record(get, 'masterit');
        get().applyPreset(presetPick);
        reasons.push(`PRESET ${preset.name} · TARGET ${preset.targetLufs} LUFS`);
        // Apply every diagnosed fix.
        const issues = get().diagIssues;
        if (issues.length > 0) {
          set((st) => ({ diagIssues: st.diagIssues.map((i) => ({ ...i, checked: true })) }));
          get().applyDiagFixes();
          reasons.push(`FIXES ${issues.map((i) => i.fixLabel).join(' · ')}`);
        } else {
          reasons.push('SOURCE CHECKS CLEAN — NO FIXES NEEDED');
        }
        set({ masterItReport: { presetName: preset.name, reasons }, masterItBusy: false });
      } catch {
        set({ masterItBusy: false });
        get().pushToast('AUTO-MASTER FAILED', 'fault');
      }
    },

    closeMasterItReport() {
      set({ masterItReport: null });
    },

    undo() {
      const entry = undoStack.pop();
      if (!entry) return;
      redoStack.push({ snap: captureConsole(get()), field: entry.field, at: Date.now() });
      applyConsole(entry.snap, set, get);
      set({ undoDepth: undoStack.length, redoDepth: redoStack.length });
    },

    redo() {
      const entry = redoStack.pop();
      if (!entry) return;
      undoStack.push({ snap: captureConsole(get()), field: entry.field, at: Date.now() });
      applyConsole(entry.snap, set, get);
      set({ undoDepth: undoStack.length, redoDepth: redoStack.length });
    },

    applyPreset(id) {
      const preset = PRESETS.find((p) => p.id === id);
      if (!preset) return;
      record(get, 'preset');
      set((s) => ({
        macros: { ...preset.macros },
        targetLufs: preset.targetLufs,
        ceilingDb: preset.ceilingDb,
        presetId: id,
        platformId: null,
        // Genre tag follows the preset (still editable in the export dialog).
        meta: id === 'flat' ? s.meta : { ...s.meta, genre: preset.genre ?? titleCase(preset.name) },
      }));
      pushParams(get);
    },

    applyPlatform(id) {
      const platform = PLATFORMS.find((p) => p.id === id);
      if (!platform) return;
      record(get, 'platform');
      set({ targetLufs: platform.targetLufs, ceilingDb: platform.ceilingDb, platformId: id });
      pushParams(get);
    },

    nudgeTarget(delta) {
      record(get, 'target');
      set((s) => ({
        targetLufs: Math.max(-24, Math.min(-6, +(s.targetLufs + delta).toFixed(1))),
        platformId: null,
      }));
      pushParams(get);
    },

    nudgeCeiling(delta) {
      record(get, 'ceiling');
      set((s) => ({
        ceilingDb: Math.max(-3, Math.min(-0.1, +(s.ceilingDb + delta).toFixed(1))),
        platformId: null,
      }));
      pushParams(get);
    },

    setFade(which, sec) {
      record(get, `fade:${which}`);
      const dur = get().source?.durationSec ?? 60;
      const clamped = Math.max(0, Math.min(dur / 2, sec));
      set(which === 'in' ? { fadeInSec: clamped } : { fadeOutSec: clamped });
      pushParams(get);
    },

    setFadeCurve(which, curve) {
      record(get, 'fadecurve');
      set(which === 'in' ? { fadeInCurve: curve } : { fadeOutCurve: curve });
      pushParams(get);
    },

    setBypass(on) {
      set({ bypass: on });
      pushParams(get);
    },

    setLimiterDelta(on) {
      set({ limiterDelta: on });
      pushParams(get);
    },

    setBalance(db) {
      record(get, 'balance');
      set({ balanceDb: Math.max(-3, Math.min(3, +db.toFixed(1))) });
      pushParams(get);
    },

    autoCenter() {
      record(get, 'autocenter');
      const off = get().source?.balanceOffsetDb ?? 0;
      set({ balanceDb: Math.max(-3, Math.min(3, +(-off).toFixed(1))) });
      pushParams(get);
      get().pushToast(`IMAGE CENTERED · ${off >= 0 ? 'R' : 'L'} WAS ${Math.abs(off).toFixed(1)} DB HOT`, 'run');
    },

    setMetronome(on) {
      set({ metronome: on });
      pushParams(get);
    },

    setGridEnabled(on) {
      set({ gridEnabled: on });
    },

    setLoudnessLane(on) {
      set({ loudnessLane: on });
    },

    openDiag(open) {
      set({ diagOpen: open });
    },

    toggleDiagIssue(id) {
      set((s) => ({
        diagIssues: s.diagIssues.map((i) => (i.id === id ? { ...i, checked: !i.checked } : i)),
      }));
    },

    setAutoFix(on) {
      set({ autoFix: on });
    },

    applyDiagFixes() {
      record(get, 'diagfix');
      const s = get();
      const applied: string[] = [];
      for (const issue of s.diagIssues) {
        if (!issue.checked) continue;
        switch (issue.action.type) {
          case 'bassMono':
            set({ bassMono: true });
            break;
          case 'width':
            set((st) => ({ macros: { ...st.macros, width: (issue.action as any).value }, presetId: null }));
            break;
          case 'balance':
            set({ balanceDb: Math.max(-3, Math.min(3, +(-s.source!.balanceOffsetDb).toFixed(1))) });
            break;
          case 'smooth':
            set((st) => ({
              macros: { ...st.macros, smooth: Math.max(st.macros.smooth, (issue.action as any).value) },
              presetId: null,
            }));
            break;
        }
        applied.push(issue.fixLabel);
      }
      set({ diagOpen: false });
      pushParams(get);
      if (applied.length > 0) {
        get().pushToast(`${applied.length} FIX${applied.length > 1 ? 'ES' : ''} APPLIED · ${applied.join(' · ')}`, 'run');
      }
    },

    switchSlot(slot) {
      const s = get();
      if (slot === s.activeSlot) return;
      record(get, 'slot');
      const current: ConsoleSnapshot = {
        macros: { ...s.macros },
        targetLufs: s.targetLufs,
        ceilingDb: s.ceilingDb,
        balanceDb: s.balanceDb,
        presetId: s.presetId,
        platformId: s.platformId,
      };
      const incoming = s.snapshots[slot];
      set({
        snapshots: { ...s.snapshots, [s.activeSlot]: current },
        activeSlot: slot,
        ...(incoming
          ? {
              macros: { ...incoming.macros },
              targetLufs: incoming.targetLufs,
              ceilingDb: incoming.ceilingDb,
              balanceDb: incoming.balanceDb,
              presetId: incoming.presetId,
              platformId: incoming.platformId,
            }
          : {}),
      });
      pushParams(get);
    },

    togglePlay() {
      if (!get().loaded) return;
      if (get().playing) {
        engine.pause();
        set({ playing: false });
      } else {
        void engine.play();
        set({ playing: true });
      }
    },

    stop() {
      engine.stop();
      set({ playing: false, playheadSec: 0 });
    },

    seekSec(sec) {
      engine.seekSec(sec);
      set({ playheadSec: sec });
    },

    setTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      set({ theme });
    },

    setWaveView(view) {
      set({ waveView: view });
    },

    openExport(open) {
      set({ exportOpen: open, exportStats: open ? null : get().exportStats, exportSavedTo: null });
      if (!open) set({ exporting: null });
    },

    setExportFormat(format) { set({ exportFormat: format }); },
    setExportBitDepth(depth) { set({ exportBitDepth: depth }); },
    setExportMp3Kbps(kbps) { set({ exportMp3Kbps: kbps }); },
    setExportOpusKbps(kbps) { set({ exportOpusKbps: kbps }); },

    async saveProject() {
      const s = get();
      const proj: ProjectFile = {
        app: 'J-Master',
        fileVersion: 1,
        savedAt: new Date().toISOString(),
        track: s.source ? { name: s.source.name, path: s.trackPath } : null,
        console: captureConsole(s),
        snapshots: s.snapshots,
        activeSlot: s.activeSlot,
        meta: s.meta,
        export: {
          format: s.exportFormat, bitDepth: s.exportBitDepth,
          mp3Kbps: s.exportMp3Kbps, opusKbps: s.exportOpusKbps,
        },
        batch: {
          dir: s.batchDir,
          items: s.batchItems.map((it) => ({
            name: it.name,
            path: batchSources.get(it.id)?.path ?? null,
            presetId: it.presetId ?? null,
            isrc: it.isrc,
          })),
        },
      };
      const json = JSON.stringify(proj, null, 2);
      const base = s.source ? s.source.name.replace(/\.[^.]+$/, '') : 'session';
      const bridge = (window as any).jmaster;
      if (bridge?.saveProjectFile) {
        const saved = await bridge.saveProjectFile(`${base}.jmaster`, json);
        if (saved) get().pushToast('PROJECT SAVED', 'run');
      } else {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${base}.jmaster`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        get().pushToast('PROJECT SAVED', 'run');
      }
    },
    setMeta(field, value) {
      set((s) => ({ meta: { ...s.meta, [field]: value } }));
    },

    startExport(fileName, title) {
      const s = get();
      if (!s.loaded || s.exporting) return;
      set({ exporting: { phase: 'STARTING', pct: 0 }, exportStats: null, exportSavedTo: null });
      engine.startExport(
        chainParamsFrom(s),
        { ...encodeOptionsFrom(s), tags: tagsFrom(s, title) },
        (p) => set({ exporting: p }),
        async (result) => {
          set({ exporting: { phase: 'SAVING', pct: 0.98 } });
          const saved = await saveExportFile(result.data, fileName, result.mime);
          set({ exporting: null, exportStats: result.stats, exportSavedTo: saved });
          if (saved) {
            const entry: ExportHistoryEntry = {
              name: fileName,
              path: saved.includes('\\') || saved.includes('/') ? saved : null,
              format: result.stats.format,
              bytes: result.stats.bytes,
              lufs: result.stats.integratedLufs,
              truePeakDb: result.stats.truePeakDb,
              when: new Date().toISOString(),
            };
            set((s2) => ({ exportHistory: [entry, ...s2.exportHistory].slice(0, 20) }));
          }
          get().pushToast(saved ? `MASTER SAVED` : 'EXPORT CANCELLED', saved ? 'run' : 'info');
        },
      );
    },

    openBatch(open) {
      set({ batchOpen: open });
    },

    async addBatchFiles() {
      const bridge = (window as any).jmaster;
      if (bridge?.pickFiles) {
        const picked = await bridge.pickFiles();
        if (!picked) return;
        const items: BatchItem[] = picked.map((p: { name: string; path: string }) => {
          const id = batchSeq++;
          batchSources.set(id, { path: p.path });
          return { id, name: p.name, status: 'pending' as BatchStatus, pct: 0, phase: '' };
        });
        set((s) => ({ batchItems: [...s.batchItems, ...items] }));
        void scanBatchItems(set as any, get);
        return;
      }
      // Browser fallback: multi-select input.
      await new Promise<void>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.wav,.flac,.mp3,.ogg,.m4a,audio/*';
        input.onchange = () => {
          get().addBatchDroppedFiles(Array.from(input.files ?? []));
          resolve();
        };
        input.click();
      });
    },

    addBatchDroppedFiles(files) {
      const items: BatchItem[] = files.map((f) => {
        const id = batchSeq++;
        batchSources.set(id, { file: f, path: (f as any).path ?? undefined });
        return { id, name: f.name, status: 'pending' as BatchStatus, pct: 0, phase: '' };
      });
      set((s) => ({ batchItems: [...s.batchItems, ...items] }));
      void scanBatchItems(set as any, get);
    },

    setOutSplit(on) {
      set({ outSplit: on });
    },

    setProcessedView(on) {
      set({ processedView: on });
      if (on) {
        engine.scheduleProcessedPreview(chainParamsFrom(get()), 100);
      } else {
        engine.clearProcessedPreview();
      }
    },

    toggleItemFixes(id) {
      set((s) => ({
        batchItems: s.batchItems.map((it) =>
          it.id === id ? { ...it, fixesEnabled: !it.fixesEnabled } : it),
      }));
    },

    setBatchItemPreset(id, presetId) {
      set((s) => ({
        batchItems: s.batchItems.map((it) => (it.id === id ? { ...it, presetId } : it)),
      }));
    },

    clearBatch() {
      if (get().batchRunning) return;
      batchSources.clear();
      set({ batchItems: [] });
    },

    async chooseBatchDir() {
      const bridge = (window as any).jmaster;
      if (bridge?.chooseDirectory) {
        const dir = await bridge.chooseDirectory();
        if (dir) set({ batchDir: dir });
      }
    },

    async startBatch() {
      const s = get();
      if (s.batchRunning || s.batchItems.length === 0) return;
      batchCancelled = false;
      set({ batchRunning: true });
      const params = chainParamsFrom(s);
      const encode = encodeOptionsFrom(s);
      const bridge = (window as any).jmaster;

      const patch = (id: number, p: Partial<BatchItem>) =>
        set((st) => ({
          batchItems: st.batchItems.map((it) => (it.id === id ? { ...it, ...p } : it)),
        }));

      for (const item of get().batchItems) {
        if (batchCancelled) break;
        if (item.status === 'done') continue;
        const src = batchSources.get(item.id);
        if (!src) continue;
        try {
          patch(item.id, { status: 'working', phase: 'READING', pct: 0.02 });
          const bytes: ArrayBuffer = src.path
            ? await bridge.readFileByPath(src.path)
            : await src.file!.arrayBuffer();

          patch(item.id, { phase: 'DECODING', pct: 0.06 });
          const { l, r, durationSec } = await engine.decodeOnly(bytes);

          // Reuse the pre-scan's loudness when available.
          let lufs = item.lufs;
          if (lufs === undefined) {
            patch(item.id, { phase: 'ANALYSING', pct: 0.12 });
            lufs = await engine.measureLufs(l, r);
          }

          const idx = get().batchItems.findIndex((it) => it.id === item.id);
          const trackTags = tagsFrom(
            get(),
            item.name.replace(/\.[^.]+$/, ''),
            idx + 1,
            get().batchItems.length,
          );
          // Per-track preset override: swap in the preset's macros + targets.
          let itemParams = params;
          const override = item.presetId ? PRESETS.find((p) => p.id === item.presetId) : null;
          if (override) {
            itemParams = {
              ...params,
              ...override.macros,
              targetLufs: override.targetLufs,
              ceilingDb: override.ceilingDb,
            };
            if (override.id !== 'flat') trackTags.genre = override.genre ?? titleCase(override.name);
          }
          // Per-track diagnosed fixes from the pre-scan.
          if (item.fixesEnabled && item.fixes && item.fixes.length > 0) {
            itemParams = { ...itemParams };
            for (const fix of item.fixes) {
              switch (fix.action.type) {
                case 'bassMono': itemParams.bassMono = true; break;
                case 'width': itemParams.width = Math.min(itemParams.width, fix.action.value); break;
                case 'smooth': itemParams.smooth = Math.max(itemParams.smooth, fix.action.value); break;
                case 'balance':
                  itemParams.balanceDb = Math.max(-3, Math.min(3, -(item.balanceOffsetDb ?? 0)));
                  break;
              }
            }
          }
          const result = await engine.renderBuffers(
            l, r, itemParams, lufs, durationSec, { ...encode, tags: trackTags },
            (p) => patch(item.id, { phase: p.phase, pct: 0.15 + p.pct * 0.8 }),
          );

          patch(item.id, { phase: 'SAVING', pct: 0.97 });
          const outName = masterFileName(item.name, encode);
          let outPath: string | null;
          if (bridge?.saveFileTo && get().batchDir) {
            outPath = await bridge.saveFileTo(get().batchDir, outName, result.data);
          } else {
            outPath = await saveExportFile(result.data, outName, result.mime);
          }
          patch(item.id, {
            status: 'done', pct: 1, phase: 'DONE',
            outLufs: result.stats.integratedLufs,
            outPath: outPath ?? undefined,
          });
          if (outPath) {
            const entry: ExportHistoryEntry = {
              name: outName,
              path: outPath.includes('\\') || outPath.includes('/') ? outPath : null,
              format: result.stats.format,
              bytes: result.stats.bytes,
              lufs: result.stats.integratedLufs,
              truePeakDb: result.stats.truePeakDb,
              when: new Date().toISOString(),
            };
            set((s2) => ({ exportHistory: [entry, ...s2.exportHistory].slice(0, 20) }));
          }
        } catch (err) {
          patch(item.id, { status: 'failed', phase: 'FAILED', error: String(err) });
        }
      }
      set({ batchRunning: false });
      const done = get().batchItems.filter((i) => i.status === 'done').length;
      get().pushToast(
        batchCancelled ? `BATCH STOPPED · ${done} DONE` : `BATCH COMPLETE · ${done} MASTERED`,
        batchCancelled ? 'info' : 'run',
      );
    },

    cancelBatch() {
      batchCancelled = true;
    },

    pushToast(text, kind = 'info') {
      const id = toastSeq++;
      set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
      setTimeout(() => get().dismissToast(id), 4200);
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
  };
}, {
  name: 'jmaster-settings',
  version: 1,
  // Persist preferences and the console; never transport, meters, or dialogs.
  partialize: (s) => ({
    theme: s.theme,
    waveView: s.waveView,
    gridEnabled: s.gridEnabled,
    loudnessLane: s.loudnessLane,
    outSplit: s.outSplit,
    activeSlot: s.activeSlot,
    snapshots: s.snapshots,
    autoFix: s.autoFix,
    exportOpusKbps: s.exportOpusKbps,
    exportHistory: s.exportHistory,
    albumUpc: s.albumUpc,
    albumGapSec: s.albumGapSec,
    exportFormat: s.exportFormat,
    exportBitDepth: s.exportBitDepth,
    exportMp3Kbps: s.exportMp3Kbps,
    meta: s.meta,
    macros: s.macros,
    presetId: s.presetId,
    platformId: s.platformId,
    targetLufs: s.targetLufs,
    ceilingDb: s.ceilingDb,
    batchDir: s.batchDir,
  }) as Partial<JMasterState> as JMasterState,
  onRehydrateStorage: () => (state) => {
    if (state?.theme) document.documentElement.setAttribute('data-theme', state.theme);
  },
}));

async function saveExportFile(data: ArrayBuffer, fileName: string, mime: string): Promise<string | null> {
  const bridge = (window as any).jmaster;
  if (bridge?.saveFile) {
    return await bridge.saveFile(fileName, data);
  }
  // Browser fallback: download.
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return fileName;
}
