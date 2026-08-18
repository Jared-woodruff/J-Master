// The mastering console's parameter model, shared by UI, worklet and renderer.

export type FadeCurve = 'linear' | 'smooth' | 'exp' | 'log';

/** Fixed centres for the reference-match correction EQ. */
export const MATCH_EQ_CENTERS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export interface AdvEqBand {
  on: boolean;
  type: 'lowshelf' | 'peak' | 'highshelf';
  freq: number;
  gainDb: number;
  q: number;
}

export function defaultAdvEq(): AdvEqBand[] {
  return [
    { on: true, type: 'lowshelf', freq: 90, gainDb: 0, q: 0.8 },
    { on: true, type: 'peak', freq: 250, gainDb: 0, q: 1.0 },
    { on: true, type: 'peak', freq: 800, gainDb: 0, q: 1.0 },
    { on: true, type: 'peak', freq: 2500, gainDb: 0, q: 1.0 },
    { on: true, type: 'peak', freq: 6000, gainDb: 0, q: 1.0 },
    { on: true, type: 'highshelf', freq: 12000, gainDb: 0, q: 0.8 },
  ];
}

export interface ChainParams {
  /** Spectral tilt, -1 (warm) .. +1 (bright). ±4.5 dB pivot ~700 Hz. */
  tone: number;
  /** Mid contour, -1 (scooped/deep) .. +1 (forward/present). */
  shape: number;
  /** High-shelf sheen at 13 kHz, 0..1 → 0..+6 dB. */
  air: number;
  /** Dynamic high-band tamer (de-harsh), 0..1 → up to -6 dB at ~6.5 kHz. */
  smooth: number;
  /** Harmonic saturation drive, 0..1. Tape/tube colour, oversampled. */
  character: number;
  /** Glue compression amount, 0..1. */
  density: number;
  /** Transient contour, -1 (soft) .. +1 (punch). */
  impact: number;
  /** Stereo width, 0 (mono) .. 2 (super). 1 = unity. Bass stays anchored. */
  width: number;
  /** L/R balance trim in dB, -3..+3. Positive shifts the image right. */
  balanceDb: number;
  /** Collapse side content below 140 Hz to mono at any width setting. */
  bassMono: boolean;
  /** Reference-match correction gains at MATCH_EQ_CENTERS; empty = off. */
  matchEqGains: number[];
  /** Stem-lane trims in dB, -3..+3 each. */
  stemBassDb: number;
  stemDrumsDb: number;
  stemVocalDb: number;
  stemAirDb: number;
  /** Advanced 6-band parametric EQ. */
  advEq: AdvEqBand[];

  /** Loudness target in LUFS (integrated). */
  targetLufs: number;
  /** True-peak ceiling in dBTP. */
  ceilingDb: number;

  /** Gain applied before the chain so the source sits at nominal -18 LUFS. */
  stagingGainDb: number;
  /** Gain applied before the limiter. Preview: calibrated estimate. Export: exact. */
  outputGainDb: number;
  /** Output gain used in REF (bypass) mode so the compare is loudness-matched. */
  refOutputGainDb: number;

  fadeInSec: number;
  fadeOutSec: number;
  fadeInCurve: FadeCurve;
  fadeOutCurve: FadeCurve;
  /** Full song length in seconds (for fade-out placement). */
  songLengthSec: number;

  /** Reference mode: loudness-matched bypass of all processing. */
  bypass: boolean;
  /** Monitor only what the limiter is removing (preview only, never export). */
  limiterDelta: boolean;

  /** Metronome click (preview only, mixed in post-metering by the worklet). */
  metronome: boolean;
  /** Detected tempo for the click/grid; 0 = no grid known. */
  gridBpm: number;
  /** First-beat position in seconds for the click/grid. */
  gridFirstBeatSec: number;
}

export const NOMINAL_LUFS = -18;

export function defaultParams(): ChainParams {
  return {
    tone: 0,
    shape: 0,
    air: 0,
    smooth: 0,
    character: 0,
    density: 0,
    impact: 0,
    width: 1,
    balanceDb: 0,
    bassMono: false,
    matchEqGains: [],
    stemBassDb: 0,
    stemDrumsDb: 0,
    stemVocalDb: 0,
    stemAirDb: 0,
    advEq: defaultAdvEq(),
    targetLufs: -14,
    ceilingDb: -1.0,
    stagingGainDb: 0,
    outputGainDb: -14 - NOMINAL_LUFS,
    refOutputGainDb: -14 - NOMINAL_LUFS,
    fadeInSec: 0,
    fadeOutSec: 0,
    fadeInCurve: 'smooth',
    fadeOutCurve: 'smooth',
    songLengthSec: 0,
    bypass: false,
    limiterDelta: false,
    metronome: false,
    gridBpm: 0,
    gridFirstBeatSec: 0,
  };
}

export interface MacroValues {
  tone: number;
  shape: number;
  air: number;
  smooth: number;
  character: number;
  density: number;
  impact: number;
  width: number;
}

export interface GenrePreset {
  id: string;
  /** Uppercase display name. */
  name: string;
  /** Mono spec line shown under the name. */
  spec: string;
  macros: MacroValues;
  targetLufs: number;
  ceilingDb: number;
  /** Metadata genre tag when the title-cased name isn't right (R&B, EDM…). */
  genre?: string;
}

export const PRESETS: GenrePreset[] = [
  {
    id: 'flat', name: 'REFERENCE', spec: 'NEUTRAL · NO COLOUR',
    macros: { tone: 0, shape: 0, air: 0, smooth: 0, character: 0, density: 0, impact: 0, width: 1 },
    targetLufs: -14, ceilingDb: -1,
  },
  {
    id: 'rock', name: 'ROCK', spec: 'DRIVE · PRESENCE · GLUE',
    macros: { tone: 0.15, shape: 0.3, air: 0.35, smooth: 0.2, character: 0.45, density: 0.5, impact: 0.35, width: 1.15 },
    targetLufs: -11.5, ceilingDb: -1,
  },
  {
    id: 'metal', name: 'METAL', spec: 'SCOOP · WALL · ATTACK',
    macros: { tone: 0.2, shape: -0.4, air: 0.4, smooth: 0.35, character: 0.55, density: 0.6, impact: 0.45, width: 1.1 },
    targetLufs: -9.5, ceilingDb: -1,
  },
  {
    id: 'rap', name: 'RAP', spec: 'SUB · VOCAL · KNOCK',
    macros: { tone: -0.1, shape: 0.25, air: 0.3, smooth: 0.25, character: 0.35, density: 0.55, impact: 0.6, width: 1.0 },
    targetLufs: -10.5, ceilingDb: -1,
  },
  {
    id: 'lofi', name: 'LOFI', spec: 'TAPE · DUST · SOFT',
    macros: { tone: -0.45, shape: -0.2, air: 0.05, smooth: 0.15, character: 0.7, density: 0.65, impact: -0.3, width: 0.9 },
    targetLufs: -14, ceilingDb: -1,
  },
  {
    id: 'hiphop', name: 'HIP-HOP', spec: 'LOW END · SWING · PUNCH',
    macros: { tone: -0.15, shape: 0.15, air: 0.25, smooth: 0.25, character: 0.4, density: 0.5, impact: 0.5, width: 1.05 },
    targetLufs: -11, ceilingDb: -1,
  },
  {
    id: 'electronic', name: 'ELECTRONIC', spec: 'WIDE · CLEAN · DRIVE',
    macros: { tone: 0.1, shape: -0.15, air: 0.45, smooth: 0.3, character: 0.3, density: 0.55, impact: 0.5, width: 1.3 },
    targetLufs: -10, ceilingDb: -1,
  },
  {
    id: 'trance', name: 'TRANCE', spec: 'LIFT · SHIMMER · PULSE',
    macros: { tone: 0.15, shape: -0.1, air: 0.5, smooth: 0.3, character: 0.25, density: 0.6, impact: 0.45, width: 1.35 },
    targetLufs: -9.5, ceilingDb: -1,
  },
  {
    id: 'synthwave', name: 'SYNTHWAVE', spec: 'ANALOG · CHROME · HAZE',
    macros: { tone: -0.05, shape: -0.25, air: 0.4, smooth: 0.2, character: 0.5, density: 0.55, impact: 0.3, width: 1.4 },
    targetLufs: -11, ceilingDb: -1,
  },
  {
    id: 'country', name: 'COUNTRY', spec: 'OPEN · STRING · TRUE',
    macros: { tone: 0.05, shape: 0.2, air: 0.3, smooth: 0.15, character: 0.3, density: 0.4, impact: 0.25, width: 1.05 },
    targetLufs: -12.5, ceilingDb: -1,
  },
  {
    id: 'southernrock', name: 'SOUTHERN ROCK', spec: 'WARM · GRIT · ROOM',
    macros: { tone: -0.1, shape: 0.25, air: 0.25, smooth: 0.2, character: 0.5, density: 0.45, impact: 0.3, width: 1.1 },
    targetLufs: -11.5, ceilingDb: -1,
  },
  {
    id: 'indierock', name: 'INDIE ROCK', spec: 'JANGLE · ROOM · TRUE',
    macros: { tone: 0.05, shape: 0.2, air: 0.3, smooth: 0.2, character: 0.4, density: 0.45, impact: 0.3, width: 1.1 },
    targetLufs: -12, ceilingDb: -1,
  },
  {
    id: 'punk', name: 'PUNK', spec: 'RAW · FAST · LOUD',
    macros: { tone: 0.2, shape: 0.35, air: 0.3, smooth: 0.25, character: 0.55, density: 0.55, impact: 0.4, width: 1.05 },
    targetLufs: -10.5, ceilingDb: -1,
  },
  {
    id: 'blues', name: 'BLUES', spec: 'WARM · WOOD · SOUL',
    macros: { tone: -0.15, shape: 0.15, air: 0.2, smooth: 0.15, character: 0.45, density: 0.4, impact: 0.25, width: 1.0 },
    targetLufs: -13, ceilingDb: -1,
  },
  {
    id: 'pop', name: 'POP', spec: 'GLOSS · TIGHT · TOP',
    macros: { tone: 0.15, shape: 0.2, air: 0.45, smooth: 0.3, character: 0.25, density: 0.55, impact: 0.4, width: 1.2 },
    targetLufs: -10.5, ceilingDb: -1,
  },
  {
    id: 'kpop', name: 'K-POP', spec: 'POLISH · PUNCH · SHINE',
    macros: { tone: 0.25, shape: 0.3, air: 0.55, smooth: 0.35, character: 0.3, density: 0.65, impact: 0.5, width: 1.3 },
    targetLufs: -9.5, ceilingDb: -1,
  },
  {
    id: 'hyperpop', name: 'HYPERPOP', spec: 'MAX · CRUSH · GLITTER',
    macros: { tone: 0.35, shape: 0.2, air: 0.6, smooth: 0.3, character: 0.5, density: 0.7, impact: 0.55, width: 1.45 },
    targetLufs: -8.5, ceilingDb: -0.8,
  },
  {
    id: 'rnb', name: 'R&B', spec: 'SILK · POCKET · LOW', genre: 'R&B',
    macros: { tone: -0.1, shape: 0.1, air: 0.35, smooth: 0.35, character: 0.25, density: 0.45, impact: 0.3, width: 1.1 },
    targetLufs: -12, ceilingDb: -1,
  },
  {
    id: 'funk', name: 'FUNK', spec: 'POCKET · SNAP · MID',
    macros: { tone: 0.05, shape: 0.25, air: 0.3, smooth: 0.2, character: 0.35, density: 0.5, impact: 0.45, width: 1.1 },
    targetLufs: -11.5, ceilingDb: -1,
  },
  {
    id: 'reggae', name: 'REGGAE', spec: 'ROOTS · SKANK · EASY',
    macros: { tone: -0.2, shape: 0.05, air: 0.2, smooth: 0.2, character: 0.35, density: 0.45, impact: 0.3, width: 1.05 },
    targetLufs: -12.5, ceilingDb: -1,
  },
  {
    id: 'phonk', name: 'PHONK', spec: 'MEMPHIS · MURK · KNOCK',
    macros: { tone: -0.2, shape: -0.15, air: 0.2, smooth: 0.2, character: 0.6, density: 0.6, impact: 0.5, width: 1.1 },
    targetLufs: -9.5, ceilingDb: -1,
  },
  {
    id: 'house', name: 'EDM / HOUSE', spec: 'PUMP · LIFT · FLOOR', genre: 'House',
    macros: { tone: 0.1, shape: -0.1, air: 0.45, smooth: 0.3, character: 0.3, density: 0.6, impact: 0.5, width: 1.3 },
    targetLufs: -9.5, ceilingDb: -1,
  },
  {
    id: 'techno', name: 'TECHNO', spec: 'DARK · DRIVE · MACHINE',
    macros: { tone: -0.05, shape: -0.2, air: 0.3, smooth: 0.25, character: 0.4, density: 0.6, impact: 0.45, width: 1.25 },
    targetLufs: -10, ceilingDb: -1,
  },
  {
    id: 'dubstep', name: 'DUBSTEP / BASS', spec: 'SUB · GROWL · DROP', genre: 'Dubstep',
    macros: { tone: -0.1, shape: -0.25, air: 0.35, smooth: 0.3, character: 0.45, density: 0.6, impact: 0.55, width: 1.2 },
    targetLufs: -9.5, ceilingDb: -1,
  },
  {
    id: 'dnb', name: 'DRUM & BASS', spec: 'SPEED · SNAP · ROLL', genre: 'Drum & Bass',
    macros: { tone: 0.05, shape: -0.1, air: 0.4, smooth: 0.3, character: 0.35, density: 0.55, impact: 0.6, width: 1.15 },
    targetLufs: -10, ceilingDb: -1,
  },
  {
    id: 'ambient', name: 'AMBIENT', spec: 'SPACE · DRIFT · WIDE',
    macros: { tone: -0.05, shape: -0.15, air: 0.4, smooth: 0.2, character: 0.15, density: 0.35, impact: -0.2, width: 1.4 },
    targetLufs: -16, ceilingDb: -1,
  },
  {
    id: 'jazz', name: 'JAZZ', spec: 'ROOM · BRUSH · AIR',
    macros: { tone: -0.1, shape: 0.05, air: 0.25, smooth: 0.15, character: 0.2, density: 0.3, impact: 0.15, width: 1.1 },
    targetLufs: -14, ceilingDb: -1,
  },
  {
    id: 'acoustic', name: 'ACOUSTIC / FOLK', spec: 'STRING · BREATH · TRUE', genre: 'Acoustic',
    macros: { tone: 0, shape: 0.1, air: 0.3, smooth: 0.15, character: 0.15, density: 0.3, impact: 0.2, width: 1.05 },
    targetLufs: -14, ceilingDb: -1,
  },
  {
    id: 'cinematic', name: 'CINEMATIC', spec: 'SCALE · SWELL · SCENE',
    macros: { tone: 0, shape: 0.1, air: 0.35, smooth: 0.2, character: 0.2, density: 0.4, impact: 0.35, width: 1.3 },
    targetLufs: -14, ceilingDb: -1,
  },
  {
    id: 'classical', name: 'CLASSICAL', spec: 'HALL · DYNAMIC · PURE',
    macros: { tone: 0, shape: 0, air: 0.15, smooth: 0.1, character: 0, density: 0.15, impact: 0, width: 1.05 },
    targetLufs: -18, ceilingDb: -1,
  },
];

export interface PlatformTarget {
  id: string;
  name: string;
  targetLufs: number;
  ceilingDb: number;
  spec: string;
}

export const PLATFORMS: PlatformTarget[] = [
  { id: 'spotify', name: 'SPOTIFY', targetLufs: -14, ceilingDb: -1, spec: '-14 LUFS · -1.0 dBTP' },
  { id: 'apple', name: 'APPLE MUSIC', targetLufs: -16, ceilingDb: -1, spec: '-16 LUFS · -1.0 dBTP' },
  { id: 'youtube', name: 'YOUTUBE', targetLufs: -14, ceilingDb: -1, spec: '-14 LUFS · -1.0 dBTP' },
  { id: 'tidal', name: 'TIDAL', targetLufs: -14, ceilingDb: -1, spec: '-14 LUFS · -1.0 dBTP' },
  { id: 'amazon', name: 'AMAZON MUSIC', targetLufs: -14, ceilingDb: -2, spec: '-14 LUFS · -2.0 dBTP' },
  { id: 'deezer', name: 'DEEZER', targetLufs: -15, ceilingDb: -1, spec: '-15 LUFS · -1.0 dBTP' },
  { id: 'soundcloud', name: 'SOUNDCLOUD', targetLufs: -14, ceilingDb: -1, spec: '-14 LUFS · -1.0 dBTP' },
  { id: 'club', name: 'CLUB / DJ', targetLufs: -9, ceilingDb: -0.3, spec: '-9 LUFS · -0.3 dBTP' },
  { id: 'cd', name: 'CD MASTER', targetLufs: -9, ceilingDb: -0.3, spec: '-9 LUFS · -0.3 dBTP' },
];

export function dbToLin(db: number): number { return Math.pow(10, db / 20); }
export function linToDb(lin: number): number { return 20 * Math.log10(Math.max(lin, 1e-10)); }
