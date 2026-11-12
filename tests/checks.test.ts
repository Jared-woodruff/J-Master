// The source checks: each on a file built to have (or not have) the fault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSource, countClippedRuns, FULL_BAND_HZ } from '../src/audio/analysis/source-checks';
import { resample } from '../src/audio/dsp/resample';
import { FS, song, pinkNoise, sine } from './lib/signals';

function bandLimit(x: Float32Array, hz: number): Float32Array {
  const mid = Math.round(hz * 2.2);
  return resample(resample(x, FS, mid), mid, FS);
}

test('bandwidth: finds where a band-limited source stops', () => {
  const s = song(12);
  for (const cut of [10000, 15000, 16000]) {
    // bandLimit goes through a rate of 2.2 × cut, so the −6 dB point of
    // its filter sits at 1.1 × cut.
    const l = bandLimit(s.l, cut), r = bandLimit(s.r, cut);
    const c = analyzeSource(l, r, FS);
    assert.ok(c.cutoffHz !== null, `no cut found at ${cut}`);
    assert.ok(Math.abs(c.cutoffHz! - cut * 1.1) < 800, `cut at ${cut * 1.1} read as ${c.cutoffHz}`);
    assert.ok(c.cutoffDropDb > 22);
  }
});

test('bandwidth: a full-band source has no cut, and a natural roll-off is not one', () => {
  const s = song(12);
  assert.equal(analyzeSource(s.l, s.r, FS).cutoffHz, null, 'full band');
  // Pink noise falls 3 dB an octave all the way up: a slope, not a cliff.
  const p = pinkNoise(10, FS, -20, 4);
  assert.equal(analyzeSource(p, p, FS).cutoffHz, null, 'pink noise');
  // A 44.1 kHz file brought to 48 kHz stops near 21 kHz: found, but past the line that matters.
  const up = resample(resample(s.l, FS, 44100), 44100, FS);
  const c = analyzeSource(up, up, FS);
  assert.ok(c.cutoffHz === null || c.cutoffHz > FULL_BAND_HZ, `44.1 kHz source read as cut at ${c.cutoffHz}`);
  // A bass note alone: quiet up top, but nothing was cut.
  const bass = sine(55, 8, FS, -6);
  assert.equal(analyzeSource(bass, bass, FS).cutoffHz, null, 'a pure tone');
});

test('silence at the ends is measured', () => {
  const s = song(6);
  const head = FS * 1.5, tail = FS * 3;
  const l = new Float32Array(head + s.l.length + tail);
  const r = new Float32Array(l.length);
  l.set(s.l, head); r.set(s.r, head);
  const c = analyzeSource(l, r, FS);
  assert.ok(Math.abs(c.headSilenceSec - 1.5) < 0.02, `head ${c.headSilenceSec}`);
  assert.ok(Math.abs(c.tailSilenceSec - 3) < 0.3, `tail ${c.tailSilenceSec}`);
  assert.equal(c.abruptStart, false, 'a track with room before it does not start abruptly');
  const whole = analyzeSource(s.l, s.r, FS);
  assert.ok(whole.headSilenceSec < 0.01);
});

test('abrupt ends: cut mid-sound, against one that dies away', () => {
  const tone = sine(220, 4, FS, -12, 1);        // starts and stops mid-wave
  const cut = analyzeSource(tone, tone, FS);
  assert.equal(cut.abruptStart, true);
  assert.equal(cut.abruptEnd, true);
  assert.ok(cut.endLevelDb > -20);
  // The same with 50 ms ramps.
  const soft = new Float32Array(tone);
  const ramp = 0.05 * FS;
  for (let i = 0; i < ramp; i++) {
    soft[i] *= i / ramp;
    soft[soft.length - 1 - i] *= i / ramp;
  }
  const eased = analyzeSource(soft, soft, FS);
  assert.equal(eased.abruptStart, false);
  assert.equal(eased.abruptEnd, false);
});

test('clipping: flat tops are counted, clean peaks are not', () => {
  // A crest at full scale keeps moving sample to sample: not a flat top.
  for (const f of [30, 100, 1000]) {
    const clean = sine(f, 2, FS, -0.1);
    assert.equal(countClippedRuns(clean, clean), 0, `${f} Hz sine`);
  }
  const s = song(4);
  assert.equal(countClippedRuns(s.l, s.r), 0, 'music');
  const hot = sine(100, 2, FS, 6).map((v) => Math.max(-1, Math.min(1, v)));
  // Two flat tops a cycle, 200 cycles, both channels.
  const runs = countClippedRuns(hot, hot);
  assert.ok(runs > 780 && runs <= 800, `${runs} runs`);
  // Turned down afterwards, it was still clipped.
  const quiet = hot.map((v) => v * 0.5);
  assert.ok(countClippedRuns(quiet, quiet) > 780);
  // The count from the file's own samples is the one that's reported.
  assert.equal(analyzeSource(s.l, s.r, FS, 42).clippedRuns, 42);
});

test('nothing to read: silence and a blip', () => {
  const z = new Float32Array(FS * 3);
  const c = analyzeSource(z, z, FS);
  assert.equal(c.cutoffHz, null);
  assert.equal(c.abruptStart, false);
  assert.equal(c.abruptEnd, false);
  assert.equal(c.headSilenceSec, 0);
  const blip = new Float32Array(100).fill(0.3);
  assert.doesNotThrow(() => analyzeSource(blip, blip, FS));
});
