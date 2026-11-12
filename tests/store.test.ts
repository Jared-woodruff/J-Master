// The console's state: what a load resets, what A/B and undo carry, what a
// project brings back, and what the batch renders each track with.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, sleep, CLEAN_CHECKS, CLEAN_DIAG, type Booted } from './lib/store-harness';
import { PRESETS } from '../src/audio/dsp/params';

let b: Booted;
before(async () => { b = await boot(); });
const st = () => b.useStore.getState();

async function load(name: string, over: Record<string, unknown> = {}, path: string | null = null): Promise<void> {
  b.next.source = over;
  await st().loadFile(new ArrayBuffer(8), name, path);
  await sleep(0);
}

/** A console with nothing dialled in, on a fresh track. */
async function fresh(name = 'fresh.wav'): Promise<void> {
  b.useStore.setState({
    batchRunning: false, albumAssembling: null, exporting: null, batchOpen: false, diagOpen: false,
    autoFix: false, matchRef: null, snapshots: { A: null, B: null }, activeSlot: 'A', presetAmount: 1,
    clipMode: 'off', toasts: [],
  });
  st().applyPreset('flat');
  await load(name);
  b.tick(5000);
}

test('a new track keeps the sound and starts with no corrections', async () => {
  await fresh('one.wav');
  st().setMacro('tone', 0.4);
  st().setClipMode('soft');
  st().setBalance(1.5);
  st().setFade('in', 2);
  st().setTrim('start', 5);
  st().setAirRestore(0.5);
  assert.ok(st().undoDepth > 0);
  await load('two.wav');
  const s = st();
  assert.equal(s.macros.tone, 0.4);
  assert.equal(s.clipMode, 'soft');
  assert.equal(s.balanceDb, 0);
  assert.equal(s.fadeInSec, 0);
  assert.equal(s.trimStartSec, 0);
  assert.equal(s.airRestore, 0);
  // Undo belongs to the track it was made on.
  assert.equal(s.undoDepth, 0);
});

test('A/B slots carry the sound, never the track corrections', async () => {
  await fresh();
  st().setMacro('air', 0.5);
  st().setBalance(2);
  st().switchSlot('B');
  assert.equal(st().macros.air, 0.5, 'an empty slot starts from what is on the console');
  st().setMacro('air', 0.1);
  st().setAdvBand(2, { gainDb: 3 });
  st().switchSlot('A');
  assert.equal(st().macros.air, 0.5);
  assert.equal(st().advEq[2].gainDb, 0);
  assert.equal(st().balanceDb, 2, 'the balance fix stays with the track');
  st().switchSlot('B');
  assert.equal(st().macros.air, 0.1);
  assert.equal(st().advEq[2].gainDb, 3);
  assert.equal(st().balanceDb, 2);
  for (const slot of ['A', 'B'] as const) {
    const snap = st().snapshots[slot];
    if (snap) for (const k of ['balanceDb', 'bassMono', 'matchEqGains', 'fadeInSec', 'trimStartSec']) assert.ok(!(k in snap), `${slot} holds ${k}`);
  }
});

test('undo returns to the slot the step was made in', async () => {
  await fresh();
  st().setMacro('tone', 0.3);
  b.tick(1000);
  st().switchSlot('B');
  st().setMacro('tone', -0.5);
  b.tick(1000);
  st().switchSlot('A');
  assert.equal(st().macros.tone, 0.3);
  st().undo();
  assert.equal(st().activeSlot, 'B');
  assert.equal(st().macros.tone, 0.3, 'B is back to where it started');
  st().undo();
  assert.equal(st().activeSlot, 'A');
  assert.equal(st().macros.tone, 0);
  st().switchSlot('B');
  assert.equal(st().macros.tone, 0.3, 'undoing A left B alone');
});

test('a knob moved in A then in B is two steps, however fast', async () => {
  await fresh();
  st().setMacro('tone', 0.2);
  st().switchSlot('B');
  st().setMacro('tone', 0.6);
  assert.equal(st().undoDepth, 2);
});

test('actions that change nothing leave the history alone', async () => {
  await fresh();
  const depth = () => st().undoDepth;
  st().setMacro('tone', 0);
  st().setMacro('width', 1);
  st().setStem('bass', 0);
  st().setFade('out', 0);
  st().setClipMode('off');
  st().setBalance(0);
  st().clearTrim();
  st().clearMatch();
  st().setFadeCurve('in', st().fadeInCurve);
  assert.equal(depth(), 0);
  st().applyPlatform('spotify');
  assert.equal(depth(), 1);
  b.tick(1000);
  st().applyPlatform('spotify');
  assert.equal(depth(), 1);
  b.useStore.setState({ targetLufs: -6, ceilingDb: -0.1 });
  st().nudgeTarget(1);
  st().nudgeCeiling(0.1);
  assert.equal(depth(), 1);
});

test('an edit right after a redo is its own step and ends the redo', async () => {
  await fresh();
  st().setMacro('tone', 0.2);
  b.tick(1000);
  st().undo();
  st().redo();
  assert.equal(st().macros.tone, 0.2);
  st().setMacro('tone', 0.5);
  assert.equal(st().undoDepth, 2);
  assert.equal(st().redoDepth, 0);
  st().undo();
  assert.equal(st().macros.tone, 0.2);
});

test('a gesture that carries on after an undo clears what could be redone', async () => {
  await fresh();
  st().setMacro('air', 0.2);
  st().setMacro('tone', 0.1);
  st().undo();
  assert.equal(st().redoDepth, 1);
  st().setMacro('air', 0.3);
  assert.equal(st().redoDepth, 0);
  assert.equal(st().undoDepth, 1);
});

test('CLEAR MATCH keeps the reference, so undo brings the curve back with it', async () => {
  await fresh();
  const gains = [1, 0, -1, 0, 2, 0, 0, -2, 0, 1];
  b.useStore.setState({
    matchRef: { name: 'ref.wav', lufs: -9, sideRatioDb: -8, bands: new Array(30).fill(0), deltaGains: gains, suggestedWidth: 1.1 },
  });
  st().applyMatch();
  assert.deepEqual(st().matchEqGains, gains);
  b.tick(1000);
  st().clearMatch();
  assert.deepEqual(st().matchEqGains, []);
  assert.equal(st().matchRef.name, 'ref.wav');
  st().undo();
  assert.deepEqual(st().matchEqGains, gains);
  assert.equal(st().matchRef.name, 'ref.wav');
});

test('the preset to revert to follows undo', async () => {
  await fresh();
  st().applyPreset('rock');
  b.tick(1000);
  st().applyPreset('pop');
  assert.equal(st().lastPresetId, 'pop');
  st().undo();
  assert.equal(st().presetId, 'rock');
  assert.equal(st().lastPresetId, 'rock');
  // The genre tag a preset set goes back with it.
  assert.equal(st().meta.genre, 'Rock');
});

test('AMOUNT dials a preset in from none of it to past it', async () => {
  await fresh();
  const rock = PRESETS.find((p) => p.id === 'rock')!;
  st().applyPreset('rock');
  b.tick(1000);
  st().setPresetAmount(0.5);
  let s = st();
  assert.equal(s.presetId, 'rock');
  assert.ok(Math.abs(s.macros.density - rock.macros.density * 0.5) < 1e-3);
  assert.ok(Math.abs(s.macros.width - (1 + (rock.macros.width - 1) * 0.5)) < 1e-3);
  assert.equal(s.targetLufs, rock.targetLufs, 'the delivery spec is not scaled');
  assert.ok(b.mod.consoleMatchesPreset(s, rock));
  st().setPresetAmount(0);
  s = st();
  assert.equal(s.macros.density, 0);
  assert.equal(s.macros.width, 1);
  st().setPresetAmount(9);
  assert.equal(st().presetAmount, 1.5);
  b.tick(1000);
  st().undo();
  assert.equal(st().presetAmount, 1, 'one gesture, one step back to the preset as written');
  assert.ok(Math.abs(st().macros.density - rock.macros.density) < 1e-3);
});

test('trim keeps a second at least, and the fades stay inside what is kept', async () => {
  await fresh();   // 200 s
  st().setTrim('start', 10);
  st().setTrim('end', 100);
  st().setFade('in', 80);
  assert.equal(st().fadeInSec, 45);
  st().setFade('out', 30);
  st().setTrim('end', 30);
  assert.equal(st().fadeInSec, 10);
  assert.equal(st().fadeOutSec, 10);
  st().setTrim('end', 200);
  assert.equal(st().trimEndSec, 0, 'an end at the very end is no trim');
  st().setTrim('start', 500);
  assert.equal(st().trimStartSec, 199);
  st().setTrim('end', 50);
  assert.equal(st().trimEndSec, 0, 'the end cannot come before the start');
  st().clearTrim();
  assert.equal(st().trimStartSec, 0);
});

test('the check sheet applies what is ticked, once, as one undo step', async () => {
  await fresh();
  await load('flagged.wav', {
    diagnostics: { ...CLEAN_DIAG, sideBassRelDb: -6 },
    checks: { ...CLEAN_CHECKS, headSilenceSec: 2, abruptEnd: true, endLevelDb: -12, cutoffHz: 16000, cutoffDropDb: 40 },
  });
  assert.equal(st().diagOpen, true);
  const ids = st().diagIssues.map((i: any) => i.id);
  assert.deepEqual(ids, ['bassmono', 'air', 'trim', 'fadeout']);
  assert.equal(st().diagIssues.find((i: any) => i.id === 'fadeout').checked, false, 'a fade-out is offered, never assumed');
  st().applyDiagFixes();
  let s = st();
  assert.equal(s.bassMono, true);
  assert.equal(s.trimStartSec, 1.95);
  assert.equal(s.airRestore, 0.4);
  assert.equal(s.airRestoreHz, 16000);
  assert.equal(s.fadeOutSec, 0);
  assert.equal(s.undoDepth, 1);
  // Again: everything ticked is already covered.
  st().applyDiagFixes();
  assert.equal(st().undoDepth, 1);
  st().undo();
  s = st();
  assert.equal(s.bassMono, false);
  assert.equal(s.trimStartSec, 0);
  assert.equal(s.airRestore, 0);
});

test('DIAG never opens over another sheet', async () => {
  await fresh();
  b.useStore.setState({ batchOpen: true });
  await load('flagged.wav', { diagnostics: { ...CLEAN_DIAG, harshRelDb: -5 } });
  assert.equal(st().diagIssues.length, 1);
  assert.equal(st().diagOpen, false);
  b.useStore.setState({ batchOpen: false });
});

test('AUTO-FIX applies the ticked fixes on load without a sheet', async () => {
  await fresh();
  b.useStore.setState({ autoFix: true });
  await load('harsh.wav', { diagnostics: { ...CLEAN_DIAG, harshRelDb: -5 } });
  assert.equal(st().diagOpen, false);
  assert.equal(st().macros.smooth, 0.5);
  b.useStore.setState({ autoFix: false });
  st().setMacro('smooth', 0);
});

test('nothing loads under a running batch, project files included', async () => {
  await fresh('keep.wav');
  b.useStore.setState({ batchRunning: true });
  await load('other.wav');
  assert.equal(st().source.name, 'keep.wav');
  await st().loadFile(new TextEncoder().encode('{"app":"J-Master"}').buffer, 'x.jmaster', null);
  assert.equal(st().source.name, 'keep.wav');
  assert.ok(b.toasts().some((t) => /BATCH IS STILL RUNNING/.test(t)));
  b.useStore.setState({ batchRunning: false });
});

test('the last file asked for is the one that loads', async () => {
  await fresh();
  const first = st().loadFile(new ArrayBuffer(8), 'slow.wav', null);
  const second = st().loadFile(new ArrayBuffer(8), 'quick.wav', null);
  await Promise.all([first, second]);
  assert.equal(st().source.name, 'quick.wav');
  assert.equal(st().loading, false);
  // Even when the first file's bytes arrive after the second's.
  const late = new Promise<ArrayBuffer>((r) => setTimeout(() => r(new ArrayBuffer(8)), 30));
  const a = st().loadFile(late, 'big.wav', null);
  const c = st().loadFile(new ArrayBuffer(8), 'small.wav', null);
  await Promise.all([a, c]);
  assert.equal(st().source.name, 'small.wav');
});

test('AUTO applies nothing when another track loaded while it was thinking', async () => {
  await fresh('a.wav');
  const slowProfile = b.engine.requestSourceProfile;
  b.engine.requestSourceProfile = async () => { await sleep(30); return slowProfile(); };
  const auto = st().masterIt();
  await load('b.wav');
  await auto;
  b.engine.requestSourceProfile = slowProfile;
  assert.equal(st().presetId, 'flat');
  assert.equal(st().masterItReport, null);
  assert.equal(st().masterItBusy, false);
});

test('AUTO is one undo step, genre tag and all', async () => {
  await fresh('auto.wav');
  b.useStore.setState((s: any) => ({ meta: { ...s.meta, genre: 'Mine' } }));
  await st().masterIt();
  const report = st().masterItReport;
  assert.ok(report);
  assert.notEqual(st().presetId, 'flat');
  assert.equal(st().undoDepth, 1);
  st().undoMasterIt();
  assert.equal(st().presetId, 'flat');
  assert.equal(st().meta.genre, 'Mine');
  assert.equal(st().masterItReport, null);
});

test('AUTO goes easier on a source that is already dense', async () => {
  await fresh();
  await load('dense.wav', { lufs: -7, truePeakDb: -0.2 });   // 6.8 dB peak to loudness
  await st().masterIt();
  assert.equal(st().presetAmount, 0.6);
  st().closeMasterItReport();
  b.tick(1000);
  st().undo();
  assert.equal(st().presetAmount, 1);
});

// ── projects ──────────────────────────────────────────────────────────
function project(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    app: 'J-Master', fileVersion: 2, savedAt: '2026-01-01T00:00:00Z', track: null,
    console: {
      macros: { tone: 0.25, shape: 0, air: 0.3, smooth: 0, character: 0, density: 0.2, impact: 0, width: 1.1 },
      targetLufs: -11, ceilingDb: -0.8, presetId: null, lastPresetId: 'rock', platformId: null, clipMode: 'soft',
      balanceDb: 2, bassMono: true, fadeInSec: 1, fadeOutSec: 4, trimStartSec: 3, trimEndSec: 150,
      matchEqGains: [], fadeInCurve: 'exp', fadeOutCurve: 'log',
    },
    snapshots: { A: null, B: null }, activeSlot: 'A',
    meta: { artist: 'Someone' },
    export: { format: 'flac', bitDepth: 16, mp3Kbps: 320, opusKbps: 192, rate: 44100, dither: 'shaped' },
    batch: { dir: null, items: [] },
    ...over,
  });
}
const openText = (text: string) => st().loadFile(new TextEncoder().encode(text).buffer, 'p.jmaster', null);

test('a project with no track of its own brings its sound and holds its corrections', async () => {
  await fresh('here.wav');
  st().setMacro('tone', -0.3);
  await openText(project({ track: { name: 'song.wav', path: null } }));
  let s = st();
  assert.equal(s.macros.tone, 0.25);
  assert.equal(s.clipMode, 'soft');
  assert.equal(s.lastPresetId, 'rock');
  assert.equal(s.exportFormat, 'flac');
  assert.equal(s.exportRate, 44100);
  assert.equal(s.exportDither, 'shaped');
  assert.equal(s.meta.artist, 'Someone');
  assert.equal(s.balanceDb, 0, 'the corrections are for song.wav, not for what is loaded');
  assert.equal(s.trimStartSec, 0);
  assert.equal(s.undoDepth, 0, 'a project starts its own history');

  // Its own track arrives: the corrections return, the sheet stays shut.
  await load('song.wav', { diagnostics: { ...CLEAN_DIAG, harshRelDb: -5 } });
  s = st();
  assert.equal(s.balanceDb, 2);
  assert.equal(s.bassMono, true);
  assert.equal(s.trimStartSec, 3);
  assert.equal(s.trimEndSec, 150);
  assert.equal(s.fadeOutSec, 4);
  assert.equal(s.fadeOutCurve, 'log');
  assert.equal(s.diagOpen, false);
});

test('a project waiting for its track gives nothing to another one', async () => {
  await fresh();
  await openText(project({ track: { name: 'song.wav', path: null } }));
  await load('stranger.wav');
  assert.equal(st().balanceDb, 0);
  await load('song.wav');
  assert.equal(st().balanceDb, 0, 'the wait ended with the first load');
});

test('a project loads its audio by path and fits the trim to the file', async () => {
  await fresh();
  b.files.set('C:\\music\\song.wav', new ArrayBuffer(8));
  b.next.source = { durationSec: 120 };
  await openText(project({ track: { name: 'song.wav', path: 'C:\\music\\song.wav' } }));
  const s = st();
  assert.equal(s.source.name, 'song.wav');
  assert.equal(s.trackPath, 'C:\\music\\song.wav');
  assert.equal(s.balanceDb, 2);
  assert.equal(s.trimStartSec, 3);
  assert.equal(s.trimEndSec, 0, 'an end past the file is no trim');
  assert.equal(s.diagOpen, false);
  assert.ok(b.toasts().some((t) => /PROJECT OPENED/.test(t)));
});

test('a project that names a project as its audio does not open itself', async () => {
  await fresh('safe.wav');
  let reads = 0;
  const read = b.bridge.readFileByPath;
  b.bridge.readFileByPath = async (p: string) => { reads++; return read(p); };
  await openText(project({ track: { name: 'loop.jmaster', path: 'C:\\loop.jmaster' } }));
  b.bridge.readFileByPath = read;
  assert.equal(reads, 0);
  assert.equal(st().source.name, 'safe.wav');
});

test('a damaged cover costs the cover, not the project', async () => {
  await fresh();
  await openText(project({ cover: { mime: 'image/jpeg', name: 'c.jpg', width: 10, height: 10, b64: '!!not base64!!' } }));
  assert.equal(st().coverArt, null);
  assert.equal(st().macros.tone, 0.25);
  await openText(project({ cover: { mime: 'text/html', name: 'c.html', width: 10, height: 10, b64: 'QUJD' } }));
  assert.equal(st().coverArt, null);
  await openText(project({ cover: { mime: 'image/png', name: 'c.png', width: 10, height: 10, b64: 'QUJD' } }));
  assert.equal(st().coverArt.data.length, 3);
});

test('values from a project file are clamped before they reach the chain', async () => {
  await fresh();
  await openText(project({
    console: {
      macros: { tone: 99, shape: 'x', air: -4, width: null }, targetLufs: 40, ceilingDb: 'loud',
      presetId: 42, clipMode: 'smash', balanceDb: 50, fadeInSec: -1, advEq: 'nope', stems: { bass: 99 },
    },
    snapshots: { A: { macros: { tone: 0.1 }, targetLufs: -14, ceilingDb: -1, presetId: null, platformId: null, balanceDb: 3, bassMono: true }, B: 7 },
    export: { format: 'aiff', bitDepth: 12, mp3Kbps: 64, opusKbps: 1, rate: 96000, dither: 'loud' },
  }));
  const s = st();
  assert.equal(s.macros.tone, 1);
  assert.equal(s.macros.air, 0);
  assert.equal(s.targetLufs, -6);
  assert.equal(s.clipMode, 'off');
  assert.equal(s.stems.bass, 3);
  assert.equal(s.advEq.length, 6);
  assert.equal(s.exportFormat, 'wav');
  assert.equal(s.exportBitDepth, 24);
  assert.equal(s.exportMp3Kbps, 320);
  assert.equal(s.exportDither, 'tpdf');
  assert.ok(!('balanceDb' in s.snapshots.A), 'an older file\'s slot corrections are left behind');
  assert.equal(s.snapshots.B, null);
});

test('not a project: nothing changes', async () => {
  await fresh('still.wav');
  st().setMacro('tone', 0.7);
  await openText('{"app":"Something else"}');
  await openText('not json at all');
  assert.equal(st().macros.tone, 0.7);
  assert.equal(st().source.name, 'still.wav');
  assert.ok(b.toasts().some((t) => /PROJECT FILE UNREADABLE/.test(t)));
});

test('a project round-trips: what was saved is what opens', async () => {
  await fresh();
  await load('round.wav', {}, 'C:\\music\\round.wav');
  b.files.set('C:\\music\\round.wav', new ArrayBuffer(8));
  st().applyPreset('house');
  b.tick(1000);
  st().setPresetAmount(0.75);
  st().setClipMode('hard');
  st().setAdvBand(1, { gainDb: -2.5, ch: 'side' });
  st().setStem('vocal', 1.5);
  st().setTrim('start', 2);
  st().setFade('out', 6);
  st().setBalance(-1.2);
  st().setAlbumUpc('012345678905');
  st().saveUserPreset('mine');
  const mine = st().presetId;
  let saved = '';
  b.bridge.saveProjectFile = async (_name: string, json: string) => { saved = json; return 'C:\\music\\round.jmaster'; };
  await st().saveProject();
  assert.ok(saved.length > 0);
  const before = st();
  // Something else entirely, then the project again.
  await fresh('elsewhere.wav');
  b.useStore.setState({ userPresets: [], albumUpc: '' });
  await openText(saved);
  const s = st();
  assert.equal(s.source.name, 'round.wav');
  assert.deepEqual(s.macros, before.macros);
  assert.equal(s.presetAmount, before.presetAmount);
  assert.equal(s.clipMode, 'hard');
  assert.deepEqual(s.advEq[1], before.advEq[1]);
  assert.equal(s.stems.vocal, 1.5);
  assert.equal(s.trimStartSec, 2);
  assert.equal(s.fadeOutSec, 6);
  assert.equal(s.balanceDb, -1.2);
  assert.equal(s.albumUpc, '012345678905');
  assert.equal(s.presetId, mine);
  assert.ok(s.userPresets.some((p: any) => p.id === mine), 'the preset it leans on came with it');
  delete b.bridge.saveProjectFile;
});

// ── tempo ─────────────────────────────────────────────────────────────
test('double and half time re-read the tempo without losing the analysis', async () => {
  await fresh();
  const beats = Array.from({ length: 16 }, (_, i) => 0.5 + i * 0.5);
  const t = {
    bpm: 120, firstBeatSec: 0.5, firstBarSec: 0.5, confidence: 0.9, sections: [], curve: null, beats, downbeat: 0, drift: null,
  };
  b.engine.tempoRaw = t;
  b.engine.tempo = t;
  b.engine.tempoScale = 1;
  b.useStore.setState({ tempo: t });
  st().rescaleTempo(2);
  assert.equal(st().tempo.bpm, 240);
  assert.equal(st().tempo.beats.length, 31);
  st().rescaleTempo(2);
  assert.equal(st().tempo.bpm, 240, '480 BPM is not a reading anyone wants');
  st().rescaleTempo(0.5);
  assert.deepEqual(st().tempo.beats, beats, 'back to the analysis itself, not a copy of a copy');
  st().rescaleTempo(0.5);
  assert.equal(st().tempo.bpm, 60);
  assert.equal(st().tempo.beats.length, 8);
  assert.equal(b.engine.tempoScale, 0.5);
});

// ── presets ───────────────────────────────────────────────────────────
test('deleting a preset lets go of everything that pointed at it', async () => {
  await fresh();
  st().setMacro('tone', 0.33);
  st().saveUserPreset('  keeper  ');
  const id = st().presetId;
  assert.match(id, /^u-/);
  assert.equal(st().userPresets[0].name, 'KEEPER');
  b.useStore.setState({ batchItems: [{ id: 901, name: 'x.wav', status: 'pending', pct: 0, phase: '', presetId: id }] });
  st().toggleFavourite(id);
  assert.equal(st().userPresets[0].favourite, true);
  st().toggleFavourite('rock');
  assert.deepEqual(st().favourites, ['rock']);
  st().deleteUserPreset(id);
  assert.equal(st().presetId, null);
  assert.equal(st().lastPresetId, null);
  assert.equal(st().batchItems[0].presetId, null);
  b.useStore.setState({ batchItems: [], favourites: [] });
});

// ── batch ─────────────────────────────────────────────────────────────
function queue(...names: string[]): void {
  b.bridge.pickFiles = async () => names.map((n) => ({ name: n, path: `C:\\q\\${n}` }));
  for (const n of names) {
    const bytes = new Uint8Array(8);
    bytes[0] = /harsh/.test(n) ? 1 : /bassy/.test(n) ? 2 : 0;
    b.files.set(`C:\\q\\${n}`, bytes.buffer);
  }
}
async function settled(pred: () => boolean, ms = 2000): Promise<void> {
  const until = performance.now() + ms;
  while (!pred()) {
    if (performance.now() > until) throw new Error('timed out waiting');
    await sleep(5);
  }
}

test('queued tracks are scanned, and the same file is not queued twice', async () => {
  await fresh();
  st().clearBatch();
  queue('clean.wav', 'harsh.wav');
  await st().addBatchFiles();
  await st().addBatchFiles();
  assert.equal(st().batchItems.length, 2);
  await settled(() => st().batchItems.every((it: any) => it.scanned));
  const [clean, harsh] = st().batchItems;
  assert.equal(clean.fixes.length, 0);
  assert.equal(harsh.fixes[0].id, 'smooth');
  assert.equal(harsh.fixesEnabled, true);
});

test('each batch track renders with the sound and only its own fixes', async () => {
  await fresh();
  st().clearBatch();
  await load('loaded.wav', {}, 'C:\\q\\loaded.wav');
  // The loaded track's own corrections.
  b.useStore.setState({ bassMono: true, balanceDb: 1.5, fadeOutSec: 5, trimStartSec: 2, batchDir: 'C:\\out' });
  st().setMacro('density', 0.4);
  queue('loaded.wav', 'harsh.wav', 'bassy.wav');
  await st().addBatchFiles();
  st().setBatchItemPreset(st().batchItems[2].id, 'rock');
  b.renders.length = 0;
  // Pressed at once: the scan has not reached anything yet.
  await st().startBatch();
  assert.equal(b.renders.length, 3);
  const [loaded, harsh, bassy] = b.renders.map((r) => r.params);
  assert.equal(loaded.bassMono, true);
  assert.equal(loaded.balanceDb, 1.5);
  assert.equal(loaded.fadeOutSec, 5);
  assert.equal(loaded.density, 0.4);

  assert.equal(harsh.density, 0.4, 'the sound carries over');
  assert.equal(harsh.bassMono, false, 'another track\'s fix does not');
  assert.equal(harsh.balanceDb, 0);
  assert.equal(harsh.fadeOutSec, 0);
  assert.equal(harsh.trimStartSec, 0);
  assert.equal(harsh.smooth, 0.5, 'its own fix does, scanned or not');

  const rock = PRESETS.find((p) => p.id === 'rock')!;
  assert.equal(bassy.density, rock.macros.density);
  assert.equal(bassy.targetLufs, rock.targetLufs);
  assert.equal(bassy.bassMono, true);
  assert.ok(st().batchItems.every((it: any) => it.status === 'done'));
  assert.equal(b.renders[2].encode.tags.genre, 'Rock');
  assert.equal(b.renders[1].encode.tags.trackNumber, 2);
});

test('a track added while the batch runs is scanned when it ends', async () => {
  await fresh();
  st().clearBatch();
  b.useStore.setState({ batchDir: 'C:\\out' });
  queue('one.wav');
  await st().addBatchFiles();
  const run = st().startBatch();
  queue('late-harsh.wav');
  await st().addBatchFiles();
  await run;
  await settled(() => st().batchItems.every((it: any) => it.scanned));
  const late = st().batchItems.find((it: any) => it.name === 'late-harsh.wav');
  assert.equal(late.status, 'pending');
  assert.equal(late.fixes[0].id, 'smooth');
});

test('a track can leave the queue, but not while it is being rendered', async () => {
  await fresh();
  st().clearBatch();
  queue('a.wav', 'b.wav');
  await st().addBatchFiles();
  const [a, bItem] = st().batchItems;
  b.useStore.setState({ batchRunning: true });
  st().removeBatchItem(a.id);
  st().clearBatch();
  assert.equal(st().batchItems.length, 2);
  b.useStore.setState({ batchRunning: false });
  st().removeBatchItem(a.id);
  assert.deepEqual(st().batchItems.map((it: any) => it.id), [bItem.id]);
  // And can come back.
  await st().addBatchFiles();
  assert.equal(st().batchItems.length, 2);
  await settled(() => st().batchItems.every((it: any) => it.scanned));
});

test('a CD image is mastered at 44.1 kHz / 16-bit, one frame-exact track after another', async () => {
  await fresh();
  st().clearBatch();
  queue('t1.wav', 't2.wav');
  await st().addBatchFiles();
  await settled(() => st().batchItems.every((it: any) => it.scanned));
  const written: { name: string; bytes: number }[] = [];
  const appended: number[] = [];
  const patches: [number, number][] = [];
  Object.assign(b.bridge, {
    writeFileNew: async (dir: string, name: string, data: ArrayBuffer) => { written.push({ name, bytes: data.byteLength }); return `${dir}\\${name}`; },
    appendFile: async (_p: string, data: ArrayBuffer) => { appended.push(data.byteLength); },
    patchFile: async (_p: string, off: number, data: ArrayBuffer) => { patches.push([off, new DataView(data).getUint32(0, true)]); },
    commitFile: async (p: string) => p.replace(/\.partial$/, ''),
    discardFile: async () => undefined,
  });
  b.useStore.setState({ batchDir: 'C:\\out', albumGapSec: 2 });
  b.useStore.setState((s: any) => ({ meta: { ...s.meta, album: 'Délà — Vu', artist: 'Me' } }));
  st().setItemIsrc(st().batchItems[0].id, 'au-jmw-26-00001');
  b.renders.length = 0;
  await st().assembleAlbum();
  assert.ok(st().albumResult, b.toasts().join(' | '));
  assert.equal(b.renders.length, 2);
  for (const r of b.renders) {
    assert.equal(r.encode.sampleRate, 44100);
    assert.equal(r.encode.bitDepth, 16);
    assert.equal(r.encode.format, 'wav');
  }
  // Two one-frame tracks and a two-second gap between them.
  const frame = 588 * 4;
  assert.deepEqual(appended, [frame, 150 * frame, frame]);
  assert.deepEqual(patches, [[4, 36 + 152 * frame], [40, 152 * frame]]);
  assert.deepEqual(written.map((w) => w.name), [
    'Dela - Vu - CD Image.wav.partial', 'Dela - Vu.cue', 'Dela - Vu - manifest.txt',
  ]);
  assert.equal(st().albumResult.imagePath, 'C:\\out\\Dela - Vu - CD Image.wav');
  for (const k of ['writeFileNew', 'appendFile', 'patchFile', 'commitFile', 'discardFile']) delete b.bridge[k];
});

test('a disc that cannot be burned is refused before anything renders', async () => {
  await fresh();
  st().clearBatch();
  Object.assign(b.bridge, { writeFileNew: async () => 'x', appendFile: async () => undefined, patchFile: async () => undefined });
  b.useStore.setState({
    batchDir: 'C:\\out',
    batchItems: [{ id: 950, name: 'blip.wav', status: 'pending', pct: 0, phase: '', scanned: true, durationSec: 2 }],
  });
  b.renders.length = 0;
  await st().assembleAlbum();
  assert.equal(b.renders.length, 0);
  assert.ok(b.toasts().some((t) => /TOO SHORT/.test(t)));
  b.useStore.setState({ batchItems: [] });
  for (const k of ['writeFileNew', 'appendFile', 'patchFile']) delete b.bridge[k];
});

// ── export settings ───────────────────────────────────────────────────
test('float is a WAV depth: another format falls back to 24-bit', () => {
  st().setExportFormat('wav');
  st().setExportBitDepth(32);
  assert.equal(st().exportBitDepth, 32);
  st().setExportFormat('flac');
  assert.equal(st().exportBitDepth, 24);
  st().setExportBitDepth(32);
  assert.equal(st().exportBitDepth, 24);
  st().setExportFormat('wav');
  const o = b.mod.encodeOptionsFrom({ ...st(), exportRate: 44100, exportDither: 'shaped', exportBitDepth: 16 });
  assert.deepEqual([o.sampleRate, o.dither, o.bitDepth], [44100, 'shaped', 16]);
});

test('the chain gets every correction and the clip mode', async () => {
  await fresh();
  st().setClipMode('soft');
  st().setTrim('start', 4);
  st().setAirRestore(0.3);
  st().setSourceFix('flip');
  const p = b.mod.chainParamsFrom(st());
  assert.equal(p.clipMode, 'soft');
  assert.equal(p.trimStartSec, 4);
  assert.equal(p.airRestore, 0.3);
  assert.equal(p.sourceFix, 'flip');
  assert.deepEqual(b.engine.__params.sourceFix, 'flip', 'and the engine was told');
});
