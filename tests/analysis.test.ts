// Tempo analysis on songs whose tempo is known exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTempo } from '../src/audio/analysis/tempo';
import { FS, song, whiteNoise, sine } from './lib/signals';

test('tempo: reads a steady song to a tenth of a BPM, with no drift', () => {
  for (const bpm of [92, 120, 128, 174]) {
    const s = song(40, bpm);
    const t = analyzeTempo(s.l, s.r, FS);
    assert.ok(Math.abs(t.bpm - bpm) < 0.1, `${bpm} BPM read as ${t.bpm.toFixed(2)}`);
    assert.equal(t.drift, null, `${bpm} BPM flagged as drifting`);
    assert.ok(t.confidence > 0.25, `confidence ${t.confidence.toFixed(2)}`);
  }
});

test('tempo: never a dotted or triplet relative of the beat', () => {
  // Beat lengths that fall between analysis frames used to lose to a
  // rival that landed on one: 124 BPM read as 82.7, 96 as 128. Eighth
  // hats, sixteenth hats and no hats at all, across the range where the
  // octave is not in question.
  for (const hats of [2, 4, 0]) {
    for (const bpm of [70, 86, 96, 106, 114, 124, 130, 138, 146, 150, 154, 166, 178]) {
      const s = song(40, bpm, FS, 7, { hats });
      const t = analyzeTempo(s.l, s.r, FS);
      assert.ok(Math.abs(t.bpm - bpm) < 0.15, `${bpm} BPM (${hats} hats a beat) read as ${t.bpm.toFixed(2)}`);
      assert.equal(t.drift, null, `${bpm} BPM (${hats} hats a beat) flagged as drifting`);
    }
  }
});

test('tempo: past 184 BPM the slower octave is taken, never something between', () => {
  for (const bpm of [190, 198]) {
    const s = song(40, bpm);
    const t = analyzeTempo(s.l, s.r, FS);
    const ratio = t.bpm / bpm;
    assert.ok(Math.abs(ratio - 1) < 0.01 || Math.abs(ratio - 0.5) < 0.005, `${bpm} BPM read as ${t.bpm.toFixed(2)}`);
  }
});

test('tempo: the grid lands on the beats', () => {
  const bpm = 110;
  const s = song(40, bpm);
  const t = analyzeTempo(s.l, s.r, FS);
  const beat = 60 / bpm;
  // The song's kicks sit on multiples of a beat from zero.
  let worst = 0;
  for (const b of t.beats) {
    const off = Math.abs(b / beat - Math.round(b / beat)) * beat;
    worst = Math.max(worst, off);
  }
  assert.ok(t.beats.length > 60, `${t.beats.length} beats tracked`);
  assert.ok(worst < 0.02, `a beat ${Math.round(worst * 1000)} ms off the grid`);
});

test('drift: a steady song with drumless passages is steady', () => {
  // A pad-only breakdown has no pulse; what the tempo curve read there
  // used to be taken for the tempo moving.
  const cases: [string, number, number, (sec: number) => boolean][] = [
    ['drums, 30 s of pad, drums', 128, 75, (t) => t < 15 || t >= 45],
    ['two 20 s breakdowns', 100, 100, (t) => !(t >= 20 && t < 40) && !(t >= 60 && t < 80)],
    ['pad outro', 110, 70, (t) => t < 45],
    ['pad intro', 140, 70, (t) => t >= 25],
  ];
  for (const [name, bpm, sec, drums] of cases) {
    const s = song(sec, bpm, FS, 7, { drums: (b) => drums((b * 60) / bpm) });
    const t = analyzeTempo(s.l, s.r, FS);
    assert.equal(t.drift, null, `${name}: flagged as drifting`);
    assert.ok(Math.abs(t.bpm - bpm) < 0.15, `${name}: ${bpm} BPM read as ${t.bpm.toFixed(2)}`);
  }
});

test('drift: a real drift is found, with or without a breakdown in it', () => {
  const tempoAt = (t: number) => (t < 20 ? 120 : Math.min(126, 120 + (t - 20) * 0.2));
  for (const breakdown of [false, true]) {
    const s = song(80, 120, FS, 7, { tempoAt, drums: breakdown ? (b) => !(b >= 70 && b < 110) : undefined });
    const t = analyzeTempo(s.l, s.r, FS);
    assert.ok(t.drift, 'drift not found');
    assert.ok(Math.abs(t.drift!.refBpm - 120) < 0.3, `sets out at ${t.drift!.refBpm.toFixed(2)}`);
    assert.ok(Math.abs(t.drift!.endBpm - 126) < 0.4, `ends at ${t.drift!.endBpm.toFixed(2)}`);
    // The curve never strays outside the tempos the song actually played.
    assert.ok(t.drift!.minBpm > 119.5 && t.drift!.maxBpm < 126.5, `curve ${t.drift!.minBpm.toFixed(1)}..${t.drift!.maxBpm.toFixed(1)}`);
  }
});

test('tempo: no pulse in silence, noise or a held tone', () => {
  const z = new Float32Array(FS * 12);
  assert.equal(analyzeTempo(z, new Float32Array(z), FS).bpm, 0);
  const noise = whiteNoise(30, FS, -12, 3);
  const tn = analyzeTempo(noise, noise, FS);
  assert.equal(tn.bpm, 0, 'noise');
  assert.equal(tn.beats.length, 0);
  assert.equal(tn.sections.length, 1, 'noise has no sections');
  const tone = sine(440, 30, FS, -12);
  const tt = analyzeTempo(tone, tone, FS);
  assert.equal(tt.bpm, 0, 'a tone');
  assert.equal(tt.sections.length, 1);
});

test('sections: where the arrangement changes, and only there', () => {
  // Drums out from 16 s to 32 s (on bar lines at 120 BPM).
  const s = song(48, 120, FS, 7, { drums: (b) => b < 32 || b >= 64 });
  const t = analyzeTempo(s.l, s.r, FS);
  const starts = t.sections.map((x) => x.startSec);
  assert.ok(starts.some((x) => Math.abs(x - 16) < 0.6), `no boundary near 16 s: ${starts.map((x) => x.toFixed(1)).join(', ')}`);
  assert.ok(starts.some((x) => Math.abs(x - 32) < 0.6), `no boundary near 32 s: ${starts.map((x) => x.toFixed(1)).join(', ')}`);
  assert.ok(t.sections.length <= 4, `${t.sections.length} sections`);
});

test('tempo: a blip shorter than a window does not throw', () => {
  const x = new Float32Array(Math.round(FS * 0.3));
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(i * 0.1) * 0.5;
  const t = analyzeTempo(x, new Float32Array(x), FS);
  assert.ok(Number.isFinite(t.bpm));
});
