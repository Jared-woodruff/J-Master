// Saved settings: what an older version wrote still opens, nothing from
// disk reaches the chain unchecked, and a meter frame never costs a write.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, sleep, type Booted } from './lib/store-harness';

// What 2.7 wrote (persist version 1), with a few values a hand edit or a
// bad write could leave behind.
const OLD = {
  version: 1,
  state: {
    theme: 'paper',
    waveView: 'spec',
    macros: { tone: 0.3, shape: 0, air: 0.2, smooth: 0, character: 0, density: 0.35, impact: 0, width: 1.15 },
    presetId: 'rock',
    targetLufs: -11,
    ceilingDb: 'loud',
    balanceDb: 2,
    bassMono: true,
    fadeInSec: 3,
    userPresets: [
      { id: 'u-abc123', name: 'mine', macros: { tone: 0.5 }, targetLufs: -12, ceilingDb: -1, savedAt: '2026-01-01' },
      { id: 'rock', name: 'SHADOW', macros: {}, targetLufs: -3, ceilingDb: 0 },
      { id: 'u-zzz', name: { not: 'a name' } },
    ],
    snapshots: {
      A: {
        macros: { tone: -0.2, shape: 0, air: 0, smooth: 0, character: 0, density: 0, impact: 0, width: 1 },
        targetLufs: -14, ceilingDb: -1, presetId: null, platformId: 'spotify',
        balanceDb: 2.5, bassMono: true, matchEqGains: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], fadeOutSec: 8,
      },
      B: null,
    },
    recentFiles: [{ name: 'a.wav', path: 'C:\\a.wav' }, { name: 5 }, null],
    exportFormat: 'aiff',
    exportBitDepth: 16,
    exportHistory: [{ name: 'x.wav', path: 'C:\\x.wav', format: 'wav', bytes: 'big', lufs: null, truePeakDb: -1, when: 'then' }, 'junk'],
    batchDir: '\\\\server\\share\\masters',
    meta: { artist: 'Someone', genre: { evil: true } },
  },
};

let b: Booted;
before(async () => { b = await boot({ blob: JSON.stringify(OLD) }); });
const st = () => b.useStore.getState();

test('settings from an older version are kept, not thrown away', () => {
  const s = st();
  assert.equal(s.theme, 'paper');
  assert.equal(s.waveView, 'spec');
  assert.equal(s.macros.tone, 0.3);
  assert.equal(s.macros.width, 1.15);
  assert.equal(s.presetId, 'rock');
  assert.equal(s.lastPresetId, 'rock', 'a console saved before the field existed came from the preset it shows');
  assert.equal(s.targetLufs, -11);
  assert.equal(s.exportBitDepth, 16);
  assert.equal(s.meta.artist, 'Someone');
  assert.deepEqual(s.recentFiles, [{ name: 'a.wav', path: 'C:\\a.wav' }]);
});

test('settings added since arrive at their defaults', () => {
  const s = st();
  assert.equal(s.clipMode, 'off');
  assert.equal(s.presetAmount, 1);
  assert.equal(s.exportRate, 48000);
  assert.equal(s.exportDither, 'tpdf');
  assert.equal(s.advEq.length, 6);
  assert.deepEqual(s.stems, { bass: 0, drums: 0, vocal: 0, air: 0 });
  assert.equal(s.followPlayhead, true);
  assert.equal(s.meterView, 'spectrum');
  assert.deepEqual(s.favourites, []);
});

test('nothing unchecked comes through', () => {
  const s = st();
  assert.equal(s.ceilingDb, -1, 'a ceiling that is not a number is the default');
  assert.equal(s.exportFormat, 'wav');
  assert.equal(typeof s.meta.genre, 'string');
  assert.deepEqual(s.userPresets.map((p: any) => p.id), ['u-abc123'], 'a preset may not shadow a built-in, or lack a name');
  assert.equal(s.userPresets[0].name, 'MINE');
  assert.equal(s.userPresets[0].macros.width, 1, 'missing knobs are neutral');
  assert.deepEqual(s.exportHistory, [{ name: 'x.wav', path: 'C:\\x.wav', format: 'wav', bytes: 0, lufs: -70, truePeakDb: -1, when: 'then' }]);
  assert.equal(s.batchDir, null, 'a network folder is chosen again, never reused');
});

test('one track\'s corrections never ride along through a restart', () => {
  const s = st();
  assert.equal(s.balanceDb, 0);
  assert.equal(s.bassMono, false);
  assert.equal(s.fadeInSec, 0);
  const a = s.snapshots.A;
  assert.equal(a.macros.tone, -0.2);
  assert.equal(a.platformId, 'spotify');
  for (const k of ['balanceDb', 'bassMono', 'matchEqGains', 'fadeOutSec']) assert.ok(!(k in a), `slot A holds ${k}`);
});

test('meter frames and the transport cost no writes; a real change costs one', async () => {
  b.flush();
  const n0 = b.writes.n;
  for (let i = 0; i < 200; i++) {
    b.useStore.setState({ meters: { playhead: i, playing: true, momentary: -14 + i / 100 }, playing: true, playheadSec: i / 46 });
  }
  st().pushToast('HELLO');
  b.useStore.setState({ exportOpen: true, diagOpen: true });
  b.flush();
  assert.equal(b.writes.n, n0);

  // A drag: many values, one write, and only once the moment has passed.
  for (let i = 1; i <= 50; i++) st().setMacro('tone', i / 100);
  assert.equal(b.writes.n, n0);
  await sleep(500);
  assert.equal(b.writes.n, n0 + 1);
  const saved = JSON.parse(b.mem.get('jmaster-settings')!);
  assert.equal(saved.version, 2);
  assert.equal(saved.state.macros.tone, 0.5);
  assert.ok(!('meters' in saved.state) && !('balanceDb' in saved.state) && !('toasts' in saved.state));

  // Closing the window right after a change still saves it.
  st().setClipMode('hard');
  b.flush();
  assert.equal(b.writes.n, n0 + 2);
  assert.equal(JSON.parse(b.mem.get('jmaster-settings')!).state.clipMode, 'hard');
});

test('the EQ and the lanes survive a restart with the rest of the sound', () => {
  st().setAdvBand(3, { gainDb: 2, ch: 'mid', type: 'peak' });
  st().setStem('air', 1.5);
  st().toggleFavourite('pop');
  b.flush();
  const saved = JSON.parse(b.mem.get('jmaster-settings')!).state;
  assert.equal(saved.advEq[3].gainDb, 2);
  assert.equal(saved.advEq[3].ch, 'mid');
  assert.equal(saved.stems.air, 1.5);
  assert.deepEqual(saved.favourites, ['pop']);
});
