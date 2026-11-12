// The offline master: lands on the loudness target, under the ceiling, and
// in step with the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMaster } from '../src/audio/render/master';
import { measureIntegratedLufs, measureTruePeakDb } from '../src/audio/dsp/loudness';
import { ChainParams, defaultParams, PRESETS } from '../src/audio/dsp/params';
import { FS, song, sine, nullDb } from './lib/signals';

const paramsFor = (id: string, extra: Partial<ChainParams> = {}): ChainParams => {
  const p = PRESETS.find((x) => x.id === id)!;
  return { ...defaultParams(), ...p.macros, targetLufs: p.targetLufs, ceilingDb: p.ceilingDb, ...extra };
};

test('render: every loudness target lands within 0.1 LU, under the ceiling', () => {
  const src = song(20);
  const srcLufs = measureIntegratedLufs(src.l, src.r, FS);
  for (const id of ['flat', 'rock', 'hyperpop', 'classical']) {
    const params = { ...paramsFor(id), songLengthSec: 20 };
    const m = renderMaster(src.l, src.r, FS, params, srcLufs);
    assert.equal(m.L.length, src.l.length, 'as long as the source');
    assert.ok(Math.abs(m.lufs - params.targetLufs) <= 0.1, `${id}: ${m.lufs.toFixed(2)} LUFS for ${params.targetLufs}`);
    assert.ok(Math.abs(measureIntegratedLufs(m.L, m.R, FS) - m.lufs) < 1e-6, 'reports what it rendered');
    const tp = measureTruePeakDb(m.L, m.R);
    assert.ok(tp <= params.ceilingDb + 0.05, `${id}: ${tp.toFixed(2)} dBTP over ${params.ceilingDb}`);
  }
});

test('render: a flat master is the source, sample for sample, moved only in level', () => {
  // High tones under a moving envelope: far above the 18 Hz high-pass (the
  // one stage a flat console keeps), so a one-sample offset ruins the null.
  const n = FS * 6;
  const l = new Float32Array(n);
  for (const [f, a] of [[2100, 0.2], [5300, 0.15], [9100, 0.1]] as const) {
    const t = sine(f, 6, FS, 0);
    for (let i = 0; i < n; i++) l[i] += a * t[i] * (0.6 + 0.4 * Math.sin((2 * Math.PI * 1.7 * i) / FS));
  }
  const r = new Float32Array(l);
  const srcLufs = measureIntegratedLufs(l, r, FS);
  // A target quiet enough that the limiter never works.
  const m = renderMaster(l, r, FS, { ...paramsFor('flat'), targetLufs: -24, songLengthSec: 6 }, srcLufs);
  const g = Math.pow(10, m.appliedGainDb / 20) * Math.pow(10, (-18 - srcLufs) / 20);
  const depthAt = (lag: number) => {
    const scaled = new Float32Array(n);
    for (let i = Math.max(0, -lag); i < n - Math.max(0, lag); i++) scaled[i + lag] = l[i] * g;
    return nullDb(scaled, m.L, FS, n - FS);
  };
  const depth = depthAt(0);
  assert.ok(depth < -38, `nulls to ${depth.toFixed(1)} dB`);
  for (const lag of [-2, -1, 1, 2]) {
    assert.ok(depthAt(lag) > depth + 20, `a ${lag}-sample offset nulls to ${depthAt(lag).toFixed(1)} dB`);
  }
});

test('render: silence stays silence, at unity', () => {
  const z = new Float32Array(FS * 2);
  const m = renderMaster(z, new Float32Array(z), FS, { ...paramsFor('rock'), songLengthSec: 2 }, -70);
  assert.equal(m.measured, false);
  assert.equal(m.appliedGainDb, 0);
  assert.ok(m.L.every((v) => v === 0));
});

test('render: REF and LIM Δ never reach a render', () => {
  const tone = sine(440, 4, FS, -20);
  const base = { ...paramsFor('rock'), songLengthSec: 4 };
  const a = renderMaster(tone, new Float32Array(tone), FS, base, -23);
  const b = renderMaster(tone, new Float32Array(tone), FS, { ...base, bypass: true, limiterDelta: true, monitor: 'side' }, -23);
  assert.equal(nullDb(a.L, b.L), -Infinity);
});
