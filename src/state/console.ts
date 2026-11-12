// The console as data: what a preset, an A/B slot, an undo step and a
// project file each carry, and the checks that keep any of it from
// arriving out of range. Pure: no store, no engine.
//
// Two layers. The SOUND (macros, EQ, stems, target, ceiling, clip) is how
// you want masters to come out; it travels between tracks, into presets
// and A/B slots, and through restarts. The CORRECTIONS (balance, bass
// mono, channel repair, air restore, match fit, trim, fades) are fixes to
// one track's own faults; they stay with that track and never ride along
// to the next one.
import {
  FadeCurve, MacroValues, PRESETS, PLATFORMS, defaultAdvEq, AdvEqBand, MATCH_EQ_CENTERS,
  type ClipMode, type EqChannel, type EqBandType, type SourceFix, type GenrePreset,
} from '../audio/dsp/params';

export interface StemTrims { bass: number; drums: number; vocal: number; air: number }

/** The sound of a console. */
export interface ConsoleSnapshot {
  macros: MacroValues;
  targetLufs: number;
  ceilingDb: number;
  presetId: string | null;
  /** The preset the console was last set from, for MODIFIED and REVERT. */
  lastPresetId?: string | null;
  /** How much of the preset is dialled in (1 = as written). */
  presetAmount?: number;
  platformId: string | null;
  clipMode?: ClipMode;
  advEq?: AdvEqBand[];
  stems?: StemTrims;
}

/** One track's own corrections. */
export interface TrackCorrections {
  balanceDb: number;
  bassMono: boolean;
  sourceFix: SourceFix;
  matchEqGains: number[];
  airRestore: number;
  airRestoreHz: number;
  trimStartSec: number;
  trimEndSec: number;
  fadeInSec: number;
  fadeOutSec: number;
  fadeInCurve: FadeCurve;
  fadeOutCurve: FadeCurve;
}

/** Everything undo/redo and project files consider "the console". */
export interface ConsoleState extends TrackCorrections {
  macros: MacroValues;
  targetLufs: number;
  ceilingDb: number;
  presetId: string | null;
  lastPresetId: string | null;
  presetAmount: number;
  platformId: string | null;
  clipMode: ClipMode;
  advEq: AdvEqBand[];
  stems: StemTrims;
}

export const NO_CORRECTIONS: TrackCorrections = {
  balanceDb: 0, bassMono: false, sourceFix: 'none', matchEqGains: [],
  airRestore: 0, airRestoreHz: 16000, trimStartSec: 0, trimEndSec: 0,
  fadeInSec: 0, fadeOutSec: 0, fadeInCurve: 'smooth', fadeOutCurve: 'smooth',
};

export const NEUTRAL_MACROS: MacroValues = {
  tone: 0, shape: 0, air: 0, smooth: 0, character: 0, density: 0, impact: 0, width: 1,
};

export const MACRO_RANGE: Record<keyof MacroValues, [number, number]> = {
  tone: [-1, 1], shape: [-1, 1], air: [0, 1], smooth: [0, 1],
  character: [0, 1], density: [0, 1], impact: [-1, 1], width: [0, 2],
};
export const AMOUNT_RANGE: [number, number] = [0, 1.5];

const MACRO_LABEL: Record<keyof MacroValues, string> = {
  tone: 'TONE', shape: 'SHAPE', air: 'AIR', smooth: 'SMOOTH',
  character: 'CHAR', density: 'DENSITY', impact: 'IMPACT', width: 'WIDTH',
};

/**
 * A preset's macros with `amount` of it dialled in: every knob moves from
 * neutral toward (or, past 1, beyond) where the preset puts it.
 */
export function scaleMacros(m: MacroValues, amount: number): MacroValues {
  const out = { ...m };
  for (const k of Object.keys(MACRO_RANGE) as (keyof MacroValues)[]) {
    const n = NEUTRAL_MACROS[k];
    const [lo, hi] = MACRO_RANGE[k];
    out[k] = +Math.max(lo, Math.min(hi, n + (m[k] - n) * amount)).toFixed(4);
  }
  return out;
}

/** The three settings that most distinguish a console, for a spec line. */
export function summarizeMacros(m: MacroValues): string {
  const dev = (Object.keys(m) as (keyof MacroValues)[])
    .map((k) => ({ k, d: k === 'width' ? Math.abs(m.width - 1) : Math.abs(m[k]) }))
    .filter((x) => x.d >= 0.05)
    .sort((a, b) => b.d - a.d)
    .slice(0, 3)
    .map(({ k }) => k === 'width'
      ? `WIDTH ${Math.round(m.width * 100)}%`
      : `${MACRO_LABEL[k]} ${m[k] > 0 && (k === 'tone' || k === 'shape' || k === 'impact') ? '+' : ''}${Math.round(m[k] * 100)}`);
  return dev.length > 0 ? dev.join(' · ') : 'NEUTRAL';
}

/** A console saved by the user, shown in the rack above the genres. */
export interface UserPreset {
  id: string;            // 'u-…', never collides with built-in ids
  name: string;          // uppercase display name
  macros: MacroValues;
  targetLufs: number;
  ceilingDb: number;
  genre?: string;        // metadata genre at save time, reapplied on use
  /** Pinned to the top of the rack. */
  favourite?: boolean;
  savedAt: string;
}

/** Built-in or user preset by id, in the built-in shape. */
export function findPreset(
  s: { userPresets: UserPreset[] },
  id: string | null | undefined,
): (GenrePreset & { user?: boolean }) | null {
  if (!id) return null;
  const u = s.userPresets.find((p) => p.id === id);
  if (u) {
    return {
      id: u.id, name: u.name, spec: summarizeMacros(u.macros), macros: u.macros,
      targetLufs: u.targetLufs, ceilingDb: u.ceilingDb, genre: u.genre, user: true,
    };
  }
  return PRESETS.find((p) => p.id === id) ?? null;
}

/** True when the console still matches the preset (at the amount dialled in). */
export function consoleMatchesPreset(
  s: { macros: MacroValues; targetLufs: number; ceilingDb: number; presetAmount?: number },
  p: { macros: MacroValues; targetLufs: number; ceilingDb: number },
): boolean {
  const want = scaleMacros(p.macros, s.presetAmount ?? 1);
  for (const k of Object.keys(want) as (keyof MacroValues)[]) {
    if (Math.abs(s.macros[k] - want[k]) > 0.005) return false;
  }
  return Math.abs(s.targetLufs - p.targetLufs) < 0.05 && Math.abs(s.ceilingDb - p.ceilingDb) < 0.05;
}

/** "SOUTHERN ROCK" → "Southern Rock" for genre tags. */
export function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])\w/g, (c) => c.toUpperCase());
}

/** The genre tag a preset sets (none for REFERENCE, or a user preset saved without one). */
export function presetGenre(p: GenrePreset & { user?: boolean }): string | undefined {
  return p.user ? p.genre : p.id === 'flat' ? undefined : p.genre ?? titleCase(p.name);
}

// ── values from files ─────────────────────────────────────────────────
// Projects and saved settings come from disk: an older version, a newer
// one or a hand-edited file. Every value is checked and clamped before it
// reaches the chain, so none can arrive undefined, NaN or out of range.
export const num = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;

const FADE_CURVES: FadeCurve[] = ['linear', 'smooth', 'exp', 'log'];
const EQ_TYPES: EqBandType[] = ['lowshelf', 'peak', 'highshelf', 'highpass', 'lowpass'];
const EQ_CHANNELS: EqChannel[] = ['stereo', 'mid', 'side'];
const CLIP_MODES: ClipMode[] = ['off', 'soft', 'hard'];
const SOURCE_FIXES: SourceFix[] = ['none', 'left', 'right', 'flip'];

export function cleanMacros(raw: unknown, base: MacroValues): MacroValues {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...base };
  for (const k of Object.keys(MACRO_RANGE) as (keyof MacroValues)[]) {
    out[k] = num(r[k], MACRO_RANGE[k][0], MACRO_RANGE[k][1], base[k]);
  }
  return out;
}

export function cleanAdvEq(raw: unknown): AdvEqBand[] {
  const defaults = defaultAdvEq();
  if (!Array.isArray(raw) || raw.length !== defaults.length) return defaults;
  return raw.map((b: any, i: number): AdvEqBand => ({
    on: typeof b?.on === 'boolean' ? b.on : defaults[i].on,
    type: EQ_TYPES.includes(b?.type) ? b.type : defaults[i].type,
    freq: num(b?.freq, 20, 20000, defaults[i].freq),
    gainDb: num(b?.gainDb, -12, 12, 0),
    q: num(b?.q, 0.3, 8, defaults[i].q),
    ch: EQ_CHANNELS.includes(b?.ch) ? b.ch : 'stereo',
  }));
}

/** A preset id that names something: a built-in, or the shape of a user preset's. */
function cleanPresetId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (PRESETS.some((p) => p.id === v)) return v;
  return /^u-[a-z0-9]+$/.test(v) ? v : null;
}

/** The sound layer of a console from disk. */
function cleanSound(r: Record<string, any>, base: ConsoleState): Omit<ConsoleState, keyof TrackCorrections> {
  const stem = (v: unknown) => num(v, -3, 3, 0);
  const presetId = cleanPresetId(r.presetId);
  return {
    macros: cleanMacros(r.macros, base.macros),
    targetLufs: num(r.targetLufs, -24, -6, base.targetLufs),
    ceilingDb: num(r.ceilingDb, -3, -0.1, base.ceilingDb),
    presetId,
    // A console saved before the field existed came from the preset it shows.
    lastPresetId: r.lastPresetId === null ? null : cleanPresetId(r.lastPresetId) ?? presetId,
    presetAmount: num(r.presetAmount, AMOUNT_RANGE[0], AMOUNT_RANGE[1], 1),
    platformId: typeof r.platformId === 'string' && PLATFORMS.some((p) => p.id === r.platformId) ? r.platformId : null,
    clipMode: CLIP_MODES.includes(r.clipMode) ? r.clipMode : 'off',
    advEq: cleanAdvEq(r.advEq),
    stems: { bass: stem(r.stems?.bass), drums: stem(r.stems?.drums), vocal: stem(r.stems?.vocal), air: stem(r.stems?.air) },
  };
}

export function cleanCorrections(raw: unknown, base: TrackCorrections = NO_CORRECTIONS): TrackCorrections {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  return {
    balanceDb: num(r.balanceDb, -3, 3, 0),
    bassMono: r.bassMono === true,
    sourceFix: SOURCE_FIXES.includes(r.sourceFix) ? r.sourceFix : 'none',
    matchEqGains: Array.isArray(r.matchEqGains) && r.matchEqGains.length === MATCH_EQ_CENTERS.length
      ? r.matchEqGains.map((g: unknown) => num(g, -6, 6, 0)) : [],
    airRestore: num(r.airRestore, 0, 1, 0),
    airRestoreHz: num(r.airRestoreHz, 4000, 20000, 16000),
    trimStartSec: num(r.trimStartSec, 0, 36000, 0),
    trimEndSec: num(r.trimEndSec, 0, 36000, 0),
    fadeInSec: num(r.fadeInSec, 0, 600, 0),
    fadeOutSec: num(r.fadeOutSec, 0, 600, 0),
    fadeInCurve: FADE_CURVES.includes(r.fadeInCurve) ? r.fadeInCurve : base.fadeInCurve,
    fadeOutCurve: FADE_CURVES.includes(r.fadeOutCurve) ? r.fadeOutCurve : base.fadeOutCurve,
  };
}

export function cleanConsole(raw: unknown, base: ConsoleState): ConsoleState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  return { ...cleanSound(r, base), ...cleanCorrections(r, base) };
}

/** An A/B slot or a saved console: the sound only (older files' corrections are left behind). */
export function cleanSnapshot(raw: unknown, base: ConsoleState): ConsoleSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  return cleanSound(raw as Record<string, any>, base);
}

/** A user preset from disk, or null when it isn't one. */
export function cleanUserPreset(u: any, baseMacros: MacroValues): UserPreset | null {
  if (!u || typeof u.name !== 'string' || typeof u.id !== 'string' || !/^u-[a-z0-9]+$/.test(u.id)) return null;
  const name = u.name.trim().toUpperCase().slice(0, 28);
  if (!name) return null;
  return {
    id: u.id,
    name,
    macros: cleanMacros(u.macros, baseMacros),
    targetLufs: num(u.targetLufs, -24, -6, -14),
    ceilingDb: num(u.ceilingDb, -3, -0.1, -1),
    genre: typeof u.genre === 'string' ? u.genre.slice(0, 200) : undefined,
    favourite: u.favourite === true,
    savedAt: typeof u.savedAt === 'string' ? u.savedAt : new Date(0).toISOString(),
  };
}

/** Release tags from a file: strings only, each at most 200 characters. */
export function cleanMeta(raw: unknown): Partial<Record<'artist' | 'album' | 'year' | 'genre' | 'catalog' | 'comment', string>> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const k of ['artist', 'album', 'year', 'genre', 'catalog', 'comment']) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'string') out[k] = v.slice(0, 200);
    }
  }
  return out;
}
