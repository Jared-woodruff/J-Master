import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  ChainParams, FadeCurve, MacroValues, MonitorMode, PRESETS, PLATFORMS,
  defaultParams, defaultAdvEq, AdvEqBand, MATCH_EQ_CENTERS,
  type ClipMode, type SourceFix,
} from '../audio/dsp/params';
import {
  engine, MeterFrame, SourceInfo, ExportStats, ExportProgress,
  type MasterEstimate, type RenderReport,
} from '../audio/engine';
import type { TempoInfo } from '../audio/engine';
import {
  EXPORT_RATES,
  type EncodeOptions, type ExportFormat, type ExportBitDepth, type ExportRate, type DitherKind, type TrackTags,
} from '../audio/encode';
import { filePathOf } from '../lib/filepath';
import { bpmText, driftRange, mmss } from '../lib/tempo-text';
import { scaleTempo } from '../lib/tempo-scale';
import { buildReport } from '../lib/report';
import {
  ConsoleSnapshot, ConsoleState, TrackCorrections, UserPreset, StemTrims,
  NO_CORRECTIONS, NEUTRAL_MACROS, MACRO_RANGE, AMOUNT_RANGE,
  scaleMacros, findPreset, consoleMatchesPreset, presetGenre,
  num, cleanAdvEq, cleanConsole, cleanCorrections, cleanSnapshot, cleanUserPreset, cleanMeta,
} from './console';
import {
  DiagIssue, DiagCheck, DriftRepair, TEMPO_CHECK, deriveDiagnosis, tempoCheck, fixApplied,
} from './diagnosis';
import {
  masterFileName, withFormatExt, companionFileName, folderOf, isPath, baseName, isNetworkPath, fileErrorText,
  asciiFileName, latin1, ean13, ISRC_RE, buildCue, mmssff,
  CD_MAX_TRACKS, CD_MIN_TRACK_SEC, CD_MAX_SEC, CD_FRAME_SAMPLES,
} from './files';
import { debouncedStorage } from './storage';

// The pure parts live in their own modules; these names are what the
// components have always imported from here.
export { findPreset, consoleMatchesPreset, summarizeMacros } from './console';
export type { ConsoleSnapshot, ConsoleState, UserPreset } from './console';
export { TEMPO_CHECK, fixApplied } from './diagnosis';
export type { DiagIssue, DiagCheck, DriftRepair } from './diagnosis';
export { masterFileName, withFormatExt, companionFileName, ean13, ISRC_RE } from './files';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'run' | 'warn' | 'fault';
}

type Slot = 'A' | 'B';

function captureSound(s: JMasterState): ConsoleSnapshot {
  return {
    macros: { ...s.macros },
    targetLufs: s.targetLufs,
    ceilingDb: s.ceilingDb,
    presetId: s.presetId,
    lastPresetId: s.lastPresetId,
    presetAmount: s.presetAmount,
    platformId: s.platformId,
    clipMode: s.clipMode,
    advEq: s.advEq.map((b) => ({ ...b })),
    stems: { ...s.stems },
  };
}

function captureCorrections(s: JMasterState): TrackCorrections {
  return {
    balanceDb: s.balanceDb,
    bassMono: s.bassMono,
    sourceFix: s.sourceFix,
    matchEqGains: [...s.matchEqGains],
    airRestore: s.airRestore,
    airRestoreHz: s.airRestoreHz,
    trimStartSec: s.trimStartSec,
    trimEndSec: s.trimEndSec,
    fadeInSec: s.fadeInSec,
    fadeOutSec: s.fadeOutSec,
    fadeInCurve: s.fadeInCurve,
    fadeOutCurve: s.fadeOutCurve,
  };
}

function captureConsole(s: JMasterState): ConsoleState {
  const sound = captureSound(s);
  return {
    ...captureCorrections(s),
    macros: sound.macros,
    targetLufs: sound.targetLufs,
    ceilingDb: sound.ceilingDb,
    presetId: sound.presetId,
    lastPresetId: s.lastPresetId,
    presetAmount: s.presetAmount,
    platformId: sound.platformId,
    clipMode: s.clipMode,
    advEq: sound.advEq!,
    stems: sound.stems!,
  };
}

/** The store fields a sound snapshot sets (an A/B slot coming in). */
function soundPatch(snap: ConsoleSnapshot): Partial<JMasterState> {
  return {
    macros: { ...snap.macros },
    targetLufs: snap.targetLufs,
    ceilingDb: snap.ceilingDb,
    presetId: snap.presetId,
    ...(snap.lastPresetId !== undefined ? { lastPresetId: snap.lastPresetId } : snap.presetId ? { lastPresetId: snap.presetId } : {}),
    presetAmount: snap.presetAmount ?? 1,
    platformId: snap.platformId,
    clipMode: snap.clipMode ?? 'off',
    advEq: snap.advEq ? snap.advEq.map((b) => ({ ...b })) : defaultAdvEq(),
    stems: snap.stems ? { ...snap.stems } : { bass: 0, drums: 0, vocal: 0, air: 0 },
  };
}

interface HistoryEntry {
  snap: ConsoleState;
  /** Which control produced the entry — continuous gestures collapse. */
  field: string;
  at: number;
  /** Kept as the entry moves between undo and redo: one step, one id. */
  id: number;
  /** The A/B slot the step was made in: undoing it goes back there first. */
  slot: Slot;
  /**
   * The genre tag to put back with `snap`, for steps that set it (a preset,
   * AUTO). The tag isn't console state, so without this an undo would leave
   * the preset's genre in the export metadata.
   */
  genre?: string;
}

let historySeq = 0;

const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];
const HISTORY_MAX = 100;
const GESTURE_MS = 800;

/** What a file drag over the window carries (types only; names arrive on drop). */
export interface FileDragInfo {
  count: number;
  images: number;
}

type Setter = (p: Partial<JMasterState> | ((s: JMasterState) => Partial<JMasterState>)) => void;
type Getter = () => JMasterState;

/**
 * A tempo analysis arrives: the grid, the CLICK (which follows the tracked
 * beats when the tempo drifts), and the tempo row of the check sheet.
 */
function applyTempo(t: TempoInfo | null, set: Setter, get: Getter, announce = true): void {
  set((s) => ({
    tempo: t,
    diagChecks: [...s.diagChecks.filter((c) => c.label !== TEMPO_CHECK), ...(t ? [tempoCheck(t, s.driftRepair)] : [])],
  }));
  engine.setClickBeats(t?.drift ? t.beats : null, t?.downbeat ?? 0);
  pushParams(get);
  if (t?.drift && announce) {
    get().pushToast(`TEMPO DRIFTS ${driftRange(t.drift)} · SEE DIAG`, 'warn');
  }
}

/**
 * A different take of the same track now plays (a drift repair, or the
 * file back again): the source and its checks change, while the console,
 * the playhead, the loop and the trim stay on the same moments of the music.
 */
function swapTake(
  info: SourceInfo,
  repair: DriftRepair | null,
  at: { playSec: number; loop: [number, number] | null; trim: [number, number]; playing: boolean },
  set: Setter,
  get: Getter,
): void {
  const { issues, checks } = deriveDiagnosis(info.diagnostics, info.balanceOffsetDb, info.checks, info.durationSec);
  set((st) => {
    const trimStartSec = Math.max(0, Math.min(info.durationSec, at.trim[0]));
    const trimEndSec = at.trim[1] > 0 ? Math.max(trimStartSec, Math.min(info.durationSec, at.trim[1])) : 0;
    const half = ((trimEndSec || info.durationSec) - trimStartSec) / 2;
    return {
      source: info,
      driftRepair: repair,
      tempo: null,
      playing: false,
      playheadSec: at.playSec,
      loopStartSec: at.loop ? at.loop[0] : null,
      loopEndSec: at.loop ? at.loop[1] : null,
      trimStartSec,
      trimEndSec,
      fadeInSec: Math.min(st.fadeInSec, half),
      fadeOutSec: Math.min(st.fadeOutSec, half),
      // A check the user unticked stays unticked.
      diagIssues: issues.map((i) => ({ ...i, checked: st.diagIssues.find((o) => o.id === i.id)?.checked ?? i.checked })),
      diagChecks: checks,
    };
  });
  // The worklet starts the new take stopped at zero with no loop.
  engine.seekSec(at.playSec);
  if (at.loop) engine.setLoop(at.loop[0], at.loop[1]);
  pushParams(get);
  if (at.playing) get().togglePlay();
}

/** Where the listener is in the last take (playhead, loop, trim, transport), mapped into the new one. */
function listenerIn(
  s: JMasterState, map: (sec: number) => number,
): { playSec: number; loop: [number, number] | null; trim: [number, number]; playing: boolean } {
  return {
    playSec: map(s.playheadSec),
    loop: s.loopStartSec !== null && s.loopEndSec !== null ? [map(s.loopStartSec), map(s.loopEndSec)] : null,
    trim: [s.trimStartSec > 0 ? map(s.trimStartSec) : 0, s.trimEndSec > 0 ? map(s.trimEndSec) : 0],
    playing: s.playing,
  };
}

/** Something long is running that a new track or project would pull the ground from under. */
function busyWith(s: JMasterState): string | null {
  if (s.exporting) return 'THE EXPORT';
  if (s.batchRunning) return 'THE BATCH';
  if (s.albumAssembling) return 'THE CD IMAGE';
  return null;
}

/** A sheet is up (DIAG holds back rather than open over it). */
function sheetUp(s: JMasterState): boolean {
  return s.keysOpen || s.albumOpen || !!s.masterItReport || s.matchOpen || s.repairOpen
    || s.batchOpen || s.exportOpen || s.paletteOpen;
}

/** Cover art from a project: a real image of a sane size, or nothing. */
function cleanCover(raw: unknown): JMasterState['coverArt'] {
  const c = raw as { mime?: unknown; name?: unknown; width?: unknown; height?: unknown; b64?: unknown } | null;
  if (!c || typeof c.b64 !== 'string' || typeof c.mime !== 'string' || !/^image\/(jpeg|png|webp)$/.test(c.mime)) return null;
  // 12 MB of base64 is 9 MB of image: far past anything the app itself embeds.
  if (c.b64.length > 12 * 1024 * 1024) return null;
  try {
    const data = b64ToBytes(c.b64);
    if (data.length === 0) return null;
    return {
      mime: c.mime, data,
      name: typeof c.name === 'string' ? c.name.slice(0, 200) : 'cover',
      width: num(c.width, 1, 20000, 0), height: num(c.height, 1, 20000, 0),
    };
  } catch {
    return null;
  }
}

async function openProject(jsonText: string, set: Setter, get: Getter): Promise<void> {
  const busy = busyWith(get());
  if (busy) {
    get().pushToast(`${busy} IS STILL RUNNING · OPEN THE PROJECT WHEN IT LANDS`, 'warn');
    return;
  }
  try {
    const proj = JSON.parse(jsonText) as ProjectFile;
    if (proj.app !== 'J-Master') throw new Error('not a J-Master project');
    const bridge = (window as any).jmaster;
    const projConsole = cleanConsole(proj.console, captureConsole(get()));
    // A project names an audio file; one that names a project would open itself for ever.
    const track = proj.track && typeof proj.track.name === 'string' && !/\.jmaster$/i.test(proj.track.name)
      ? { name: proj.track.name, path: typeof proj.track.path === 'string' ? proj.track.path : null }
      : null;
    const savedRepair = cleanRepair(proj.track?.repair);
    const savedScale = [0.25, 0.5, 2, 4].find((k) => k === proj.track?.tempoScale) ?? 1;
    // Presets the project's console or queue refer to come along with it.
    const incoming = (Array.isArray(proj.presets) ? proj.presets : [])
      .map((u) => cleanUserPreset(u, NEUTRAL_MACROS)).filter((u): u is UserPreset => !!u);
    if (incoming.length > 0) {
      set((s) => ({
        userPresets: [...s.userPresets, ...incoming.filter((u) => !s.userPresets.some((p) => p.id === u.id))],
      }));
    }
    // The reference belongs to the session that loaded it: left in place,
    // the load below would re-fit the project's own match curve to it.
    set({ matchRef: null });
    // Audio first, so loadFile's per-track resets don't clobber the console.
    pendingProject = null;
    let trackLoaded = false;
    if (track?.path && bridge?.readFileByPath) {
      try {
        const bytes: ArrayBuffer = await bridge.readFileByPath(track.path);
        suppressDiagOnce = true;
        await get().loadFile(bytes, track.name, track.path);
        trackLoaded = get().trackPath === track.path;
        if (trackLoaded && savedScale !== 1) {
          // Usually ahead of the analysis, which then arrives already read this way.
          const t = engine.setTempoScale(savedScale);
          if (t) applyTempo(t, set, get, false);
        }
      } catch {
        get().pushToast(`AUDIO NOT FOUND · ${track.name.toUpperCase()} · LOAD IT MANUALLY`, 'fault');
      } finally {
        // The load may have failed or been overtaken before using it.
        suppressDiagOnce = false;
      }
    } else if (track) {
      get().pushToast(`LOAD ${track.name.toUpperCase()} MANUALLY TO CONTINUE`, 'info');
    }
    // Until its track is loaded, the project keeps that track (a save
    // still names it) and its per-track corrections for when it arrives.
    if (track && !trackLoaded) {
      pendingProject = { track, tempoScale: savedScale, corrections: cleanCorrections(projConsole), repair: savedRepair };
    }
    const fmt = proj.export?.format;
    const batchDir = typeof proj.batch?.dir === 'string' && !isNetworkPath(proj.batch.dir) ? proj.batch.dir : null;
    const base = captureConsole(get());
    set({
      snapshots: {
        A: cleanSnapshot(proj.snapshots?.A, base),
        B: cleanSnapshot(proj.snapshots?.B, base),
      },
      activeSlot: proj.activeSlot === 'B' ? 'B' : 'A',
      meta: { ...get().meta, ...cleanMeta(proj.meta) },
      // A damaged cover costs the cover, not the project.
      coverArt: cleanCover(proj.cover),
      exportFormat: fmt === 'flac' || fmt === 'mp3' || fmt === 'opus' ? fmt : 'wav',
      exportBitDepth: proj.export?.bitDepth === 16 ? 16 : proj.export?.bitDepth === 32 ? 32 : 24,
      exportMp3Kbps: ([192, 256, 320] as const).find((k) => k === proj.export?.mp3Kbps) ?? 320,
      exportOpusKbps: ([128, 192, 256] as const).find((k) => k === proj.export?.opusKbps) ?? 192,
      exportRate: EXPORT_RATES.find((r) => r === proj.export?.rate) ?? get().exportRate,
      exportDither: proj.export?.dither === 'shaped' ? 'shaped' : 'tpdf',
      ...(typeof proj.album?.upc === 'string' ? { albumUpc: proj.album.upc.replace(/\D/g, '').slice(0, 13) } : {}),
      ...(typeof proj.album?.gapSec === 'number' ? { albumGapSec: num(proj.album.gapSec, 0, 5, 2) } : {}),
      // A network folder from a shared file is never written to unasked.
      batchDir: batchDir ?? get().batchDir,
    });
    const src = get().source;
    const applied: ConsoleState = trackLoaded && src
      ? fitToTrack(projConsole, src.durationSec)
      // No track of its own on the console: the sound applies, the
      // corrections wait for theirs.
      : { ...projConsole, ...NO_CORRECTIONS };
    applyConsole(applied, set, get);
    // Undo belongs to a console's own history: a project starts a new one.
    undoStack.length = 0;
    redoStack.length = 0;
    set({ undoDepth: 0, redoDepth: 0 });
    batchSources.clear();
    const items: BatchItem[] = [];
    for (const it of Array.isArray(proj.batch?.items) ? proj.batch.items : []) {
      if (typeof it?.path !== 'string' || typeof it.name !== 'string') continue;
      const id = batchSeq++;
      batchSources.set(id, { path: it.path });
      items.push({
        id, name: it.name, status: 'pending', pct: 0, phase: '',
        presetId: typeof it.presetId === 'string' ? it.presetId : null,
        isrc: typeof it.isrc === 'string' ? it.isrc.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : undefined,
        ...(typeof it.fixesEnabled === 'boolean' ? { fixesEnabled: it.fixesEnabled } : {}),
      });
    }
    set({ batchItems: items });
    void scanBatchItems(set, get);
    get().pushToast('PROJECT OPENED', 'run');
    if (trackLoaded && savedRepair) rerunRepair(savedRepair, get);
  } catch {
    get().pushToast('PROJECT FILE UNREADABLE', 'fault');
  }
}

/** A console's trim and fades, held inside a track of this length. */
function fitToTrack(c: ConsoleState, durationSec: number): ConsoleState {
  const trimStartSec = Math.max(0, Math.min(durationSec - 0.1, c.trimStartSec));
  const trimEndSec = c.trimEndSec > 0 && c.trimEndSec < durationSec ? Math.max(trimStartSec + 0.1, c.trimEndSec) : 0;
  const half = ((trimEndSec || durationSec) - trimStartSec) / 2;
  return {
    ...c, trimStartSec, trimEndSec,
    fadeInSec: Math.min(c.fadeInSec, half),
    fadeOutSec: Math.min(c.fadeOutSec, half),
  };
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
  durationSec?: number;
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

/** A fix from a check sheet, applied to a set of chain params. */
function applyFixToParams(p: ChainParams, fix: DiagIssue, balanceOffsetDb: number): void {
  const a = fix.action;
  switch (a.type) {
    case 'bassMono': p.bassMono = true; break;
    case 'width': p.width = Math.min(p.width, a.value); break;
    case 'smooth': p.smooth = Math.max(p.smooth, a.value); break;
    case 'balance': p.balanceDb = Math.max(-3, Math.min(3, -balanceOffsetDb)); break;
    case 'sourceFix': p.sourceFix = a.mode; break;
    case 'restoreAir': p.airRestore = a.amount; p.airRestoreHz = a.hz; break;
    case 'trim': p.trimStartSec = a.startSec; p.trimEndSec = a.endSec; break;
    case 'fadeIn': p.fadeInSec = Math.max(p.fadeInSec, a.sec); break;
    case 'fadeOut': p.fadeOutSec = Math.max(p.fadeOutSec, a.sec); break;
  }
}

/**
 * The console for one batch or album track. The sound (macros, EQ, target,
 * a per-track preset) carries over. The corrections don't: they are fixes
 * to the loaded track's own faults, so every other track starts clean and
 * takes only the fixes its own scan found. The loaded track renders as the
 * console has it (what DIAG offered and you declined stays declined).
 */
function trackParams(s: JMasterState, base: ChainParams, item: BatchItem): ChainParams {
  const loaded = !!s.trackPath && batchSources.get(item.id)?.path === s.trackPath;
  let p: ChainParams = loaded
    ? { ...base }
    : {
        ...base,
        balanceDb: 0, bassMono: false, sourceFix: 'none', matchEqGains: [],
        airRestore: 0, trimStartSec: 0, trimEndSec: 0, fadeInSec: 0, fadeOutSec: 0,
      };
  const override = findPreset(s, item.presetId);
  if (override) {
    p = { ...p, ...override.macros, targetLufs: override.targetLufs, ceilingDb: override.ceilingDb };
  }
  if (!loaded && item.fixesEnabled && item.fixes && item.fixes.length > 0) {
    for (const fix of item.fixes) if (fix.checked) applyFixToParams(p, fix, item.balanceOffsetDb ?? 0);
  }
  return p;
}

/**
 * A batch or album track's audio: when it is the loaded track and a drift
 * repair plays in place of that file, the repair (with its own loudness);
 * otherwise the file, read and decoded.
 */
async function itemAudio(
  s: JMasterState,
  src: { path?: string; file?: File },
  onDecode?: () => void,
): Promise<{ l: Float32Array; r: Float32Array; durationSec: number; lufs?: number; clippedRuns?: number }> {
  if (s.driftRepair && src.path && src.path === s.trackPath) {
    const cur = engine.currentAudio();
    if (cur) return cur;
  }
  const bridge = (window as any).jmaster;
  const bytes: ArrayBuffer = src.path ? await bridge.readFileByPath(src.path) : await src.file!.arrayBuffer();
  onDecode?.();
  return engine.decodeOnly(bytes);
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

/** The last export, kept for its report. */
export interface LastExport {
  fileName: string;
  /** Folder the master was saved in (null in the browser preview). */
  dir: string | null;
  title: string;
  sourceName: string;
  when: string;
  stats: ExportStats;
  report: RenderReport | null;
  console: ConsoleState;
  presetName: string | null;
  source: { lufs: number; truePeakDb: number; lra: number; sampleRate: number; bitDepth: number | null; durationSec: number };
  tempoBpm: number;
  repaired: boolean;
  meta: JMasterState['meta'];
}

/** .jmaster project document (version 2; version 1 files open as they were). */
interface ProjectFile {
  app: 'J-Master';
  fileVersion: 1 | 2;
  savedAt: string;
  /**
   * `repair`: a drift repair to re-run when the project opens, with the
   * length of the file it was made for (another file is left alone).
   */
  track: { name: string; path: string | null; repair?: SavedRepair; tempoScale?: number } | null;
  console: ConsoleState;
  snapshots: { A: ConsoleSnapshot | null; B: ConsoleSnapshot | null };
  activeSlot: Slot;
  meta: JMasterState['meta'];
  export: {
    format: ExportFormat; bitDepth: ExportBitDepth; mp3Kbps: 192 | 256 | 320; opusKbps: 128 | 192 | 256;
    rate?: ExportRate; dither?: DitherKind;
  };
  batch: { dir: string | null; items: { name: string; path: string | null; presetId: string | null; isrc?: string; fixesEnabled?: boolean }[] };
  album?: { upc: string; gapSec: number };
  /** The user presets this console and queue refer to. */
  presets?: UserPreset[];
  cover?: { mime: string; name: string; width: number; height: number; b64: string } | null;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

let suppressDiagOnce = false;
let loadToken = 0;
/** Bumps per repair and per load: only the latest repair may land or clear the progress. */
let repairToken = 0;
/** A project opened without its audio: what to restore once it's loaded. */
let pendingProject: {
  track: { name: string; path: string | null };
  /** The project's reading of the tempo (double or half time), for when the track arrives. */
  tempoScale: number;
  corrections: TrackCorrections;
  /** The project's drift repair, re-run when its own track arrives. */
  repair: SavedRepair | null;
} | null = null;

interface SavedRepair {
  targetBpm: number;
  /** The file's length when it was repaired; null in a project that didn't record it. */
  fileSec?: number | null;
}

/** A drift repair from a project file: a plain tempo in a sane range (and a length), or null. */
function cleanRepair(raw: unknown): SavedRepair | null {
  const r = raw as { targetBpm?: unknown; fileSec?: unknown } | null;
  const bpm = r?.targetBpm;
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < 40 || bpm > 300) return null;
  const sec = r?.fileSec;
  return { targetBpm: bpm, fileSec: typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec : null };
}

/** The repair to save: the one being stretched, else the one in place (null without either). */
function repairToSave(s: JMasterState): SavedRepair | null {
  const bpm = s.repairing?.targetBpm ?? s.driftRepair?.targetBpm;
  if (bpm === undefined || !s.source) return null;
  return { targetBpm: bpm, fileSec: s.driftRepair?.originalDurationSec ?? s.source.durationSec };
}

/**
 * A project's repair, re-run on the file it was made for: the same file
 * analyzes the same, so the same tempo gives the same stretch. A file of
 * another length is another take, and is left as it is.
 */
function rerunRepair(saved: SavedRepair, get: Getter): void {
  const src = get().source;
  if (!src) return;
  if (saved.fileSec != null && Math.abs(src.durationSec - saved.fileSec) > 0.01) {
    get().pushToast('THE FILE CHANGED SINCE ITS DRIFT REPAIR · NOT RE-APPLIED', 'warn');
    return;
  }
  void get().repairDrift(saved.targetBpm);
}

/** Bumped by every stop, so an audition still rendering never starts late. */
let auditionToken = 0;

function stopStaleAudition(get: Getter): void {
  const a = get().audition;
  if (a.active || a.busy) get().stopAudition();
}

interface JMasterState extends TrackCorrections {
  loaded: boolean;
  loading: boolean;
  /** File name of the load in flight (drives the loading veil). */
  loadingName: string | null;
  loadError: string | null;
  source: SourceInfo | null;
  /** Filesystem path of the loaded audio (Electron), for project files. */
  trackPath: string | null;
  /** Playback loop region (session-only). */
  loopStartSec: number | null;
  loopEndSec: number | null;
  /** Recently loaded audio files (Electron only: needs a filesystem path). */
  recentFiles: { name: string; path: string }[];
  keysOpen: boolean;
  /** The command palette (Ctrl+K). */
  paletteOpen: boolean;
  /** Front-cover art embedded into export tags (session + project file). */
  coverArt: { mime: string; data: Uint8Array; width: number; height: number; name: string } | null;
  userPresets: UserPreset[];
  /** Built-in presets pinned to the top of the rack. */
  favourites: string[];
  /** The preset the console was last set from, for "modified" + revert. */
  lastPresetId: string | null;
  /** How much of the preset is dialled in (1 = as written). */
  presetAmount: number;
  /** Extra formats saved beside every export, from the same render. */
  exportExtras: ExportFormat[];
  /** Where the last export's companions went (names or paths). */
  exportExtrasSaved: string[];

  macros: MacroValues;
  presetId: string | null;
  platformId: string | null;
  targetLufs: number;
  ceilingDb: number;
  /** The peak clipper ahead of the limiter. */
  clipMode: ClipMode;
  bypass: boolean;
  /** Monitor matrix (preview-only): mono fold, side solo, or one channel. */
  monitor: MonitorMode;
  /** Platform whose loudness normalization playback imitates (null = off). */
  normPreview: string | null;
  /** Which analyser the meters rack shows. */
  meterView: 'spectrum' | 'scope' | 'loudness';
  /** Spectrum drawn with a 4.5 dB/octave tilt, so a balanced mix reads level. */
  spectrumSlope: boolean;
  limiterDelta: boolean;
  advEq: AdvEqBand[];
  stems: StemTrims;
  advEqOpen: boolean;
  stemsOpen: boolean;
  matchOpen: boolean;
  matchRef: {
    name: string; lufs: number; sideRatioDb: number;
    /** The reference's own spectrum, so the curve can be re-fitted per track. */
    bands: number[];
    deltaGains: number[]; suggestedWidth: number;
  } | null;
  matchLoading: boolean;
  /** `historyId`: AUTO's own undo step, so UNDO ALL can tell it's still the latest. */
  masterItReport: { presetName: string; reasons: string[]; historyId: number } | null;
  masterItBusy: boolean;
  audition: { active: boolean; mode: 'codec' | 'master'; busy: boolean };
  metronome: boolean;
  gridEnabled: boolean;
  loudnessLane: boolean;
  /** Tempo lane on the waveform (shown when the tempo drifts). */
  tempoLane: boolean;
  /** The waveform keeps the playhead in view while playing. */
  followPlayhead: boolean;
  tempo: TempoInfo | null;
  /** A request for the waveform to frame a stretch of the track. */
  waveFocus: { startSec: number; endSec: number; seq: number } | null;
  /**
   * The drift repair playing in place of the file (the engine holds both):
   * the steady tempo, the drift it removed, and the file's own length.
   */
  driftRepair: DriftRepair | null;
  /** A repair being stretched. */
  repairing: { targetBpm: number; pct: number } | null;
  repairOpen: boolean;

  diagOpen: boolean;
  diagIssues: DiagIssue[];
  diagChecks: DiagCheck[];
  autoFix: boolean;

  /** A/B console snapshots for loudness-matched comparisons. */
  activeSlot: Slot;
  snapshots: { A: ConsoleSnapshot | null; B: ConsoleSnapshot | null };

  playing: boolean;
  playheadSec: number;
  meters: MeterFrame | null;
  /** Where an export of the console as it stands would land (null while it is being worked out). */
  masterEstimate: MasterEstimate | null;

  theme: 'plate' | 'paper';
  waveView: 'wave' | 'spec';
  exportOpen: boolean;
  exporting: ExportProgress | null;
  exportStats: ExportStats | null;
  exportSavedTo: string | null;
  exportFormat: ExportFormat;
  exportBitDepth: ExportBitDepth;
  exportRate: ExportRate;
  exportDither: DitherKind;
  exportMp3Kbps: 192 | 256 | 320;
  exportOpusKbps: 128 | 192 | 256;
  exportHistory: ExportHistoryEntry[];
  lastExport: LastExport | null;
  processedView: boolean;
  /** OUT comparison layout: ghost overlay (false) or split lanes (true). */
  outSplit: boolean;
  /** Mirror of engine.previewPending, so the UI re-renders when it flips. */
  previewPending: boolean;
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

  /** Accepts a pending read so load order follows request order. */
  loadFile(data: ArrayBuffer | Promise<ArrayBuffer>, name: string, path?: string | null): Promise<void>;
  setMacro(key: keyof MacroValues, value: number): void;
  applyPreset(id: string): void;
  /** How much of the current preset to dial in: 0 = none of it, 1 = as written, up to 1.5. */
  setPresetAmount(amount: number): void;
  applyPlatform(id: string): void;
  nudgeTarget(delta: number): void;
  nudgeCeiling(delta: number): void;
  setClipMode(mode: ClipMode): void;
  setFade(which: 'in' | 'out', sec: number): void;
  setFadeCurve(which: 'in' | 'out', curve: FadeCurve): void;
  /** Top and tail: where the kept part starts or ends, in seconds of the track. */
  setTrim(which: 'start' | 'end', sec: number): void;
  clearTrim(): void;
  setAirRestore(amount: number): void;
  setSourceFix(mode: SourceFix): void;
  setBypass(on: boolean): void;
  setMonitor(mode: MonitorMode): void;
  setNormPreview(platformId: string | null): void;
  setMeterView(view: JMasterState['meterView']): void;
  setSpectrumSlope(on: boolean): void;
  setLimiterDelta(on: boolean): void;
  setBalance(db: number): void;
  autoCenter(): void;
  setMetronome(on: boolean): void;
  setGridEnabled(on: boolean): void;
  setLoudnessLane(on: boolean): void;
  setTempoLane(on: boolean): void;
  setFollowPlayhead(on: boolean): void;
  /** Re-reads the tempo at double or half time. */
  rescaleTempo(factor: 2 | 0.5): void;
  /** Frames [startSec, endSec] on the waveform. */
  focusWave(startSec: number, endSec: number): void;
  openRepair(open: boolean): void;
  /** Stretches the track onto one steady tempo, pitch unchanged; the file stays for revertRepair. */
  repairDrift(targetBpm: number): Promise<void>;
  cancelRepair(): void;
  /** Puts the file back in place of its repair, at once. */
  revertRepair(): void;
  /** Saves the repaired track as a 32-bit float WAV. */
  saveRepairedWav(): Promise<void>;
  switchSlot(slot: Slot): void;
  /** Copies the active console into the other slot. */
  copyToOtherSlot(): void;
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
  /** Analyzes a reference track: the dropped file, or one picked now. */
  loadReference(dropped?: File): Promise<void>;
  /** A file drag hovering the window (null when none). */
  fileDrag: FileDragInfo | null;
  setFileDrag(info: FileDragInfo | null): void;
  /** Phase of the load in flight, for the loading veil. */
  loadPhase: string | null;
  applyMatch(): void;
  clearMatch(): void;
  setAdvEqOpen(open: boolean): void;
  setStemsOpen(open: boolean): void;
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
  removeBatchItem(id: number): void;
  assembleAlbum(): Promise<void>;
  masterIt(): Promise<void>;
  closeMasterItReport(): void;
  /** UNDO ALL OF IT: the console and the genre tag as they were before AUTO. */
  undoMasterIt(): void;
  togglePlay(): void;
  stop(): void;
  seekSec(sec: number): void;
  /** Loops the section at `atSec` (default: playhead); same section again clears. */
  toggleLoop(atSec?: number): void;
  /** Loops any stretch of the track. */
  setLoopRange(startSec: number, endSec: number): void;
  clearLoop(): void;
  pruneRecentFile(path: string): void;
  openKeys(open: boolean): void;
  openPalette(open: boolean): void;
  /** Downscales to ≤1000 px JPEG and stores it for embedding on export. */
  setCoverFromFile(file: File): Promise<void>;
  clearCover(): void;
  /** Saves the console as a user preset (same name overwrites). */
  saveUserPreset(name: string): void;
  deleteUserPreset(id: string): void;
  /** Pins a preset (yours or a genre) to the top of the rack, or lets it go. */
  toggleFavourite(id: string): void;
  /** Re-applies the preset the console was last set from. */
  revertPreset(): void;
  toggleExportExtra(format: ExportFormat): void;
  setTheme(theme: 'plate' | 'paper'): void;
  setWaveView(view: 'wave' | 'spec'): void;
  openExport(open: boolean): void;
  setExportFormat(format: ExportFormat): void;
  setExportBitDepth(depth: ExportBitDepth): void;
  setExportRate(rate: ExportRate): void;
  setExportDither(kind: DitherKind): void;
  setExportMp3Kbps(kbps: 192 | 256 | 320): void;
  setExportOpusKbps(kbps: 128 | 192 | 256): void;
  setProcessedView(on: boolean): void;
  setOutSplit(on: boolean): void;
  toggleItemFixes(id: number): void;
  setMeta(field: keyof JMasterState['meta'], value: string): void;
  startExport(fileName: string, title: string): void;
  /** Saves a spec sheet of the last export beside it. */
  saveReport(): Promise<void>;

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
    sampleRate: s.exportRate,
    dither: s.exportDither,
  };
}

export function tagsFrom(
  s: JMasterState,
  title: string,
  trackNumber?: number,
  trackTotal?: number,
  isrc?: string,
): TrackTags {
  return {
    title: title || undefined,
    artist: s.meta.artist || undefined,
    album: s.meta.album || undefined,
    year: s.meta.year || undefined,
    genre: s.meta.genre || undefined,
    catalog: s.meta.catalog || undefined,
    comment: s.meta.comment || undefined,
    isrc: isrc && ISRC_RE.test(isrc) ? isrc : undefined,
    trackNumber,
    trackTotal,
    picture: s.coverArt
      ? {
          mime: s.coverArt.mime, data: s.coverArt.data,
          width: s.coverArt.width, height: s.coverArt.height,
        }
      : undefined,
  };
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
    clipMode: s.clipMode,
    fadeInSec: s.fadeInSec,
    fadeOutSec: s.fadeOutSec,
    fadeInCurve: s.fadeInCurve,
    fadeOutCurve: s.fadeOutCurve,
    trimStartSec: s.trimStartSec,
    trimEndSec: s.trimEndSec,
    bypass: s.bypass,
    limiterDelta: s.limiterDelta,
    monitor: s.monitor,
    monitorGainDb: normPreviewGainDb(s),
    smooth: s.macros.smooth,
    balanceDb: s.balanceDb,
    bassMono: s.bassMono,
    sourceFix: s.sourceFix,
    matchEqGains: s.matchEqGains,
    advEq: s.advEq,
    airRestore: s.airRestore,
    airRestoreHz: s.airRestoreHz,
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

/**
 * Playback gain that imitates a platform's loudness normalization: a master
 * louder than the platform's reference is turned down by the difference.
 * Quieter masters play as mastered (the turn-down-only model the DIAG
 * delivery table uses; boosting depends on each service's peak rules).
 */
export function normPreviewGainDb(s: { normPreview: string | null; targetLufs: number }): number {
  if (!s.normPreview) return 0;
  const p = PLATFORMS.find((x) => x.id === s.normPreview);
  return p ? Math.min(0, p.targetLufs - s.targetLufs) : 0;
}

function pushParams(get: Getter): void {
  // The engine keeps the master solved for whatever the console holds.
  engine.updateParams(chainParamsFrom(get()));
}

/** A queued track's diagnosis, from its decoded audio. */
async function diagnoseItem(
  l: Float32Array, r: Float32Array, durationSec: number, clippedRuns?: number,
): Promise<{ lufs: number; balanceOffsetDb: number; fixes: DiagIssue[] }> {
  const a = await engine.analyzeBuffers(l, r, clippedRuns);
  const { issues } = deriveDiagnosis(a.diagnostics, a.balanceOffsetDb, a.checks, durationSec);
  return { lufs: a.lufs, balanceOffsetDb: a.balanceOffsetDb, fixes: issues };
}

/** Background pre-scan: analyze queued batch tracks for loudness + fixes. */
async function scanBatchItems(set: Setter, get: Getter): Promise<void> {
  if (batchScanRunning) return;
  batchScanRunning = true;
  const patch = (id: number, p: Partial<BatchItem>) =>
    set((st) => ({
      batchItems: st.batchItems.map((it) => (it.id === id ? { ...it, ...p } : it)),
    }));
  try {
    for (;;) {
      // A run diagnoses what it renders itself; the scan picks up again
      // when it ends (see startBatch).
      if (get().batchRunning || get().albumAssembling) break;
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
        const { l, r, durationSec, clippedRuns } = await engine.decodeOnly(bytes);
        const d = await diagnoseItem(l, r, durationSec, clippedRuns);
        const still = get().batchItems.find((it) => it.id === item.id);
        // Rendered meanwhile by a run: its own diagnosis stands.
        if (!still || still.scanned) continue;
        patch(item.id, {
          scanned: true, phase: still.status === 'pending' ? '' : still.phase, error: undefined,
          lufs: d.lufs, durationSec, balanceOffsetDb: d.balanceOffsetDb,
          fixes: d.fixes, fixesEnabled: (still.fixesEnabled ?? true) && d.fixes.some((f) => f.checked),
        });
      } catch {
        patch(item.id, { scanned: true, phase: '', error: 'CAN’T READ THIS FILE' });
      }
    }
  } finally {
    batchScanRunning = false;
  }
}

/**
 * The correction that moves a track's spectrum toward a reference's:
 * shape only (the mean is removed, loudness is its own axis), lightly
 * smoothed, on the ten match-EQ centres, capped at ±6 dB; and the width
 * that brings its side energy level with the reference's.
 */
function matchDelta(
  refBands: ArrayLike<number>, refSideDb: number, src: { bands: ArrayLike<number>; sideRatioDb: number },
): { deltaGains: number[]; suggestedWidth: number } {
  const n = refBands.length;
  const raw = new Array<number>(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    raw[i] = refBands[i] - src.bands[i];
    if (!Number.isFinite(raw[i])) raw[i] = 0;
    mean += raw[i];
  }
  mean /= n;
  for (let i = 0; i < n; i++) raw[i] -= mean;
  const smoothed = raw.map((v, i) => (raw[Math.max(0, i - 1)] + 2 * v + raw[Math.min(n - 1, i + 1)]) / 4);
  const deltaGains = MATCH_EQ_CENTERS.map((f) => {
    const pos = (Math.log(f / 20) / Math.log(1000)) * n - 0.5;
    const i0 = Math.max(0, Math.min(n - 1, Math.floor(pos)));
    const i1 = Math.min(n - 1, i0 + 1);
    const t = Math.max(0, Math.min(1, pos - i0));
    return +Math.max(-6, Math.min(6, smoothed[i0] * (1 - t) + smoothed[i1] * t)).toFixed(1);
  });
  // Side energy scales with width², so the dB difference / 40 in log10.
  const suggestedWidth = +Math.max(0.7, Math.min(1.6, Math.pow(10, (refSideDb - src.sideRatioDb) / 40))).toFixed(2);
  return { deltaGains, suggestedWidth };
}

/**
 * A reference stays loaded across tracks, so its curve is re-fitted to the
 * new one; an applied match takes the new curve (the width stays yours).
 */
async function refitMatch(source: SourceInfo, apply: boolean, set: Setter, get: Getter): Promise<void> {
  const ref = get().matchRef;
  if (!ref) return;
  const src = await engine.requestSourceProfile().catch(() => null);
  if (!src || get().source !== source || get().matchRef !== ref) return;
  const fit = matchDelta(ref.bands, ref.sideRatioDb, src);
  set({ matchRef: { ...ref, ...fit } });
  if (apply) {
    set({ matchEqGains: [...fit.deltaGains] });
    pushParams(get);
    get().pushToast(`MATCH EQ RE-FITTED TO THIS TRACK · ${ref.name.toUpperCase()}`, 'info');
  }
}

/** Records the pre-change console state; continuous knob gestures collapse. */
let historySet: Setter | null = null;
/** Set while one action (AUTO) makes several changes under a single entry. */
let historyHeld = false;
function record(get: Getter, field: string, opts: { genre?: boolean } = {}): void {
  if (historyHeld) return;
  const now = Date.now();
  const top = undoStack[undoStack.length - 1];
  if (top && top.field === field && top.slot === get().activeSlot && now - top.at < GESTURE_MS) {
    top.at = now;
    // Still a new edit: what could be redone before it can't be after.
    if (redoStack.length > 0) {
      redoStack.length = 0;
      historySet?.({ redoDepth: 0 });
    }
    return;
  }
  undoStack.push({
    snap: captureConsole(get()), field, at: now, id: ++historySeq, slot: get().activeSlot,
    ...(opts.genre ? { genre: get().meta.genre } : {}),
  });
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
  historySet?.({ undoDepth: undoStack.length, redoDepth: 0 });
}

/**
 * What the other stack keeps when `entry` is applied: the state it replaces.
 * Its time is zero, so the next edit never folds into a step that came off
 * the other stack (it used to, within 800 ms of a redo).
 */
function swapEntry(entry: HistoryEntry, get: Getter): HistoryEntry {
  return {
    snap: captureConsole(get()), field: entry.field, at: 0, id: entry.id, slot: entry.slot,
    ...(entry.genre !== undefined ? { genre: get().meta.genre } : {}),
  };
}

function applyEntry(entry: HistoryEntry, set: Setter, get: Getter): void {
  applyConsole(entry.snap, set, get);
  if (entry.genre !== undefined) {
    const genre = entry.genre;
    set((s) => ({ meta: { ...s.meta, genre } }));
  }
}

function applyConsole(snap: ConsoleState, set: Setter, get: Getter): void {
  set({
    ...soundPatch(snap),
    lastPresetId: snap.lastPresetId,
    balanceDb: snap.balanceDb,
    bassMono: snap.bassMono,
    sourceFix: snap.sourceFix,
    matchEqGains: [...snap.matchEqGains],
    airRestore: snap.airRestore,
    airRestoreHz: snap.airRestoreHz,
    trimStartSec: snap.trimStartSec,
    trimEndSec: snap.trimEndSec,
    fadeInSec: snap.fadeInSec,
    fadeOutSec: snap.fadeOutSec,
    fadeInCurve: snap.fadeInCurve,
    fadeOutCurve: snap.fadeOutCurve,
  });
  pushParams(get);
}

/** The length of the part a trim keeps (the whole track without one). */
function keptLength(s: { trimStartSec: number; trimEndSec: number }, durationSec: number): number {
  return (s.trimEndSec > 0 ? Math.min(s.trimEndSec, durationSec) : durationSec) - Math.min(s.trimStartSec, durationSec);
}

const settingsStorage = debouncedStorage<JMasterState>();

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
    loadingName: null,
    loadPhase: null,
    fileDrag: null,
    loadError: null,
    source: null,
    trackPath: null,
    loopStartSec: null,
    loopEndSec: null,
    recentFiles: [],
    keysOpen: false,
    paletteOpen: false,
    coverArt: null,
    userPresets: [],
    favourites: [],
    lastPresetId: 'flat',
    presetAmount: 1,
    exportExtras: [],
    exportExtrasSaved: [],

    macros: { ...NEUTRAL_MACROS },
    presetId: 'flat',
    platformId: null,
    targetLufs: -14,
    ceilingDb: -1,
    clipMode: 'off' as const,
    ...NO_CORRECTIONS,
    matchEqGains: [],
    bypass: false,
    limiterDelta: false,
    monitor: 'stereo' as const,
    normPreview: null,
    meterView: 'spectrum' as const,
    spectrumSlope: true,
    advEq: defaultAdvEq(),
    stems: { bass: 0, drums: 0, vocal: 0, air: 0 },
    advEqOpen: false,
    stemsOpen: false,
    matchOpen: false,
    matchRef: null,
    matchLoading: false,
    masterItReport: null,
    masterItBusy: false,
    audition: { active: false, mode: 'codec' as const, busy: false },
    metronome: false,
    gridEnabled: true,
    loudnessLane: true,
    tempoLane: true,
    followPlayhead: true,
    tempo: null,
    waveFocus: null,
    driftRepair: null,
    repairing: null,
    repairOpen: false,
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
    masterEstimate: null,

    theme: 'plate',
    waveView: 'wave',
    exportOpen: false,
    exporting: null,
    exportStats: null,
    exportSavedTo: null,
    exportFormat: 'wav',
    exportBitDepth: 24,
    exportRate: 48000,
    exportDither: 'tpdf',
    exportMp3Kbps: 320,
    exportOpusKbps: 192 as const,
    exportHistory: [],
    lastExport: null,
    processedView: false,
    outSplit: false,
    previewPending: false,
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
      // A render, a batch or a CD image is reading the console and the
      // queue as they stand: nothing new loads under it.
      const busy = busyWith(get());
      if (busy) {
        void Promise.resolve(data).catch(() => undefined);
        get().pushToast(`${busy} IS STILL RUNNING · LOAD WHEN IT LANDS`, 'warn');
        return;
      }
      // Project files route through the project loader.
      if (name.toLowerCase().endsWith('.jmaster')) {
        let text: string;
        try {
          text = new TextDecoder().decode(await data);
        } catch (err) {
          if (path) get().pruneRecentFile(path);
          get().pushToast(`CAN'T OPEN ${name.toUpperCase()} · ${fileErrorText(err)}`, 'fault');
          return;
        }
        await openProject(text, set, get);
        return;
      }
      // Latest REQUEST wins, so the token is taken now, before the bytes
      // arrive: a big file dropped first must not overtake a small file
      // dropped after it just because it took longer to read.
      const token = ++loadToken;
      set({ loading: true, loadError: null, loadingName: name, loadPhase: 'READING' });
      let bytes: ArrayBuffer;
      try {
        bytes = await data;
      } catch (err) {
        if (token !== loadToken) return;
        set({ loading: false, loadingName: null, loadPhase: null });
        if (path && /ENOENT|no such file/i.test(String((err as Error)?.message ?? err))) get().pruneRecentFile(path);
        get().pushToast(`CAN'T OPEN ${name.toUpperCase()} · ${fileErrorText(err)}`, 'fault');
        return;
      }
      if (token !== loadToken) return;
      try {
        // The engine asks, right before it installs the track, whether this
        // is still the load the console is waiting for.
        const source = await engine.loadFile(bytes, name, (phase) => {
          if (token === loadToken) set({ loadPhase: phase });
        }, () => token === loadToken);
        if (token !== loadToken || !source) return;
        const { issues, checks } = deriveDiagnosis(source.diagnostics, source.balanceOffsetDb, source.checks, source.durationSec);
        repairToken++;
        // The corrections were the last track's own: this one starts clean.
        // (A reference still loaded keeps its place: its curve is re-fitted.)
        const hadMatch = get().matchEqGains.length > 0 && !!get().matchRef;
        set({
          loaded: true, loading: false, loadingName: null, loadPhase: null, source, trackPath: path,
          playing: false, playheadSec: 0,
          loopStartSec: null, loopEndSec: null, monitor: 'stereo', bypass: false, limiterDelta: false,
          tempo: null, metronome: false,
          ...NO_CORRECTIONS, matchEqGains: [],
          diagIssues: issues, diagChecks: checks, diagOpen: false,
          driftRepair: null, repairing: null, repairOpen: false,
          masterItReport: null, lastExport: null,
        });
        // Undo belongs to a track: stepping back past a load would bring
        // the previous track's corrections onto this one.
        undoStack.length = 0;
        redoStack.length = 0;
        set({ undoDepth: 0, redoDepth: 0 });
        // The track a project was waiting for: its corrections return, and
        // its drift repair too once it is that same file. Any other track
        // is not the project's, and takes nothing from it.
        let pendingRepair: SavedRepair | null = null;
        let fromProject = false;
        if (pendingProject) {
          if (pendingProject.track.name === name) {
            const c = fitToTrack({ ...captureConsole(get()), ...pendingProject.corrections }, source.durationSec);
            set({ ...pendingProject.corrections, trimStartSec: c.trimStartSec, trimEndSec: c.trimEndSec, fadeInSec: c.fadeInSec, fadeOutSec: c.fadeOutSec });
            pendingRepair = pendingProject.repair;
            if (pendingProject.tempoScale !== 1) engine.setTempoScale(pendingProject.tempoScale);
            fromProject = true;
          }
          pendingProject = null;
        }
        if (get().matchRef) void refitMatch(source, hadMatch && !fromProject, set, get);
        document.title = `${name} · J-Master`;
        if (path) {
          set((st) => ({
            recentFiles: [{ name, path }, ...st.recentFiles.filter((r) => r.path !== path)].slice(0, 6),
          }));
        }
        pushParams(get);
        if (get().processedView) engine.scheduleProcessedPreview(chainParamsFrom(get()), 100);
        get().pushToast(`LOADED ${name.toUpperCase()}`, 'run');
        if (source.repairedSamples > 0) {
          get().pushToast(`${source.repairedSamples} BROKEN SAMPLES (NaN/∞) IN THE FILE · SILENCED`, 'warn');
        }
        // A project's saved console is not to be second-guessed.
        const skipDiag = suppressDiagOnce || fromProject;
        suppressDiagOnce = false;
        if (issues.length > 0 && !skipDiag) {
          if (get().autoFix) {
            get().applyDiagFixes();
          } else if (!sheetUp(get())) {
            // Never over another sheet (several tracks dropped open BATCH):
            // the DIAG lamp says the same thing without taking the focus.
            set({ diagOpen: true });
          }
        }
        // Tempo detection runs in the background; the grid appears when ready.
        void engine.requestTempo().then((t) => {
          if (get().source !== source) return;
          applyTempo(t, set, get);
          if (pendingRepair) rerunRepair(pendingRepair, get);
        });
      } catch (err) {
        if (token !== loadToken) return;
        set({ loading: false, loadingName: null, loadPhase: null, loadError: String(err) });
        get().pushToast(`CAN'T READ ${name.toUpperCase()} · UNSUPPORTED OR DAMAGED FILE`, 'fault');
      }
    },

    setMacro(key, value) {
      const [lo, hi] = MACRO_RANGE[key];
      const v = Math.max(lo, Math.min(hi, value));
      if (Math.abs(get().macros[key] - v) < 1e-9) return;
      record(get, `macro:${key}`);
      set((s) => ({ macros: { ...s.macros, [key]: v }, presetId: null }));
      pushParams(get);
    },

    openMatch(open) {
      set({ matchOpen: open });
    },

    async loadReference(dropped) {
      const s = get();
      if (!s.loaded || s.matchLoading || s.loading) return;
      // A dropped reference skips the picker; otherwise pick one (native
      // dialog or browser input).
      const bridge = (window as any).jmaster;
      let bytes: ArrayBuffer | null = null;
      let name = '';
      try {
        if (dropped) {
          bytes = await dropped.arrayBuffer();
          name = dropped.name;
        } else if (bridge?.openFile) {
          const res = await bridge.openFile();
          if (!res || res.name.toLowerCase().endsWith('.jmaster')) return;
          bytes = res.data;
          name = res.name;
        } else {
          const picked = await new Promise<File | null>((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.wav,.flac,.mp3,.ogg,.opus,.m4a,audio/*';
            input.onchange = () => resolve(input.files?.[0] ?? null);
            input.click();
          });
          if (!picked) return;
          bytes = await picked.arrayBuffer();
          name = picked.name;
        }
      } catch (err) {
        get().pushToast(`CAN'T OPEN THE REFERENCE · ${fileErrorText(err)}`, 'fault');
        return;
      }
      if (!bytes) return;
      // The track the reference is being fitted to: if another has loaded
      // by the time it is analysed, the fit is for nothing here.
      const forSource = get().source;
      set({ matchLoading: true });
      try {
        const src = await engine.requestSourceProfile();
        const { l, r } = await engine.decodeOnly(bytes);
        const ref = await engine.profileBuffers(l, r);
        if (!src) throw new Error('no source profile');
        const bands = Array.from(ref.bands);
        if (get().source !== forSource) {
          // Keep the reference; its curve is fitted to whatever is loaded now.
          set({ matchRef: { name, lufs: ref.lufs, sideRatioDb: ref.sideRatioDb, bands, deltaGains: MATCH_EQ_CENTERS.map(() => 0), suggestedWidth: 1 }, matchLoading: false });
          const now = get().source;
          if (now) void refitMatch(now, false, set, get);
          return;
        }
        set({
          matchRef: { name, lufs: ref.lufs, sideRatioDb: ref.sideRatioDb, bands, ...matchDelta(bands, ref.sideRatioDb, src) },
          matchLoading: false,
        });
      } catch {
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

    // The curve comes off; the reference stays loaded, so an undo brings
    // the curve back WITH the reference it was fitted to.
    clearMatch() {
      if (get().matchEqGains.length === 0) return;
      record(get, 'match');
      set({ matchEqGains: [] });
      pushParams(get);
    },

    setAdvEqOpen(open) {
      set({ advEqOpen: open });
    },

    setStemsOpen(open) {
      set({ stemsOpen: open });
    },

    setAdvBand(index, patch) {
      const cur = get().advEq[index];
      if (!cur) return;
      if ((Object.keys(patch) as (keyof AdvEqBand)[]).every((k) => cur[k] === patch[k])) return;
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
      const v = Math.max(-3, Math.min(3, db));
      if (get().stems[lane] === v) return;
      record(get, `stem:${lane}`);
      set((s) => ({ stems: { ...s.stems, [lane]: v } }));
      pushParams(get);
    },

    async startAudition() {
      const s = get();
      if (!s.loaded || s.audition.busy) return;
      if (s.exportFormat !== 'mp3' && s.exportFormat !== 'opus') return;
      const excerpt = engine.getExcerpt();
      if (!excerpt || !s.source) return;
      const token = ++auditionToken;
      set({ audition: { active: false, mode: 'codec', busy: true } });
      try {
        const params = { ...chainParamsFrom(s), fadeInSec: 0, fadeOutSec: 0, trimStartSec: 0, trimEndSec: 0 };
        const dur = excerpt.l.length / engine.sampleRate;
        // The same mastered excerpt, once lossless and once through the codec.
        const wav = await engine.renderBuffers(
          excerpt.l, excerpt.r, params, s.source.lufs, dur,
          { format: 'wav', bitDepth: 24, mp3Kbps: 320 });
        const codec = await engine.renderBuffers(
          excerpt.l, excerpt.r, params, s.source.lufs, dur,
          { ...encodeOptionsFrom(s), sampleRate: 48000 });
        const masterBuf = await engine.decodeToBuffer(wav.data);
        const codecBuf = await engine.decodeToBuffer(codec.data);
        // Closed, stopped or re-set while rendering: that audition is stale.
        if (token !== auditionToken) return;
        await engine.auditionStart(masterBuf, codecBuf);
        if (token !== auditionToken) { engine.auditionStop(); return; }
        set({ audition: { active: true, mode: 'codec', busy: false } });
      } catch {
        if (token !== auditionToken) return;
        set({ audition: { active: false, mode: 'codec', busy: false } });
        get().pushToast('AUDITION FAILED', 'fault');
      }
    },

    setAuditionMode(mode) {
      engine.auditionSetMode(mode);
      set((s) => ({ audition: { ...s.audition, mode } }));
    },

    stopAudition() {
      auditionToken++;
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

    removeBatchItem(id) {
      const s = get();
      if (s.batchRunning || s.albumAssembling) return;
      batchSources.delete(id);
      set({ batchItems: s.batchItems.filter((it) => it.id !== id) });
    },

    async assembleAlbum() {
      const s = get();
      const bridge = (window as any).jmaster;
      if (!bridge?.appendFile || !bridge?.patchFile || !bridge?.writeFileNew) {
        get().pushToast('ALBUM ASSEMBLY NEEDS THE DESKTOP APP', 'fault');
        return;
      }
      if (s.batchItems.length === 0 || s.albumAssembling || s.batchRunning) return;
      // The loaded track may be on the album, and is about to change.
      if (s.repairing) {
        get().pushToast('THE DRIFT REPAIR IS STILL RUNNING · ASSEMBLE WHEN IT LANDS', 'warn');
        return;
      }
      if (!s.batchDir) {
        await get().chooseBatchDir();
        if (!get().batchDir) return;
      }
      const dir = get().batchDir!;
      // The queue as it stands now: ids, in order. Each track is read
      // fresh when its turn comes (a scan may have landed meanwhile).
      const order = get().batchItems.map((it) => it.id);
      const albumTitle = s.meta.album || 'Album';
      const performer = s.meta.artist || 'Unknown Artist';
      const params = chainParamsFrom(s);
      const gapFrames = Math.round(s.albumGapSec * 75);

      // A disc that can't be burned is caught before the long render.
      if (order.length > CD_MAX_TRACKS) {
        get().pushToast(`A CD HOLDS ${CD_MAX_TRACKS} TRACKS · THIS ALBUM HAS ${order.length}`, 'fault');
        return;
      }
      // Durations the scan has measured are checked now; any it hasn't (still
      // scanning, or unreadable) are checked as each track decodes, before
      // its render, so an image that breaks the limits is never committed.
      const known = get().batchItems.filter((it) => it.durationSec !== undefined);
      const short = known.filter((it) => it.durationSec! < CD_MIN_TRACK_SEC).length;
      if (short > 0) {
        get().pushToast(`CD TRACKS RUN ${CD_MIN_TRACK_SEC} S AT LEAST · ${short} TOO SHORT`, 'fault');
        return;
      }
      const knownTotal = known.reduce((a, it) => a + it.durationSec!, 0) + s.albumGapSec * (order.length - 1);
      if (knownTotal > CD_MAX_SEC) {
        get().pushToast(`${mmss(knownTotal)} WON’T FIT ON A CD · 79:57 AT MOST`, 'fault');
        return;
      }
      const upc = s.albumUpc ? ean13(s.albumUpc) : null;
      const dropped: string[] = [];
      if (s.albumUpc && !upc) dropped.push('BARCODE');

      const setPhase = (phase: string, pct: number) => set({ albumAssembling: { phase, pct } });
      setPhase('STARTING', 0);
      // The image is written beside its final name and only takes it once
      // complete, so a failed run leaves the last good image in place.
      let partial: string | null = null;
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
        const fileBase = asciiFileName(albumTitle);
        partial = (await bridge.writeFileNew(dir, `${fileBase} - CD Image.wav.partial`, header)) as string;
        const imagePart = partial;

        let totalSamples = 0;
        const cueTracks: { title: string; isrc?: string; startFrame: number; lengthSec: number }[] = [];

        for (let idx = 0; idx < order.length; idx++) {
          const item = get().batchItems.find((it) => it.id === order[idx]);
          const src = batchSources.get(order[idx]);
          // The queue is locked while this runs: a track that has gone
          // missing is a fault, not something to leave off the disc quietly.
          if (!item || !src) throw new Error(`TRACK ${idx + 1} IS NO LONGER IN THE QUEUE`);
          const base = (idx / order.length);
          setPhase(`TRACK ${idx + 1}/${order.length} · RENDERING`, base);
          const audio = await itemAudio(get(), src);
          const { l, r, durationSec } = audio;
          if (durationSec < CD_MIN_TRACK_SEC) {
            throw new Error(`TRACK ${idx + 1} IS ${durationSec.toFixed(1)} S · CD TRACKS NEED ${CD_MIN_TRACK_SEC}`);
          }
          if (totalSamples / 44100 + durationSec > CD_MAX_SEC) {
            throw new Error(`TRACK ${idx + 1} RUNS PAST 79:57 · WON’T FIT ON A CD`);
          }
          // Not scanned yet (ASSEMBLE came first): diagnosed here, so its
          // fixes go on the disc like its siblings'.
          let cur = item;
          if (!cur.scanned && !(get().trackPath && src.path === get().trackPath)) {
            try {
              const d = await diagnoseItem(l, r, durationSec, audio.clippedRuns);
              cur = {
                ...cur, scanned: true, lufs: d.lufs, durationSec, balanceOffsetDb: d.balanceOffsetDb,
                fixes: d.fixes, fixesEnabled: (cur.fixesEnabled ?? true) && d.fixes.some((f) => f.checked),
              };
              const done = cur;
              set((st) => ({ batchItems: st.batchItems.map((it) => (it.id === done.id ? done : it)) }));
            } catch { /* rendered without a diagnosis */ }
          }
          const lufs = audio.lufs ?? cur.lufs ?? (await engine.measureLufs(l, r));
          const itemParams = trackParams(get(), params, cur);
          // Mastered straight to CD rate and depth: converted by the app's
          // own filter BEFORE the loudness solve, so the ceiling is held on
          // the very samples that go on the disc.
          const rendered = await engine.renderBuffers(
            l, r, itemParams, lufs, durationSec,
            { format: 'wav', bitDepth: 16, mp3Kbps: 320, sampleRate: 44100, dither: get().exportDither },
            (p) => setPhase(`TRACK ${idx + 1}/${order.length} · ${p.phase}`, base + (p.pct * 0.85) / order.length),
          );
          // The WAV's samples: 16-bit stereo after a 44-byte header.
          const view = new DataView(rendered.data);
          const dataBytes = Math.min(view.getUint32(40, true), rendered.data.byteLength - 44);
          const nS = dataBytes / 4;
          const padded = Math.ceil(nS / CD_FRAME_SAMPLES) * CD_FRAME_SAMPLES;
          const pcm = new ArrayBuffer(padded * 4);
          new Uint8Array(pcm).set(new Uint8Array(rendered.data, 44, dataBytes));
          setPhase(`TRACK ${idx + 1}/${order.length} · WRITING`, base + 0.9 / order.length);
          cueTracks.push({
            title: cur.name.replace(/\.[^.]+$/, ''),
            isrc: cur.isrc,
            startFrame: totalSamples / CD_FRAME_SAMPLES,
            lengthSec: padded / 44100,
          });
          // Stream to disk in 4 MB slices to bound memory.
          for (let off = 0; off < pcm.byteLength; off += 4 << 20) {
            await bridge.appendFile(imagePart, pcm.slice(off, Math.min(pcm.byteLength, off + (4 << 20))));
          }
          totalSamples += padded;
          if (idx < order.length - 1 && gapFrames > 0) {
            await bridge.appendFile(imagePart, new ArrayBuffer(gapFrames * CD_FRAME_SAMPLES * 4));
            totalSamples += gapFrames * CD_FRAME_SAMPLES;
          }
        }

        // Patch the RIFF/data sizes.
        setPhase('FINALISING IMAGE', 0.96);
        const dataSize = totalSamples * 4;
        const riff = new ArrayBuffer(4);
        new DataView(riff).setUint32(0, 36 + dataSize, true);
        await bridge.patchFile(imagePart, 4, riff);
        const dsz = new ArrayBuffer(4);
        new DataView(dsz).setUint32(0, dataSize, true);
        await bridge.patchFile(imagePart, 40, dsz);
        const imagePath: string = await bridge.commitFile(imagePart);
        partial = null;

        // CUE sheet with CD-TEXT, named after the image it points at (the
        // image takes a numbered name when the last one is open elsewhere).
        const imageFile = baseName(imagePath);
        const badIsrc = cueTracks.filter((t) => t.isrc && !ISRC_RE.test(t.isrc)).length;
        if (badIsrc > 0) dropped.push(`${badIsrc} ISRC${badIsrc > 1 ? 'S' : ''}`);
        const cue = buildCue(imageFile, albumTitle, performer, upc, cueTracks);
        const sheetBase = imageFile.replace(/ - CD Image( \(\d+\))?\.wav$/i, (_m, n) => `${n ?? ''}`) || fileBase;
        const cuePath: string = await bridge.writeFileNew(dir, `${sheetBase}.cue`, latin1(cue));

        // Manifest: what the sheet carries, for the replication plant.
        let manifest = `${albumTitle} - ${performer}\r\nAssembled by J-Master (JMW Software)\r\n`;
        manifest += `Image: ${imageFile} · 44.1 kHz / 16-bit · ${(totalSamples / 44100 / 60).toFixed(1)} min\r\n`;
        if (upc) manifest += `UPC/EAN: ${upc}\r\n`;
        manifest += `\r\n`;
        cueTracks.forEach((t, i) => {
          manifest += `${String(i + 1).padStart(2, '0')}  ${mmssff(t.startFrame)}  ${t.title}${t.isrc && ISRC_RE.test(t.isrc) ? `  [${t.isrc}]` : ''}\r\n`;
        });
        const enc = new TextEncoder();
        await bridge.writeFileNew(dir, `${sheetBase} - manifest.txt`, enc.encode(`﻿${manifest}`).buffer);

        set({
          albumAssembling: null,
          albumResult: { imagePath, cuePath, totalMin: totalSamples / 44100 / 60 },
        });
        if (dropped.length > 0) {
          get().pushToast(`CD IMAGE ASSEMBLED · LEFT OUT ${dropped.join(' + ')} (INVALID)`, 'warn');
        } else {
          get().pushToast(`CD IMAGE ASSEMBLED · ${cueTracks.length} TRACKS`, 'run');
        }
      } catch (err) {
        if (partial) await bridge.discardFile?.(partial).catch(() => undefined);
        set({ albumAssembling: null });
        get().pushToast(`ASSEMBLY FAILED · ${fileErrorText(err)}`, 'fault');
      }
      // Anything queued while it ran still wants its scan.
      void scanBatchItems(set, get);
    },

    async masterIt() {
      const s = get();
      if (!s.loaded || s.loading || s.masterItBusy || !s.source) return;
      // The track AUTO is reading: if another has loaded by the time the
      // analysis is in, there is nothing here to apply it to.
      const source = s.source;
      set({ masterItBusy: true });
      try {
        const tempo = await engine.requestTempo();
        const prof = await engine.requestSourceProfile();
        if (get().source !== source) { set({ masterItBusy: false }); return; }
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
          // A band-limited source has nothing above its cut: judged on
          // what it does have, or every such track would read as dark.
          const top = source.checks.cutoffHz && source.checks.cutoffHz < 16000 ? source.checks.cutoffHz : 16000;
          const brightDb = bandAt(Math.min(6000, top / 2.5), top);
          const midDb = bandAt(250, 2000);
          const bpm = tempo?.bpm ?? 0;
          reasons.push(tempo?.drift
            ? `TEMPO ${bpm.toFixed(1)} BPM AVERAGE · DRIFTS ${driftRange(tempo.drift)}`
            : `TEMPO ${bpm > 0 ? bpm.toFixed(1) + ' BPM' : 'UNCLEAR'}${get().driftRepair ? ' · DRIFT REPAIRED' : ''}`);
          reasons.push(`SUB ${subDb >= 0 ? '+' : ''}${subDb.toFixed(1)} dB · BRIGHT ${brightDb >= 0 ? '+' : ''}${brightDb.toFixed(1)} dB · MID ${midDb >= 0 ? '+' : ''}${midDb.toFixed(1)} dB`);
          reasons.push(`DYNAMICS ${source.lra.toFixed(1)} LU RANGE · ${(source.truePeakDb - source.lufs).toFixed(1)} dB PEAK TO LOUDNESS`);
          if (bpm >= 155 && subDb > 2) { presetPick = 'dnb'; reasons.push('FAST + SUB-HEAVY → DRUM & BASS'); }
          else if (bpm >= 118 && bpm <= 138 && subDb > 1.5) { presetPick = 'house'; reasons.push('CLUB TEMPO + SUB → EDM / HOUSE'); }
          else if (bpm >= 95 && bpm < 118 && subDb > 1.5) { presetPick = 'electronic'; reasons.push('MID TEMPO + SUB → ELECTRONIC'); }
          else if (bpm >= 80 && bpm <= 108 && subDb > 3.5) { presetPick = 'hiphop'; reasons.push('SUB-DOMINANT GROOVE → HIP-HOP'); }
          else if (bpm > 0 && bpm < 92 && brightDb < -5) { presetPick = 'rnb'; reasons.push('SLOW + DARK TOP → R&B'); }
          else if (bpm <= 0 && source.lra > 9) { presetPick = 'cinematic'; reasons.push('NO PULSE + WIDE DYNAMICS → CINEMATIC'); }
          else if (bpm <= 0) { presetPick = 'ambient'; reasons.push('NO PULSE → AMBIENT'); }
          else if (brightDb > 1.5 && bpm >= 100 && bpm <= 145) { presetPick = 'pop'; reasons.push('BRIGHT + POP TEMPO → POP'); }
          else if (midDb > 1) { presetPick = 'rock'; reasons.push('MID-FORWARD → ROCK'); }
          else { presetPick = 'pop'; reasons.push('NO STRONG SIGNATURE → POP (SAFE)'); }
        } else {
          reasons.push('NO PROFILE · POP (SAFE)');
        }
        const preset = PRESETS.find((p) => p.id === presetPick)!;
        // A source that arrives already squashed gets less of everything:
        // more glue and drive on top of 6 dB of dynamics only crushes it.
        const plr = source.truePeakDb - source.lufs;
        const amount = source.lufs > -70 && plr < 8 ? 0.6 : source.lufs > -70 && plr < 10 ? 0.8 : 1;
        // One history entry for the whole of AUTO, so UNDO ALL is one undo.
        record(get, 'masterit', { genre: true });
        const historyId = undoStack[undoStack.length - 1]?.id ?? -1;
        historyHeld = true;
        // Everything the sheet found and pre-ticked; what it only offers
        // (a fade-out) stays the user's call.
        const fixes = get().diagIssues.filter((i) => i.checked);
        try {
          set({ presetAmount: amount });
          get().applyPreset(presetPick);
          if (fixes.length > 0) get().applyDiagFixes();
        } finally {
          historyHeld = false;
        }
        reasons.push(`PRESET ${preset.name}${amount < 1 ? ` AT ${Math.round(amount * 100)}% (ALREADY DENSE: ${plr.toFixed(1)} dB PEAK TO LOUDNESS)` : ''} · TARGET ${preset.targetLufs} LUFS`);
        reasons.push(fixes.length > 0
          ? `FIXES ${fixes.map((i) => i.fixLabel).join(' · ')}`
          : 'SOURCE CHECKS CLEAN · NO FIXES NEEDED');
        const offered = get().diagIssues.filter((i) => !i.checked);
        if (offered.length > 0) reasons.push(`LEFT TO YOU IN DIAG: ${offered.map((i) => i.fixLabel).join(' · ')}`);
        if (tempo?.drift) reasons.push('TEMPO DRIFT FLAGGED · REPAIR IT IN DIAG');
        set({ masterItReport: { presetName: preset.name, reasons, historyId }, masterItBusy: false, diagOpen: false });
      } catch {
        set({ masterItBusy: false });
        get().pushToast('AUTO-MASTER FAILED', 'fault');
      }
    },

    closeMasterItReport() {
      set({ masterItReport: null });
    },

    undoMasterIt() {
      const report = get().masterItReport;
      if (!report) return;
      // Only AUTO's own step: after a Ctrl+Z it's already undone (genre and
      // all), and a second undo would take back something unrelated.
      if (undoStack[undoStack.length - 1]?.id === report.historyId) get().undo();
      set({ masterItReport: null });
    },

    undo() {
      const entry = undoStack.pop();
      if (!entry) return;
      // A step made in the other A/B slot is undone there: applied here it
      // would put that slot's console under this slot's lamp.
      if (entry.slot !== get().activeSlot) get().switchSlot(entry.slot);
      redoStack.push(swapEntry(entry, get));
      applyEntry(entry, set, get);
      set({ undoDepth: undoStack.length, redoDepth: redoStack.length });
    },

    redo() {
      const entry = redoStack.pop();
      if (!entry) return;
      if (entry.slot !== get().activeSlot) get().switchSlot(entry.slot);
      undoStack.push(swapEntry(entry, get));
      applyEntry(entry, set, get);
      set({ undoDepth: undoStack.length, redoDepth: redoStack.length });
    },

    applyPreset(id) {
      const preset = findPreset(get(), id);
      if (!preset) return;
      record(get, 'preset', { genre: true });
      // Genre tag follows a genre preset (still editable in the export
      // dialog); a user preset restores the genre it was saved with.
      const genre = presetGenre(preset);
      set((s) => ({
        macros: scaleMacros(preset.macros, s.presetAmount),
        targetLufs: preset.targetLufs,
        ceilingDb: preset.ceilingDb,
        presetId: id,
        lastPresetId: id,
        platformId: null,
        meta: genre ? { ...s.meta, genre } : s.meta,
      }));
      pushParams(get);
    },

    setPresetAmount(raw) {
      const amount = +Math.max(AMOUNT_RANGE[0], Math.min(AMOUNT_RANGE[1], raw)).toFixed(2);
      const s = get();
      if (amount === s.presetAmount) return;
      const base = findPreset(s, s.presetId ?? s.lastPresetId);
      record(get, 'amount');
      if (!base) { set({ presetAmount: amount }); return; }
      // The knobs follow the preset at its new strength; target and
      // ceiling are the preset's delivery spec and stay as they are.
      set({ presetAmount: amount, macros: scaleMacros(base.macros, amount), presetId: base.id, lastPresetId: base.id });
      pushParams(get);
    },

    saveUserPreset(rawName) {
      const name = rawName.trim().toUpperCase().slice(0, 28);
      if (!name) return;
      const s = get();
      const existing = s.userPresets.find((p) => p.name === name);
      const preset: UserPreset = {
        id: existing?.id ?? `u-${Date.now().toString(36)}`,
        name,
        // As the console stands: whatever amount was dialled in is the
        // new preset's 100%.
        macros: { ...s.macros },
        targetLufs: s.targetLufs,
        ceilingDb: s.ceilingDb,
        genre: s.meta.genre || undefined,
        favourite: existing?.favourite,
        savedAt: new Date().toISOString(),
      };
      set({
        userPresets: existing
          ? s.userPresets.map((p) => (p.id === existing.id ? preset : p))
          : [preset, ...s.userPresets],
        presetId: preset.id,
        lastPresetId: preset.id,
        presetAmount: 1,
      });
      get().pushToast(`${existing ? 'UPDATED' : 'SAVED'} PRESET · ${name}`, 'run');
    },

    deleteUserPreset(id) {
      const s = get();
      const gone = s.userPresets.find((p) => p.id === id);
      if (!gone) return;
      set({
        userPresets: s.userPresets.filter((p) => p.id !== id),
        presetId: s.presetId === id ? null : s.presetId,
        lastPresetId: s.lastPresetId === id ? null : s.lastPresetId,
        // A queued track set to it goes back to the console, visibly.
        batchItems: s.batchItems.map((it) => (it.presetId === id ? { ...it, presetId: null } : it)),
      });
      get().pushToast(`DELETED PRESET · ${gone.name}`, 'info');
    },

    toggleFavourite(id) {
      const s = get();
      if (s.userPresets.some((p) => p.id === id)) {
        set({ userPresets: s.userPresets.map((p) => (p.id === id ? { ...p, favourite: !p.favourite } : p)) });
      } else if (PRESETS.some((p) => p.id === id)) {
        set({ favourites: s.favourites.includes(id) ? s.favourites.filter((f) => f !== id) : [...s.favourites, id] });
      }
    },

    revertPreset() {
      const id = get().lastPresetId;
      if (id && findPreset(get(), id)) get().applyPreset(id);
    },

    toggleExportExtra(format) {
      set((s) => ({
        exportExtras: s.exportExtras.includes(format)
          ? s.exportExtras.filter((f) => f !== format)
          : [...s.exportExtras, format],
      }));
    },

    applyPlatform(id) {
      const platform = PLATFORMS.find((p) => p.id === id);
      if (!platform) return;
      const s = get();
      if (s.platformId === id && s.targetLufs === platform.targetLufs && s.ceilingDb === platform.ceilingDb) return;
      record(get, 'platform');
      set({ targetLufs: platform.targetLufs, ceilingDb: platform.ceilingDb, platformId: id });
      pushParams(get);
    },

    nudgeTarget(delta) {
      const next = Math.max(-24, Math.min(-6, +(get().targetLufs + delta).toFixed(1)));
      if (next === get().targetLufs) return;
      record(get, 'target');
      set({ targetLufs: next, platformId: null });
      pushParams(get);
    },

    nudgeCeiling(delta) {
      const next = Math.max(-3, Math.min(-0.1, +(get().ceilingDb + delta).toFixed(1)));
      if (next === get().ceilingDb) return;
      record(get, 'ceiling');
      set({ ceilingDb: next, platformId: null });
      pushParams(get);
    },

    setClipMode(mode) {
      if (mode === get().clipMode) return;
      record(get, 'clip');
      set({ clipMode: mode });
      pushParams(get);
    },

    setFade(which, sec) {
      const s = get();
      const dur = s.source?.durationSec ?? 60;
      const clamped = Math.max(0, Math.min(keptLength(s, dur) / 2, sec));
      if (clamped === (which === 'in' ? s.fadeInSec : s.fadeOutSec)) return;
      record(get, `fade:${which}`);
      set(which === 'in' ? { fadeInSec: clamped } : { fadeOutSec: clamped });
      pushParams(get);
    },

    setFadeCurve(which, curve) {
      if (curve === (which === 'in' ? get().fadeInCurve : get().fadeOutCurve)) return;
      record(get, 'fadecurve');
      set(which === 'in' ? { fadeInCurve: curve } : { fadeOutCurve: curve });
      pushParams(get);
    },

    setTrim(which, sec) {
      const s = get();
      if (!s.source) return;
      const dur = s.source.durationSec;
      // At least a second is kept, and an end at the very end is no trim.
      const end = s.trimEndSec > 0 ? s.trimEndSec : dur;
      let trimStartSec = s.trimStartSec, trimEndSec = s.trimEndSec;
      if (which === 'start') trimStartSec = +Math.max(0, Math.min(end - 1, sec)).toFixed(3);
      else {
        const e = Math.max(s.trimStartSec + 1, Math.min(dur, sec));
        trimEndSec = e >= dur - 0.001 ? 0 : +e.toFixed(3);
      }
      if (trimStartSec === s.trimStartSec && trimEndSec === s.trimEndSec) return;
      record(get, `trim:${which}`);
      const half = keptLength({ trimStartSec, trimEndSec }, dur) / 2;
      set({ trimStartSec, trimEndSec, fadeInSec: Math.min(s.fadeInSec, half), fadeOutSec: Math.min(s.fadeOutSec, half) });
      pushParams(get);
    },

    clearTrim() {
      const s = get();
      if (s.trimStartSec === 0 && s.trimEndSec === 0) return;
      record(get, 'trim');
      set({ trimStartSec: 0, trimEndSec: 0 });
      pushParams(get);
    },

    setAirRestore(raw) {
      const amount = +Math.max(0, Math.min(1, raw)).toFixed(3);
      const s = get();
      if (amount === s.airRestore) return;
      record(get, 'restore');
      // Where the source stops, when the check found a cut; otherwise the
      // usual place a lossy file does.
      const cut = s.source?.checks.cutoffHz;
      set({ airRestore: amount, airRestoreHz: cut && cut < 20000 ? cut : s.airRestoreHz });
      pushParams(get);
    },

    setSourceFix(mode) {
      if (mode === get().sourceFix) return;
      record(get, 'sourcefix');
      set({ sourceFix: mode });
      pushParams(get);
    },

    setBypass(on) {
      set({ bypass: on });
      pushParams(get);
    },

    setNormPreview(platformId) {
      set({ normPreview: platformId });
      pushParams(get);
    },

    setMeterView(view) {
      set({ meterView: view });
    },

    setSpectrumSlope(on) {
      set({ spectrumSlope: on });
    },

    setMonitor(mode) {
      set({ monitor: mode });
      pushParams(get);
    },

    setLimiterDelta(on) {
      set({ limiterDelta: on });
      pushParams(get);
    },

    setBalance(db) {
      const next = Math.max(-3, Math.min(3, +db.toFixed(1)));
      if (next === get().balanceDb) return;
      record(get, 'balance');
      set({ balanceDb: next });
      pushParams(get);
    },

    autoCenter() {
      const off = get().source?.balanceOffsetDb ?? 0;
      const next = Math.max(-3, Math.min(3, +(-off).toFixed(1)));
      if (next !== get().balanceDb) {
        record(get, 'autocenter');
        set({ balanceDb: next });
        pushParams(get);
      }
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

    setTempoLane(on) {
      set({ tempoLane: on });
    },

    setFollowPlayhead(on) {
      set({ followPlayhead: on });
    },

    rescaleTempo(factor) {
      const cur = get().tempo;
      if (!cur || cur.bpm <= 0 || get().repairing) return;
      const next = cur.bpm * factor;
      if (next < 40 || next > 300) return;
      const t = engine.rescaleTempo(factor);
      if (!t) return;
      // A repair in place was described in the old reading: its figures follow.
      const rep = get().driftRepair;
      if (rep) {
        set({ driftRepair: { ...rep, targetBpm: rep.targetBpm * factor, fromBpm: rep.fromBpm * factor, toBpm: rep.toBpm * factor } });
      }
      applyTempo(t, set, get, false);
      get().pushToast(`TEMPO READ AT ${factor === 2 ? 'DOUBLE' : 'HALF'} TIME · ${bpmText(t.bpm)} BPM`, 'info');
    },

    focusWave(startSec, endSec) {
      set((s) => ({ waveFocus: { startSec, endSec, seq: (s.waveFocus?.seq ?? 0) + 1 } }));
    },

    openRepair(open) {
      set({ repairOpen: open });
    },

    async repairDrift(targetBpm) {
      const s = get();
      if (!s.loaded || !s.source || s.loading || s.repairing || busyWith(s)) return;
      const token = ++repairToken;
      set({ repairing: { targetBpm, pct: 0 } });
      try {
        const swap = await engine.repairDrift(targetBpm, (pct) => {
          if (token === repairToken) set({ repairing: { targetBpm, pct } });
        });
        if (!swap) return;
        // The engine has just switched takes, and nothing has run since:
        // the playhead, loop and transport are still where the last take
        // had them, and the swap maps them onto the repair.
        const st = get();
        const base = engine.repairBase();
        const drift = base?.tempo.drift ?? null;
        const originalDurationSec = engine.repair?.originalDurationSec ?? swap.info.durationSec;
        swapTake(swap.info, {
          targetBpm,
          fromBpm: drift?.refBpm ?? base?.tempo.bpm ?? targetBpm,
          toBpm: drift?.endBpm ?? base?.tempo.bpm ?? targetBpm,
          originalDurationSec,
        }, listenerIn(st, swap.map), set, get);
        set({ repairOpen: false });
        get().pushToast(
          `DRIFT REPAIRED · STEADY ${bpmText(targetBpm)} BPM · ${mmss(originalDurationSec)} → ${mmss(swap.info.durationSec)}`, 'run');
        void engine.requestTempo().then((t) => {
          if (get().source === swap.info) applyTempo(t, set, get);
        });
      } catch (err) {
        if (token !== repairToken) return;
        get().pushToast(`REPAIR FAILED · ${String((err as Error)?.message ?? err).toUpperCase()}`, 'fault');
      } finally {
        if (token === repairToken) set({ repairing: null });
      }
    },

    cancelRepair() {
      if (!get().repairing) return;
      if (engine.cancelRepair()) get().pushToast('REPAIR CANCELLED', 'info');
    },

    revertRepair() {
      const s = get();
      if (!s.driftRepair || s.loading || s.repairing || busyWith(s)) return;
      // At once: the file's analysis was kept, so nothing is measured again.
      const swap = engine.revertRepair();
      if (!swap) return;
      repairToken++;
      swapTake(swap.info, null, listenerIn(s, swap.map), set, get);
      void engine.requestTempo().then((t) => {
        if (get().source === swap.info) applyTempo(t, set, get, false);
      });
      get().pushToast('DRIFT REPAIR REMOVED · THE FILE PLAYS AGAIN', 'info');
    },

    async saveRepairedWav() {
      const s = get();
      const repair = s.driftRepair;
      if (!repair || !s.source) return;
      const data = engine.repairedWav();
      if (!data) return;
      const name = `${s.source.name.replace(/\.[^.]+$/, '')} (steady ${bpmText(repair.targetBpm)} BPM).wav`;
      try {
        const saved = await saveExportFile(data, name, 'audio/wav');
        if (saved) get().pushToast(`SAVED ${baseName(saved).toUpperCase()}`, 'run');
      } catch (err) {
        get().pushToast(`SAVE FAILED · ${fileErrorText(err)}`, 'fault');
      }
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
      const s = get();
      const src = s.source;
      if (!src) { set({ diagOpen: false }); return; }
      const todo = s.diagIssues.filter((i) => i.checked && !fixApplied(i, s, src.balanceOffsetDb));
      if (todo.length === 0) { set({ diagOpen: false }); return; }
      record(get, 'diagfix');
      const applied: string[] = [];
      for (const issue of todo) {
        const a = issue.action;
        switch (a.type) {
          case 'bassMono':
            set({ bassMono: true });
            break;
          case 'width':
            // Narrow to the suggestion; a width already narrower stays.
            if (get().macros.width > a.value) set((st) => ({ macros: { ...st.macros, width: a.value }, presetId: null }));
            break;
          case 'balance':
            set({ balanceDb: Math.max(-3, Math.min(3, +(-src.balanceOffsetDb).toFixed(1))) });
            break;
          case 'smooth':
            set((st) => ({
              macros: { ...st.macros, smooth: Math.max(st.macros.smooth, a.value) },
              presetId: null,
            }));
            break;
          case 'sourceFix':
            set({ sourceFix: a.mode });
            break;
          case 'restoreAir':
            set({ airRestore: a.amount, airRestoreHz: a.hz });
            break;
          case 'trim': {
            const trimStartSec = a.startSec > 0 ? a.startSec : get().trimStartSec;
            const trimEndSec = a.endSec > 0 ? a.endSec : get().trimEndSec;
            const half = keptLength({ trimStartSec, trimEndSec }, src.durationSec) / 2;
            set((st) => ({ trimStartSec, trimEndSec, fadeInSec: Math.min(st.fadeInSec, half), fadeOutSec: Math.min(st.fadeOutSec, half) }));
            break;
          }
          case 'fadeIn':
            set((st) => ({ fadeInSec: Math.max(st.fadeInSec, a.sec) }));
            break;
          case 'fadeOut':
            set((st) => ({ fadeOutSec: Math.max(st.fadeOutSec, Math.min(a.sec, keptLength(st, src.durationSec) / 2)) }));
            break;
        }
        applied.push(issue.fixLabel);
      }
      set({ diagOpen: false });
      pushParams(get);
      get().pushToast(`${applied.length} FIX${applied.length > 1 ? 'ES' : ''} APPLIED · ${applied.join(' · ')}`, 'run');
    },

    switchSlot(slot) {
      const s = get();
      if (slot === s.activeSlot) return;
      // The slots are their own memory, outside undo. Each holds the whole
      // sound, EQ drawers and stem trims included, and none of the track's
      // corrections: those stay with the track whichever slot is lit.
      const incoming = s.snapshots[slot];
      set({
        snapshots: { ...s.snapshots, [s.activeSlot]: captureSound(s) },
        activeSlot: slot,
        ...(incoming ? soundPatch(incoming) : {}),
      });
      pushParams(get);
    },

    copyToOtherSlot() {
      const s = get();
      const other: Slot = s.activeSlot === 'A' ? 'B' : 'A';
      set({ snapshots: { ...s.snapshots, [other]: captureSound(s) } });
      get().pushToast(`CONSOLE COPIED TO ${other}`, 'info');
    },

    togglePlay() {
      if (!get().loaded || get().loading) return;
      if (get().playing) {
        engine.pause();
        set({ playing: false });
      } else {
        // One sound at a time: the transport takes over from an audition.
        if (get().audition.active) get().stopAudition();
        void engine.play();
        set({ playing: true });
      }
    },

    stop() {
      engine.stop();
      set({ playing: false, playheadSec: get().trimStartSec });
    },

    seekSec(sec) {
      if (!Number.isFinite(sec)) return;
      const d = get().source?.durationSec ?? 0;
      const t = Math.max(0, Math.min(d, sec));
      engine.seekSec(t);
      set({ playheadSec: t });
    },

    toggleLoop(atSec) {
      const s = get();
      if (!s.loaded || !s.source) return;
      const pos = atSec ?? s.playheadSec;
      let start = 0;
      let end = s.source.durationSec;
      let label = 'TRACK';
      const sect = (s.tempo?.sections ?? []).find((x) => pos >= x.startSec && pos < x.endSec);
      if (sect && (s.tempo?.sections.length ?? 0) > 1) { start = sect.startSec; end = sect.endSec; label = sect.label; }
      const same =
        s.loopStartSec !== null &&
        Math.abs(s.loopStartSec - start) < 0.01 &&
        Math.abs((s.loopEndSec ?? 0) - end) < 0.01;
      // Any loop at all, and the key turns it off; none, and it loops the
      // section under the playhead.
      if (same || (atSec === undefined && s.loopStartSec !== null)) {
        get().clearLoop();
      } else {
        engine.setLoop(start, end);
        set({ loopStartSec: start, loopEndSec: end });
        get().pushToast(`LOOP · ${label} ${mmss(start)}-${mmss(end)}`, 'run');
      }
    },

    setLoopRange(a, b) {
      const s = get();
      if (!s.loaded || !s.source) return;
      const start = Math.max(0, Math.min(a, b));
      const end = Math.min(s.source.durationSec, Math.max(a, b));
      if (end - start < 0.05) return;
      engine.setLoop(start, end);
      set({ loopStartSec: start, loopEndSec: end });
    },

    clearLoop() {
      if (get().loopStartSec === null) return;
      engine.setLoop(null, null);
      set({ loopStartSec: null, loopEndSec: null });
      get().pushToast('LOOP OFF', 'info');
    },

    pruneRecentFile(path) {
      set((s) => ({ recentFiles: s.recentFiles.filter((r) => r.path !== path) }));
    },

    openKeys(open) {
      set({ keysOpen: open });
    },

    openPalette(open) {
      set({ paletteOpen: open });
    },

    setFileDrag(info) {
      const cur = get().fileDrag;
      if (cur === info) return;
      if (cur && info && cur.count === info.count && cur.images === info.images) return;
      set({ fileDrag: info });
    },

    async setCoverFromFile(file) {
      try {
        const bmp = await createImageBitmap(file);
        const scale = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
        if (!blob) throw new Error('encode failed');
        const data = new Uint8Array(await blob.arrayBuffer());
        set({ coverArt: { mime: 'image/jpeg', data, width: w, height: h, name: file.name } });
        get().pushToast(`COVER SET · ${w}×${h} · ${Math.max(1, Math.round(data.length / 1024))} KB JPEG`, 'run');
      } catch {
        get().pushToast('COVER IMAGE UNREADABLE', 'fault');
      }
    },

    clearCover() {
      set({ coverArt: null });
    },

    setTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      set({ theme });
    },

    setWaveView(view) {
      set({ waveView: view });
    },

    openExport(open) {
      // Mid-load the engine already holds the new track's samples while the
      // console still shows the old one's loudness: nothing to export yet.
      if (open && get().loading) return;
      // Every way out (CANCEL, DONE, scrim, Esc) ends the codec audition.
      if (!open) { const a = get().audition; if (a.active || a.busy) get().stopAudition(); }
      set({ exportOpen: open, exportStats: open ? null : get().exportStats, exportSavedTo: null });
      if (!open) set({ exporting: null });
    },

    // A running audition compares the codec it was rendered with, so a new
    // format or bitrate ends it rather than mislabel it.
    setExportFormat(format) {
      stopStaleAudition(get);
      // Float is a WAV thing; another format falls back to 24-bit.
      set((s) => ({ exportFormat: format, exportBitDepth: format !== 'wav' && s.exportBitDepth === 32 ? 24 : s.exportBitDepth }));
    },
    setExportBitDepth(depth) { set((s) => ({ exportBitDepth: depth === 32 && s.exportFormat !== 'wav' ? 24 : depth })); },
    setExportRate(rate) { set({ exportRate: rate }); },
    setExportDither(kind) { set({ exportDither: kind }); },
    setExportMp3Kbps(kbps) { stopStaleAudition(get); set({ exportMp3Kbps: kbps }); },
    setExportOpusKbps(kbps) { stopStaleAudition(get); set({ exportOpusKbps: kbps }); },

    async saveProject() {
      const s = get();
      // The presets this session leans on travel with it.
      const used = new Set<string>([s.presetId ?? '', s.lastPresetId ?? '', s.snapshots.A?.presetId ?? '',
        s.snapshots.B?.presetId ?? '', ...s.batchItems.map((it) => it.presetId ?? '')]);
      const proj: ProjectFile = {
        app: 'J-Master',
        fileVersion: 2,
        savedAt: new Date().toISOString(),
        track: s.source
          ? {
              name: s.source.name, path: s.trackPath,
              ...(engine.tempoScale !== 1 ? { tempoScale: engine.tempoScale } : {}),
              ...(repairToSave(s) ? { repair: repairToSave(s)! } : {}),
            }
          : pendingProject
            ? {
                ...pendingProject.track,
                ...(pendingProject.tempoScale !== 1 ? { tempoScale: pendingProject.tempoScale } : {}),
                ...(pendingProject.repair ? { repair: pendingProject.repair } : {}),
              }
            : null,
        // Its own track still to come: the corrections on file are that
        // track's, not whatever is on the console meanwhile.
        console: !s.source && pendingProject ? { ...captureConsole(s), ...pendingProject.corrections } : captureConsole(s),
        snapshots: { ...s.snapshots, [s.activeSlot]: captureSound(s) },
        activeSlot: s.activeSlot,
        meta: s.meta,
        export: {
          format: s.exportFormat, bitDepth: s.exportBitDepth,
          mp3Kbps: s.exportMp3Kbps, opusKbps: s.exportOpusKbps,
          rate: s.exportRate, dither: s.exportDither,
        },
        batch: {
          dir: s.batchDir,
          items: s.batchItems.map((it) => ({
            name: it.name,
            path: batchSources.get(it.id)?.path ?? null,
            presetId: it.presetId ?? null,
            isrc: it.isrc,
            fixesEnabled: it.fixesEnabled,
          })),
        },
        album: { upc: s.albumUpc, gapSec: s.albumGapSec },
        presets: s.userPresets.filter((p) => used.has(p.id)),
        cover: s.coverArt
          ? {
              mime: s.coverArt.mime, name: s.coverArt.name,
              width: s.coverArt.width, height: s.coverArt.height,
              b64: bytesToB64(s.coverArt.data),
            }
          : null,
      };
      const json = JSON.stringify(proj, null, 2);
      const base = s.source ? s.source.name.replace(/\.[^.]+$/, '') : 'session';
      const bridge = (window as any).jmaster;
      try {
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
      } catch (err) {
        get().pushToast(`COULDN'T SAVE THE PROJECT · ${fileErrorText(err)}`, 'fault');
      }
    },
    setMeta(field, value) {
      set((s) => ({ meta: { ...s.meta, [field]: value } }));
    },

    startExport(fileName, title) {
      const s = get();
      if (!s.loaded || s.loading || s.exporting || !s.source) return;
      // The track is about to change under the render.
      if (s.repairing) {
        get().pushToast('THE DRIFT REPAIR IS STILL RUNNING · EXPORT WHEN IT LANDS', 'warn');
        return;
      }
      // The audition's loop would play on under the render and its result.
      stopStaleAudition(get);
      set({ exporting: { phase: 'STARTING', pct: 0 }, exportStats: null, exportSavedTo: null, exportExtrasSaved: [] });
      const source = s.source;
      const tags = tagsFrom(s, title);
      const main: EncodeOptions = { ...encodeOptionsFrom(s), tags };
      const extras: EncodeOptions[] = s.exportExtras
        .filter((f) => f !== s.exportFormat)
        .map((f) => ({ ...encodeOptionsFrom(s), format: f, tags }));
      const consoleAtRender = captureConsole(s);
      // A typed name may lack the extension or carry another format's.
      fileName = withFormatExt(fileName, s.exportFormat);
      engine.startExport(
        chainParamsFrom(s),
        main,
        (p) => set({ exporting: p }),
        async (result) => {
          set({ exporting: { phase: 'SAVING', pct: 0.96 } });
          // What a player will make of a lossy file: its peaks, decoded.
          const stats: ExportStats = { ...result.stats };
          if (stats.format === 'mp3' || stats.format === 'opus') {
            try {
              stats.codecPeakDb = await engine.measureEncodedPeak(result.data);
            } catch { /* the file is fine; its decoded peak just isn't known */ }
          }
          let saved: string | null;
          try {
            saved = await saveExportFile(result.data, fileName, result.mime);
          } catch (err) {
            set({ exporting: null });
            get().pushToast(`COULDN'T SAVE THE MASTER · ${fileErrorText(err)}`, 'fault');
            return;
          }
          const history: ExportHistoryEntry[] = [];
          const extrasSaved: string[] = [];
          const when = new Date().toISOString();
          let dir: string | null = null;
          let savedName = fileName;
          if (saved) {
            const onDisk = isPath(saved);
            history.push({
              name: fileName, path: onDisk ? saved : null, format: stats.format,
              bytes: stats.bytes, lufs: stats.integratedLufs,
              truePeakDb: stats.truePeakDb, when,
            });
            // Companions go beside the master, named after the file the Save
            // dialog actually wrote; the browser preview downloads them.
            dir = onDisk ? folderOf(saved) : null;
            savedName = onDisk ? baseName(saved) : fileName;
            const bridge = (window as any).jmaster;
            for (const x of result.extras ?? []) {
              const opts = extras.find((e) => e.format === x.format) ?? { ...main, format: x.format as ExportFormat };
              const name = companionFileName(savedName, source.name, main, opts);
              try {
                const where: string | null = dir && bridge?.saveFileTo
                  ? await bridge.saveFileTo(dir, name, x.data)
                  : await saveExportFile(x.data, name, x.mime);
                if (!where) continue;
                extrasSaved.push(where);
                history.push({
                  name, path: isPath(where) ? where : null, format: x.format,
                  bytes: x.bytes, lufs: stats.integratedLufs, truePeakDb: stats.truePeakDb, when,
                });
              } catch (err) {
                get().pushToast(`COULDN'T SAVE ${name.toUpperCase()} · ${fileErrorText(err)}`, 'fault');
              }
            }
          }
          const st = get();
          set({
            exporting: null, exportStats: stats, exportSavedTo: saved, exportExtrasSaved: extrasSaved,
            exportHistory: [...history, ...st.exportHistory].slice(0, 20),
            lastExport: saved
              ? exportRecord(s, source, consoleAtRender, stats, result.report ?? null, savedName, dir, title, when)
              : null,
          });
          get().pushToast(
            saved
              ? `MASTER SAVED${extrasSaved.length ? ` · +${extrasSaved.length} FORMAT${extrasSaved.length > 1 ? 'S' : ''}` : ''}`
              : 'EXPORT CANCELLED',
            saved ? 'run' : 'info',
          );
          if (!saved) return;
          if (stats.loudnessMeasured === false) {
            get().pushToast('TOO QUIET TO MEASURE · RENDERED AT UNITY GAIN, NOT THE TARGET', 'warn');
          } else if (stats.targetReached === false) {
            get().pushToast(
              `TARGET OUT OF REACH UNDER ${stats.ceilingDb?.toFixed(1) ?? ''} dBTP · LANDED AT ${stats.integratedLufs.toFixed(1)} LUFS`, 'warn');
          }
          const ceiling = stats.ceilingDb ?? s.ceilingDb;
          if (stats.codecPeakDb !== undefined && stats.codecPeakDb > ceiling + 0.2) {
            get().pushToast(
              `DECODED, THE ${stats.format.toUpperCase()} PEAKS AT ${stats.codecPeakDb.toFixed(1)} dBTP · A LOWER CEILING LEAVES THE CODEC ROOM`, 'warn');
          }
        },
        (message) => {
          set({ exporting: null });
          get().pushToast(`RENDER FAILED · ${message.toUpperCase()}`, 'fault');
        },
        extras,
      );
    },

    async saveReport() {
      const last = get().lastExport;
      if (!last) return;
      const html = buildReport(last);
      const name = `${last.fileName.replace(/\.[^.]+$/, '')} - report.html`;
      const data = new TextEncoder().encode(html).buffer as ArrayBuffer;
      const bridge = (window as any).jmaster;
      try {
        const where: string | null = last.dir && bridge?.saveFileTo
          ? await bridge.saveFileTo(last.dir, name, data)
          : await saveExportFile(data, name, 'text/html');
        if (!where) return;
        get().pushToast(`REPORT SAVED · ${baseName(where).toUpperCase()}`, 'run');
        // Straight into the browser: a spec sheet is for reading.
        if (isPath(where)) void bridge?.openSaved?.(where);
      } catch (err) {
        get().pushToast(`COULDN'T SAVE THE REPORT · ${fileErrorText(err)}`, 'fault');
      }
    },

    openBatch(open) {
      set({ batchOpen: open });
    },

    async addBatchFiles() {
      const bridge = (window as any).jmaster;
      if (bridge?.pickFiles) {
        let picked: { name: string; path: string }[] | null;
        try {
          picked = await bridge.pickFiles();
        } catch (err) {
          get().pushToast(`CAN'T ADD TRACKS · ${fileErrorText(err)}`, 'fault');
          return;
        }
        if (!picked) return;
        // A file already in the queue is not added again.
        const have = new Set([...batchSources.values()].map((v) => v.path).filter(Boolean));
        const items: BatchItem[] = picked.filter((p) => !have.has(p.path)).map((p) => {
          const id = batchSeq++;
          batchSources.set(id, { path: p.path });
          return { id, name: p.name, status: 'pending' as BatchStatus, pct: 0, phase: '' };
        });
        set((s) => ({ batchItems: [...s.batchItems, ...items] }));
        void scanBatchItems(set, get);
        return;
      }
      // Browser fallback: multi-select input.
      await new Promise<void>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.wav,.flac,.mp3,.ogg,.opus,.m4a,audio/*';
        input.onchange = () => {
          get().addBatchDroppedFiles(Array.from(input.files ?? []));
          resolve();
        };
        input.click();
      });
    },

    addBatchDroppedFiles(files) {
      const have = new Set([...batchSources.values()].map((v) => v.path).filter(Boolean));
      const items: BatchItem[] = [];
      for (const f of files) {
        const path = filePathOf(f) ?? undefined;
        if (path && have.has(path)) continue;
        const id = batchSeq++;
        batchSources.set(id, { file: f, path });
        items.push({ id, name: f.name, status: 'pending' as BatchStatus, pct: 0, phase: '' });
      }
      set((s) => ({ batchItems: [...s.batchItems, ...items] }));
      void scanBatchItems(set, get);
    },

    setOutSplit(on) {
      set({ outSplit: on });
    },

    setProcessedView(on) {
      set({ processedView: on });
      if (on) {
        engine.scheduleProcessedPreview(chainParamsFrom(get()), 100);
      } else {
        engine.releasePreview();
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
      if (get().batchRunning || get().albumAssembling) return;
      batchSources.clear();
      set({ batchItems: [] });
    },

    async chooseBatchDir() {
      const bridge = (window as any).jmaster;
      if (bridge?.chooseDirectory) {
        try {
          const dir = await bridge.chooseDirectory();
          if (dir) set({ batchDir: dir });
        } catch (err) {
          get().pushToast(`CAN'T USE THAT FOLDER · ${fileErrorText(err)}`, 'fault');
        }
      }
    },

    async startBatch() {
      const s = get();
      if (s.batchRunning || s.albumAssembling || s.batchItems.length === 0) return;
      // The loaded track may be in the queue, and is about to change.
      if (s.repairing) {
        get().pushToast('THE DRIFT REPAIR IS STILL RUNNING · MASTER WHEN IT LANDS', 'warn');
        return;
      }
      batchCancelled = false;
      // Everything already mastered: MASTER ALL means again, with the
      // console as it is now. Otherwise only what's left (or failed) runs.
      if (s.batchItems.every((it) => it.status === 'done')) {
        set({
          batchItems: s.batchItems.map((it) => ({
            ...it, status: 'pending' as BatchStatus, pct: 0, phase: '', outLufs: undefined, outPath: undefined, error: undefined,
          })),
        });
      }
      set({ batchRunning: true });
      let rendered = 0;
      const params = chainParamsFrom(s);
      const encode = encodeOptionsFrom(s);
      const bridge = (window as any).jmaster;

      const patch = (id: number, p: Partial<BatchItem>) =>
        set((st) => ({
          batchItems: st.batchItems.map((it) => (it.id === id ? { ...it, ...p } : it)),
        }));

      // The queue by id, as it stood when the run began; each track is
      // read fresh from the store when its turn comes, so a scan result
      // (or a preset change) that landed meanwhile is the one used.
      const order = get().batchItems.map((it) => it.id);
      for (const id of order) {
        if (batchCancelled) break;
        let item = get().batchItems.find((it) => it.id === id);
        if (!item || item.status === 'done') continue;
        const src = batchSources.get(id);
        if (!src) { patch(id, { status: 'failed', phase: 'FAILED', error: 'ITS FILE IS NO LONGER IN THE QUEUE' }); continue; }
        try {
          patch(id, { status: 'working', phase: 'READING', pct: 0.02 });
          const audio = await itemAudio(get(), src, () => patch(id, { phase: 'DECODING', pct: 0.06 }));
          const { l, r, durationSec } = audio;

          // Its own diagnosis, when the scan hasn't reached it: MASTER ALL
          // pressed early must not cost the later tracks their fixes.
          item = get().batchItems.find((it) => it.id === id) ?? item;
          const isLoaded = !!get().trackPath && src.path === get().trackPath;
          if (!item.scanned && !isLoaded) {
            patch(id, { phase: 'ANALYSING', pct: 0.1 });
            try {
              const d = await diagnoseItem(l, r, durationSec, audio.clippedRuns);
              patch(id, {
                scanned: true, lufs: d.lufs, durationSec, balanceOffsetDb: d.balanceOffsetDb,
                fixes: d.fixes, fixesEnabled: (item.fixesEnabled ?? true) && d.fixes.some((f) => f.checked),
              });
              item = get().batchItems.find((it) => it.id === id) ?? item;
            } catch { /* rendered without a diagnosis */ }
          }
          let lufs = audio.lufs ?? item.lufs;
          if (lufs === undefined) {
            patch(id, { phase: 'ANALYSING', pct: 0.12 });
            lufs = await engine.measureLufs(l, r);
          }

          const idx = get().batchItems.findIndex((it) => it.id === id);
          const trackTags = tagsFrom(
            get(),
            item.name.replace(/\.[^.]+$/, ''),
            idx + 1,
            get().batchItems.length,
            item.isrc,
          );
          // A per-track preset also tags the file with its genre.
          const override = findPreset(get(), item.presetId);
          if (override) {
            const genre = presetGenre(override);
            if (genre) trackTags.genre = genre;
          }
          const itemParams = trackParams(get(), params, item);
          const result = await engine.renderBuffers(
            l, r, itemParams, lufs, durationSec, { ...encode, tags: trackTags },
            (p) => patch(id, { phase: p.phase, pct: 0.15 + p.pct * 0.8 }),
          );

          patch(id, { phase: 'SAVING', pct: 0.97 });
          const outName = masterFileName(item.name, encode);
          let outPath: string | null;
          if (bridge?.saveFileTo && get().batchDir) {
            outPath = await bridge.saveFileTo(get().batchDir, outName, result.data);
          } else {
            outPath = await saveExportFile(result.data, outName, result.mime);
          }
          patch(id, {
            status: 'done', pct: 1,
            phase: result.stats.targetReached === false ? 'DONE · SHORT OF TARGET' : 'DONE', error: undefined,
            outLufs: result.stats.integratedLufs,
            outPath: outPath ?? undefined,
          });
          rendered++;
          if (outPath) {
            const entry: ExportHistoryEntry = {
              name: outName,
              path: isPath(outPath) ? outPath : null,
              format: result.stats.format,
              bytes: result.stats.bytes,
              lufs: result.stats.integratedLufs,
              truePeakDb: result.stats.truePeakDb,
              when: new Date().toISOString(),
            };
            set((s2) => ({ exportHistory: [entry, ...s2.exportHistory].slice(0, 20) }));
          }
        } catch (err) {
          patch(id, { status: 'failed', phase: 'FAILED', error: fileErrorText(err) });
        }
      }
      set({ batchRunning: false });
      const failed = get().batchItems.filter((i) => i.status === 'failed').length;
      get().pushToast(
        batchCancelled ? `BATCH STOPPED · ${rendered} MASTERED`
          : `BATCH COMPLETE · ${rendered} MASTERED${failed ? ` · ${failed} FAILED` : ''}`,
        batchCancelled ? 'info' : failed ? 'warn' : 'run',
      );
      // Tracks queued while it ran, or left unrendered by a stop, still
      // want their scan.
      void scanBatchItems(set, get);
    },

    cancelBatch() {
      batchCancelled = true;
    },

    pushToast(text, kind = 'info') {
      const id = toastSeq++;
      set((s) => ({ toasts: [...s.toasts.slice(-5), { id, text, kind }] }));
      setTimeout(() => get().dismissToast(id), kind === 'warn' || kind === 'fault' ? 6500 : 4200);
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
  };
}, {
  name: 'jmaster-settings',
  version: 2,
  storage: settingsStorage,
  // Whatever version wrote the settings, `merge` below takes them field by
  // field. (Without this, a version that differs is thrown away whole:
  // presets, recents, history and all.)
  migrate: (persisted) => persisted as JMasterState,
  // Saved settings merge onto today's defaults field by field and are
  // cleaned like a project: a setting added in a later version never
  // arrives undefined, and no stored value reaches the chain unchecked.
  merge: (persisted, current) => {
    const p = (persisted && typeof persisted === 'object' ? persisted : {}) as Partial<JMasterState> & Record<string, any>;
    const base = captureConsole(current);
    const c = cleanConsole({
      macros: p.macros, targetLufs: p.targetLufs, ceilingDb: p.ceilingDb,
      presetId: p.presetId, lastPresetId: p.lastPresetId, platformId: p.platformId,
      presetAmount: p.presetAmount, clipMode: p.clipMode, advEq: p.advEq, stems: p.stems,
    }, base);
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
    const fmts: ExportFormat[] = ['wav', 'flac', 'mp3', 'opus'];
    const exportFormat = fmts.includes(p.exportFormat as ExportFormat) ? p.exportFormat! : current.exportFormat;
    const depth = p.exportBitDepth === 16 ? 16 : p.exportBitDepth === 32 && exportFormat === 'wav' ? 32 : 24;
    const userPresets = (Array.isArray(p.userPresets) ? p.userPresets : [])
      .map((u) => cleanUserPreset(u, NEUTRAL_MACROS)).filter((u): u is UserPreset => !!u);
    const numOr = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    return {
      ...current,
      theme: p.theme === 'paper' ? 'paper' : 'plate',
      waveView: p.waveView === 'spec' ? 'spec' : 'wave',
      meterView: p.meterView === 'scope' ? 'scope' : p.meterView === 'loudness' ? 'loudness' : 'spectrum',
      spectrumSlope: bool(p.spectrumSlope, current.spectrumSlope),
      gridEnabled: bool(p.gridEnabled, current.gridEnabled),
      loudnessLane: bool(p.loudnessLane, current.loudnessLane),
      tempoLane: bool(p.tempoLane, current.tempoLane),
      followPlayhead: bool(p.followPlayhead, current.followPlayhead),
      outSplit: bool(p.outSplit, current.outSplit),
      autoFix: bool(p.autoFix, current.autoFix),
      recentFiles: (Array.isArray(p.recentFiles) ? p.recentFiles : [])
        .filter((r) => typeof r?.name === 'string' && typeof r?.path === 'string').slice(0, 6),
      userPresets,
      favourites: (Array.isArray(p.favourites) ? p.favourites : []).filter((f) => PRESETS.some((x) => x.id === f)),
      exportExtras: (Array.isArray(p.exportExtras) ? p.exportExtras : []).filter((f) => fmts.includes(f)),
      activeSlot: p.activeSlot === 'B' ? 'B' : 'A',
      snapshots: { A: cleanSnapshot(p.snapshots?.A, base), B: cleanSnapshot(p.snapshots?.B, base) },
      exportHistory: (Array.isArray(p.exportHistory) ? p.exportHistory : [])
        .filter((h) => typeof h?.name === 'string' && typeof h?.format === 'string')
        .map((h) => ({
          name: h.name, path: typeof h.path === 'string' ? h.path : null, format: h.format,
          bytes: numOr(h.bytes, 0), lufs: numOr(h.lufs, -70), truePeakDb: numOr(h.truePeakDb, -70),
          when: typeof h.when === 'string' ? h.when : '',
        })).slice(0, 20),
      albumUpc: typeof p.albumUpc === 'string' ? p.albumUpc.replace(/\D/g, '').slice(0, 13) : '',
      albumGapSec: num(p.albumGapSec, 0, 5, current.albumGapSec),
      exportFormat,
      exportBitDepth: depth,
      exportRate: EXPORT_RATES.find((r) => r === p.exportRate) ?? current.exportRate,
      exportDither: p.exportDither === 'shaped' ? 'shaped' : 'tpdf',
      exportMp3Kbps: ([192, 256, 320] as const).find((k) => k === p.exportMp3Kbps) ?? current.exportMp3Kbps,
      exportOpusKbps: ([128, 192, 256] as const).find((k) => k === p.exportOpusKbps) ?? current.exportOpusKbps,
      meta: { ...current.meta, ...cleanMeta(p.meta) },
      macros: c.macros,
      targetLufs: c.targetLufs,
      ceilingDb: c.ceilingDb,
      presetId: c.presetId,
      // Null is a real answer (the preset was deleted) and stays null; a
      // console saved before the field existed came from the preset it shows.
      lastPresetId: c.lastPresetId,
      presetAmount: c.presetAmount,
      platformId: c.platformId,
      clipMode: c.clipMode,
      advEq: cleanAdvEq(p.advEq),
      stems: c.stems,
      // A network folder was only ever usable in the session that chose
      // it: kept, every batch track rendered in full and then failed to save.
      batchDir: typeof p.batchDir === 'string' && !isNetworkPath(p.batchDir) ? p.batchDir : null,
    };
  },
  // Persist preferences and the console's SOUND; never transport, meters,
  // dialogs, or one track's corrections.
  partialize: (s) => ({
    theme: s.theme,
    waveView: s.waveView,
    gridEnabled: s.gridEnabled,
    loudnessLane: s.loudnessLane,
    tempoLane: s.tempoLane,
    followPlayhead: s.followPlayhead,
    outSplit: s.outSplit,
    recentFiles: s.recentFiles,
    userPresets: s.userPresets,
    favourites: s.favourites,
    lastPresetId: s.lastPresetId,
    presetAmount: s.presetAmount,
    meterView: s.meterView,
    spectrumSlope: s.spectrumSlope,
    exportExtras: s.exportExtras,
    activeSlot: s.activeSlot,
    snapshots: s.snapshots,
    autoFix: s.autoFix,
    exportOpusKbps: s.exportOpusKbps,
    exportHistory: s.exportHistory,
    albumUpc: s.albumUpc,
    albumGapSec: s.albumGapSec,
    exportFormat: s.exportFormat,
    exportBitDepth: s.exportBitDepth,
    exportRate: s.exportRate,
    exportDither: s.exportDither,
    exportMp3Kbps: s.exportMp3Kbps,
    meta: s.meta,
    macros: s.macros,
    presetId: s.presetId,
    platformId: s.platformId,
    targetLufs: s.targetLufs,
    ceilingDb: s.ceilingDb,
    clipMode: s.clipMode,
    advEq: s.advEq,
    stems: s.stems,
    batchDir: s.batchDir,
  }) as Partial<JMasterState> as JMasterState,
  onRehydrateStorage: () => (state) => {
    if (state?.theme) document.documentElement.setAttribute('data-theme', state.theme);
  },
}));

// The master's solve lives in the engine; mirror what it knows into the
// store so the UI re-renders when a solve lands.
engine.onPreviewUpdate = () => {
  const s = useStore.getState();
  if (s.previewPending !== engine.previewPending || s.masterEstimate !== engine.masterEstimate) {
    useStore.setState({ previewPending: engine.previewPending, masterEstimate: engine.masterEstimate });
  }
};

/** What a report needs to know about one render: the file, its figures, and the console that made it. */
function exportRecord(
  s: JMasterState, source: SourceInfo, console: ConsoleState, stats: ExportStats, report: RenderReport | null,
  fileName: string, dir: string | null, title: string, when: string,
): LastExport {
  return {
    fileName, dir, title, sourceName: source.name, when, stats, report, console,
    presetName: findPreset(s, console.presetId)?.name ?? null,
    source: {
      lufs: source.lufs, truePeakDb: source.truePeakDb, lra: source.lra,
      sampleRate: source.originalSampleRate, bitDepth: source.originalBitDepth, durationSec: source.durationSec,
    },
    tempoBpm: s.tempo?.bpm ?? 0,
    repaired: !!s.driftRepair,
    meta: { ...s.meta },
  };
}

/**
 * The spec sheet for a render of the console as it stands, as a page of
 * HTML. For scripting (`window.__jmaster.report`): the app itself saves
 * one from the export sheet's REPORT button.
 */
export function reportHtml(result: { stats: ExportStats; report?: RenderReport }, fileName: string, title: string): string | null {
  const s = useStore.getState();
  if (!s.source) return null;
  return buildReport(exportRecord(s, s.source, captureConsole(s), result.stats, result.report ?? null, fileName, null, title, new Date().toISOString()));
}

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
