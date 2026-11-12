// The chain's measured claims. Each test builds a signal whose answer is
// known, runs the real DSP, and reads the result back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MasterChain } from '../src/audio/dsp/chain';
import { Limiter } from '../src/audio/dsp/limiter';
import { Saturator } from '../src/audio/dsp/saturator';
import { StemLanes } from '../src/audio/dsp/stemlanes';
import { StereoWidth } from '../src/audio/dsp/width';
import { measureIntegratedLufs, measureTruePeakDb, LoudnessMeter } from '../src/audio/dsp/loudness';
import { ChainParams, defaultParams, PRESETS, dbToLin } from '../src/audio/dsp/params';
import { fadeGainAt } from '../src/audio/dsp/fades';
import { resample } from '../src/audio/dsp/resample';
import { FS, sine, song, copy, toneDb, nullDb, peakDb, rmsDb, Stereo } from './lib/signals';

const close = (v: number, want: number, tol: number, what: string) =>
  assert.ok(Math.abs(v - want) <= tol, `${what}: ${v.toFixed(4)}, wanted ${want} ± ${tol}`);

function runChain(src: Stereo, params: Partial<ChainParams>, block: number, limiter = true): Stereo {
  const chain = new MasterChain(FS, block, { limiter });
  chain.setParams({ ...defaultParams(), songLengthSec: src.l.length / FS, ...params });
  chain.snapParams();
  const out = copy(src);
  for (let s = 0; s < out.l.length; s += block) {
    chain.processBlock(out.l, out.r, s, Math.min(block, out.l.length - s), s);
  }
  return out;
}

/** True peak by a second method: 8x band-limited resampling, then the sample peak. */
function truePeak8x(s: Stereo): number {
  return Math.max(peakDb(resample(s.l, FS, FS * 8)), peakDb(resample(s.r, FS, FS * 8)));
}

/** Nothing above `hz`: down to a rate whose Nyquist sits just past it, and back. */
function bandLimit(x: Float32Array, hz: number): Float32Array {
  const mid = Math.round(hz * 2.2);
  return resample(resample(x, FS, mid), mid, FS);
}

test('loudness: the EBU reference tone reads −23.0 LUFS', () => {
  // EBU Tech 3341 case 1: 1 kHz, −23 dBFS per channel, in phase, 20 s.
  const tone = sine(1000, 20, FS, -23);
  close(measureIntegratedLufs(tone, tone, FS), -23, 0.05, 'integrated');
  const meter = new LoudnessMeter(FS);
  meter.processBlock(tone, tone, 0, tone.length);
  close(meter.momentary, -23, 0.05, 'momentary');
  close(meter.shortTerm, -23, 0.05, 'short-term');
  close(meter.integrated, -23, 0.1, 'live integrated');
});

test('loudness: the same at 44.1 kHz', () => {
  const tone = sine(1000, 20, 44100, -23);
  close(measureIntegratedLufs(tone, tone, 44100), -23, 0.05, 'integrated');
});

test('limiter: holds the true-peak ceiling under 12 dB of drive', () => {
  // Band-limited to 20 kHz, as decoded music is.
  const raw = song(12);
  const s = { l: bandLimit(raw.l, 20000), r: bandLimit(raw.r, 20000) };
  const g = dbToLin(12);
  for (let i = 0; i < s.l.length; i++) { s.l[i] *= g; s.r[i] *= g; }
  const lim = new Limiter(FS);
  lim.setCeiling(-1);
  lim.processBlock(s.l, s.r, 0, s.l.length);
  assert.ok(lim.latency > 0);
  const tp = measureTruePeakDb(s.l, s.r);
  assert.ok(tp <= -0.95, `own meter reads ${tp.toFixed(3)} dBTP`);
  const tp8 = truePeak8x(s);
  assert.ok(tp8 <= -0.9, `independent 8x reading ${tp8.toFixed(3)} dBTP`);
});

test('limiter: under the ceiling it is a pure delay', () => {
  const s = song(4);
  const before = copy(s);
  const lim = new Limiter(FS);
  lim.setCeiling(-0.1);
  // The song peaks under −0.1 dBFS only if scaled down; make sure of it.
  const k = dbToLin(-6 - peakDb(s.l));
  for (let i = 0; i < s.l.length; i++) { s.l[i] *= k; s.r[i] *= k; before.l[i] *= k; before.r[i] *= k; }
  lim.processBlock(s.l, s.r, 0, s.l.length);
  const lat = lim.latency;
  const delayed = before.l.subarray(0, before.l.length - lat);
  assert.equal(nullDb(delayed, s.l.subarray(lat)), -Infinity);
});

test('chain: preview blocks (128) and export blocks (4096) are bit-identical', () => {
  const src = song(8);
  for (const id of ['rock', 'lofi', 'hyperpop', 'ambient']) {
    const preset = PRESETS.find((p) => p.id === id)!;
    const params: Partial<ChainParams> = {
      ...preset.macros, targetLufs: preset.targetLufs, ceilingDb: preset.ceilingDb,
      stagingGainDb: 2, outputGainDb: 6, fadeInSec: 0.5, fadeOutSec: 1, bassMono: true,
      stemBassDb: 1.5, stemDrumsDb: -2, stemVocalDb: 1, stemAirDb: 2,
      matchEqGains: [1, -1, 0.5, 0, 2, -2, 1, 0, -1, 3],
    };
    const a = runChain(src, params, 128);
    const b = runChain(src, params, 4096);
    assert.equal(nullDb(a.l, b.l), -Infinity, `${id} left`);
    assert.equal(nullDb(a.r, b.r), -Infinity, `${id} right`);
  }
});

test('chain: flat settings pass the signal untouched (HPF aside)', () => {
  const tone = sine(1000, 2, FS, -12);
  const out = runChain({ l: tone, r: new Float32Array(tone) }, { outputGainDb: 0 }, 4096, false);
  close(toneDb(out.l, 1000, FS, FS / 2, tone.length), -12, 0.01, '1 kHz');
});

test('CHARACTER: adds colour, not level, and stays flat to 15 kHz', () => {
  for (const drive of [0.3, 1]) {
    for (const f of [100, 1000, 10000, 15000]) {
      const sat = new Saturator(FS);
      sat.setDrive(drive);
      const x = sine(f, 1, FS, -50);
      const r = new Float32Array(x);
      sat.processBlock(x, r, 0, x.length);
      close(toneDb(x, f, FS, FS / 4, x.length), -50, 0.05, `drive ${drive}, ${f} Hz`);
    }
  }
});

test('STEM LANES: unity trims change nothing, and each lane moves its band', () => {
  const s = song(4);
  const lanes = new StemLanes(FS);
  lanes.setTrims(0, 0, 0, 0);
  const out = copy(s);
  lanes.processBlock(out.l, out.r, 0, out.l.length);
  assert.equal(nullDb(s.l, out.l), -Infinity);

  const probe = (freq: number, trims: [number, number, number, number]) => {
    const l = new StemLanes(FS);
    l.setTrims(...trims);
    const x = sine(freq, 1, FS, -20);
    const y = new Float32Array(x);
    l.processBlock(x, y, 0, x.length);
    return toneDb(x, freq, FS, FS / 4, x.length) + 20;
  };
  close(probe(40, [3, 0, 0, 0]), 3, 0.3, 'bass lane at 40 Hz');
  close(probe(1000, [3, 0, 0, 0]), 0, 0.1, 'bass lane leaves 1 kHz');
  close(probe(16000, [0, 0, 0, 3]), 3, 0.3, 'air lane at 16 kHz');
  close(probe(1000, [0, 0, 0, 3]), 0, 0.25, 'air lane leaves 1 kHz');
  close(probe(900, [0, 0, -3, 0]), -3, 0.3, 'vocal lane at its centre');
  close(probe(60, [0, 0, 3, 0]), 0, 0.3, 'vocal lane leaves the bass');
});

test('STEM LANES: a trim never moves a band the other way', () => {
  // A parallel band added back out of phase carves a notch beside the
  // boost: every frequency must move with the trim, or not at all.
  const freqs = [20, 30, 50, 80, 100, 120, 150, 200, 250, 400, 700, 1000, 2000, 3500, 5000, 8000, 10000, 16000];
  const lanes: [string, (db: number) => [number, number, number, number]][] = [
    ['bass', (db) => [db, 0, 0, 0]], ['vocal', (db) => [0, 0, db, 0]], ['air', (db) => [0, 0, 0, db]],
  ];
  for (const [name, trims] of lanes) {
    for (const db of [3, -3]) {
      for (const f of freqs) {
        const l = new StemLanes(FS);
        l.setTrims(...trims(db));
        const x = sine(f, 1, FS, -20);
        const y = new Float32Array(x);
        l.processBlock(x, y, 0, x.length);
        const moved = toneDb(x, f, FS, FS / 2, x.length) + 20;
        assert.ok(Math.sign(db) * moved >= -0.05 && Math.abs(moved) <= 3.05,
          `${name} ${db > 0 ? '+' : ''}${db} dB moves ${f} Hz by ${moved.toFixed(2)} dB`);
      }
    }
  }
});

test('WIDTH: mono stays mono, bass mono empties the side below 140 Hz', () => {
  const w = new StereoWidth(FS);
  w.setWidth(1.5);
  const m = sine(440, 0.5, FS, -12);
  const l = new Float32Array(m), r = new Float32Array(m);
  w.processBlock(l, r, 0, l.length);
  assert.equal(nullDb(l, r), -Infinity);

  const bm = new StereoWidth(FS);
  bm.setWidth(1);
  bm.setBassMono(true);
  const lo = sine(60, 2, FS, -12);
  const a = new Float32Array(lo), b = new Float32Array(lo.length); // hard left
  bm.processBlock(a, b, 0, a.length);
  const side = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) side[i] = 0.5 * (a[i] - b[i]);
  assert.ok(rmsDb(side, FS, side.length) < -45, `side at 60 Hz: ${rmsDb(side, FS, side.length).toFixed(1)} dB`);
});

test('fades: start silent, end silent, unity between', () => {
  assert.equal(fadeGainAt(0, 2, 3, 'smooth', 'smooth', 60), 0);
  assert.equal(fadeGainAt(60, 2, 3, 'smooth', 'smooth', 60), 0);
  assert.equal(fadeGainAt(30, 2, 3, 'linear', 'exp', 60), 1);
  close(fadeGainAt(1, 2, 0, 'linear', 'linear', 60), 0.5, 1e-9, 'linear midpoint');
});
