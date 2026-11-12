// The stages added or rebuilt in 3.0, each against a signal whose answer is known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MasterChain, trimFadeGain } from '../src/audio/dsp/chain';
import { Oversampler4x } from '../src/audio/dsp/oversampler';
import { Saturator } from '../src/audio/dsp/saturator';
import { Clipper } from '../src/audio/dsp/clipper';
import { AirRestore, RESTORE_FULL_REL_DB } from '../src/audio/dsp/exciter';
import { StereoWidth } from '../src/audio/dsp/width';
import { GlueCompressor } from '../src/audio/dsp/compressor';
import { loudnessRangeFromHops, computeLoudnessHops, measureIntegratedLufs, measureTruePeakDb } from '../src/audio/dsp/loudness';
import { renderMaster, keptAudio } from '../src/audio/render/master';
import { resample } from '../src/audio/dsp/resample';
import { ChainParams, defaultParams, defaultAdvEq, PRESETS, dbToLin } from '../src/audio/dsp/params';
import { FS, sine, song, pinkNoise, whiteNoise, toneDb, nullDb, peakDb, rmsDb, copy, Stereo } from './lib/signals';

const close = (v: number, want: number, tol: number, what: string) =>
  assert.ok(Math.abs(v - want) <= tol, `${what}: ${v.toFixed(4)}, wanted ${want} ± ${tol}`);

function bandLimit(x: Float32Array, hz: number): Float32Array {
  const mid = Math.round(hz * 2.2);
  return resample(resample(x, FS, mid), mid, FS);
}

/** Only what lies between two frequencies. */
function bandOnly(x: Float32Array, lo: number, hi: number): Float32Array {
  const a = bandLimit(x, hi), b = bandLimit(x, lo);
  const d = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) d[i] = a[i] - b[i];
  return d;
}

/** RMS level between two frequencies, by band-limiting twice and subtracting. */
function bandDb(x: Float32Array, lo: number, hi: number): number {
  const a = bandLimit(x, hi), b = bandLimit(x, lo);
  const d = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) d[i] = a[i] - b[i];
  return rmsDb(d, 4800, x.length - 4800);
}

function runChain(src: Stereo, params: Partial<ChainParams>, block: number, opts: { limiter?: boolean; clipper?: boolean } = {}): { out: Stereo; latency: number } {
  const chain = new MasterChain(FS, block, opts);
  chain.setParams({ ...defaultParams(), outputGainDb: 0, songLengthSec: src.l.length / FS, ...params });
  chain.snapParams();
  const lat = chain.latency;
  const out = { l: new Float32Array(src.l.length + lat), r: new Float32Array(src.r.length + lat) };
  out.l.set(src.l); out.r.set(src.r);
  for (let s = 0; s < out.l.length; s += block) {
    chain.processBlock(out.l, out.r, s, Math.min(block, out.l.length - s), s);
  }
  return { out: { l: out.l.subarray(lat), r: out.r.subarray(lat) }, latency: lat };
}

// ── oversampler ────────────────────────────────────────────────────────
test('oversampler: a whole-sample delay, flat to 20 kHz, the same at any block size', () => {
  const lat = Oversampler4x.latency;
  assert.ok(Number.isInteger(lat), `latency ${lat}`);
  const x = bandLimit(whiteNoise(1, FS, -12, 2), 18000);
  const run = (block: number) => {
    const os = new Oversampler4x();
    const y = new Float32Array(x);
    for (let s = 0; s < y.length; s += block) {
      const n = Math.min(block, y.length - s);
      os.up(y, s, n);
      os.down(y, s, n);
    }
    return y;
  };
  const y = run(4096);
  const ref = new Float32Array(x.length);
  for (let i = lat; i < x.length; i++) ref[i] = x[i - lat];
  assert.ok(nullDb(ref, y, 1000, x.length - 1000) < -70, 'identity round trip is the input, delayed');
  assert.equal(nullDb(y, run(128)), -Infinity, 'block 128 = block 4096');
  assert.equal(nullDb(y, run(37)), -Infinity, 'block 37 = block 4096');
  for (const f of [1000, 10000, 18000, 20000]) {
    const s = sine(f, 0.5, FS, -6);
    const os = new Oversampler4x();
    os.up(s, 0, s.length);
    os.down(s, 0, s.length);
    close(toneDb(s, f, FS, 4800, s.length), -6, 0.01, `${f} Hz through the round trip`);
  }
});

test('oversampler: harmonics made at 4x do not fold back', () => {
  // A hard-clipped 7 kHz tone: its 5th harmonic (35 kHz) would land on 13 kHz.
  const s = sine(7000, 1, FS, 6);
  const naive = s.map((v) => Math.max(-0.5, Math.min(0.5, v)));
  const os = new Oversampler4x();
  const hi = os.up(s, 0, s.length);
  for (let i = 0; i < hi.length; i++) hi[i] = Math.max(-0.5, Math.min(0.5, hi[i]));
  os.down(s, 0, s.length);
  const alias = toneDb(s, 13000, FS, 4800);
  assert.ok(alias < -60, `alias at ${alias.toFixed(1)} dBFS`);
  assert.ok(toneDb(naive, 13000, FS, 4800) > -25, 'the same clip without oversampling folds audibly');
});

// ── CHARACTER ──────────────────────────────────────────────────────────
test('CHARACTER: the first step of the knob is as small as any other', () => {
  // 2 kHz: far above the stage's 5 Hz DC blocker, whose phase would
  // otherwise be all the null shows.
  const x = sine(2000, 0.5, FS, -1);
  const at = (drive: number) => {
    const sat = new Saturator(FS);
    sat.setDrive(drive);
    const l = new Float32Array(x), r = new Float32Array(x);
    sat.processBlock(l, r, 0, l.length);
    return l;
  };
  const rest = at(0);
  const first = at(0.002);
  // Just past zero the stage is (almost) its own resting delay.
  assert.ok(nullDb(rest, first, 4800) < -48, `first step changes the signal by ${nullDb(rest, first, 4800).toFixed(1)} dB`);
  // Third harmonic grows with the knob, from nothing.
  const h3 = [0.002, 0.25, 0.5, 1].map((d) => toneDb(at(d), 6000, FS, 4800));
  assert.ok(h3[0] < -75, `H3 at the first step: ${h3[0].toFixed(1)} dB`);
  assert.ok(h3[1] < h3[2] && h3[2] < h3[3], `H3 rises with drive: ${h3.map((v) => v.toFixed(1)).join(', ')}`);
});

test('CHARACTER: waking mid-stream carries on from the resting delay', () => {
  const sat = new Saturator(FS);
  const x = bandOnly(whiteNoise(1, FS, -30, 5), 1000, 16000);
  const l = new Float32Array(x), r = new Float32Array(x);
  sat.setDrive(0);
  sat.processBlock(l, r, 0, 24000);
  sat.setDrive(0.01);                         // on, but near enough the identity
  for (let s = 24000; s < l.length; s += 128) sat.processBlock(l, r, s, Math.min(128, l.length - s));
  const ref = new Float32Array(x.length);
  for (let i = Saturator.latency; i < x.length; i++) ref[i] = x[i - Saturator.latency];
  // No hole, no burst at the join: the output is the delayed input throughout.
  assert.ok(nullDb(ref, l, 23000, 26000) < -50, `join nulls to ${nullDb(ref, l, 23000, 26000).toFixed(1)} dB`);
});

// ── CLIP ───────────────────────────────────────────────────────────────
test('CLIP: untouched under the knee, bounded above it', () => {
  for (const [mode, topDb] of [['soft', 3], ['hard', 1]] as const) {
    const quiet = sine(1000, 0.5, FS, -4);
    const c = new Clipper();
    c.setCeiling(-1);
    c.setMode(mode);
    const l = new Float32Array(quiet), r = new Float32Array(quiet);
    c.processBlock(l, r, 0, l.length);
    const ref = new Float32Array(quiet.length);
    for (let i = Clipper.latency; i < ref.length; i++) ref[i] = quiet[i - Clipper.latency];
    assert.ok(nullDb(ref, l, 4800) < -80, `${mode}: under the knee nulls to ${nullDb(ref, l, 4800).toFixed(1)} dB`);

    const loud = sine(1000, 0.5, FS, 9);
    const c2 = new Clipper();
    c2.setCeiling(-1);
    c2.setMode(mode);
    const l2 = new Float32Array(loud), r2 = new Float32Array(loud);
    c2.processBlock(l2, r2, 0, l2.length);
    close(peakDb(l2, 4800), -1 + topDb, 0.25, `${mode}: a +9 dBFS tone tops out`);
  }
});

test('CLIP: the same result whatever the block size, resting or working', () => {
  // Quiet stretches (resting) between loud hits (working): the stage must
  // wake and rest at the same samples in a preview block and an export block.
  const s = song(6);
  const g = dbToLin(8);
  for (let i = 0; i < s.l.length; i++) { s.l[i] *= g; s.r[i] *= g; }
  const run = (block: number) => {
    const c = new Clipper();
    c.setCeiling(-1);
    c.setMode('soft');
    const o = copy(s);
    for (let p = 0; p < o.l.length; p += block) c.processBlock(o.l, o.r, p, Math.min(block, o.l.length - p));
    return o;
  };
  const a = run(4096), b = run(128), c = run(61);
  assert.equal(nullDb(a.l, b.l), -Infinity);
  assert.equal(nullDb(a.r, c.r), -Infinity);
});

test('CLIP: takes the limiter\'s work, at the same loudness', () => {
  const src = song(16);
  const lufs = measureIntegratedLufs(src.l, src.r, FS);
  const base = { ...defaultParams(), targetLufs: -9, ceilingDb: -1, songLengthSec: 16 };
  const off = renderMaster(src.l, src.r, FS, base, lufs);
  const soft = renderMaster(src.l, src.r, FS, { ...base, clipMode: 'soft' }, lufs);
  const hard = renderMaster(src.l, src.r, FS, { ...base, clipMode: 'hard' }, lufs);
  for (const [name, m] of [['off', off], ['soft', soft], ['hard', hard]] as const) {
    close(m.lufs, -9, 0.1, `${name}: loudness`);
    assert.ok(measureTruePeakDb(m.L, m.R) <= -0.95, `${name}: ceiling holds`);
    assert.equal(m.L.length, src.l.length);
  }
  assert.ok(soft.limiterMaxGrDb < off.limiterMaxGrDb - 3, `soft: limiter ${soft.limiterMaxGrDb.toFixed(1)} dB vs ${off.limiterMaxGrDb.toFixed(1)}`);
  assert.ok(hard.limiterMaxGrDb < soft.limiterMaxGrDb, `hard: limiter ${hard.limiterMaxGrDb.toFixed(1)} dB`);
  assert.ok(soft.clipMaxGrDb > 1 && off.clipMaxGrDb === 0);
});

// ── AIR RESTORE ────────────────────────────────────────────────────────
test('AIR RESTORE: fills the band above the cut, leaves the rest alone', () => {
  const cut = 16000;
  const src = bandLimit(pinkNoise(6, FS, -20, 11), cut * 0.93);
  const before = bandDb(src, cut * 1.03, 21000);
  const octave = bandDb(src, cut / 2, cut * 0.9);
  assert.ok(before < octave - 60, 'the source really is empty up there');
  for (const amount of [1, 0.5]) {
    const ex = new AirRestore(FS);
    ex.setCutoff(cut);
    ex.setAmount(amount);
    const l = new Float32Array(src), r = new Float32Array(src);
    for (let s = 0; s < l.length; s += 128) ex.processBlock(l, r, s, Math.min(128, l.length - s));
    const made = bandDb(l, cut * 1.03, 21000) - octave;
    close(made, RESTORE_FULL_REL_DB + 20 * Math.log10(amount), 2.5, `amount ${amount}: new band against its source octave`);
    close(bandDb(l, 1000, 4000) - bandDb(src, 1000, 4000), 0, 0.02, 'mid band');
    close(bandDb(l, cut / 2, cut * 0.9) - octave, 0, 0.3, 'source octave');
  }
});

test('AIR RESTORE: off is a pure delay, and block size does not matter', () => {
  const src = song(3);
  const ex = new AirRestore(FS);
  ex.setAmount(0);
  const o = copy(src);
  ex.processBlock(o.l, o.r, 0, o.l.length);
  const lat = AirRestore.latency;
  assert.equal(nullDb(src.l.subarray(0, src.l.length - lat), o.l.subarray(lat)), -Infinity);
  const run = (block: number) => {
    const e = new AirRestore(FS);
    e.setCutoff(15000);
    e.setAmount(0.6);
    const c = copy(src);
    for (let p = 0; p < c.l.length; p += block) e.processBlock(c.l, c.r, p, Math.min(block, c.l.length - p));
    return c;
  };
  assert.equal(nullDb(run(4096).l, run(128).l), -Infinity);
});

// ── WIDTH ──────────────────────────────────────────────────────────────
test('WIDTH: widening never narrows any frequency', () => {
  for (const width of [1.3, 1.45, 2]) {
    const wMid = 1 + (width - 1) * 0.7, wHigh = 1 + (width - 1) * 1.15;
    for (const f of [40, 100, 140, 180, 300, 1000, 2000, 3000, 6000, 12000]) {
      const w = new StereoWidth(FS);
      w.setWidth(width);
      const x = sine(f, 1, FS, -20);
      const l = new Float32Array(x), r = x.map((v) => -v);   // side only
      w.processBlock(l, r, 0, l.length);
      const gain = dbToLin(toneDb(l, f, FS, FS / 2) + 20);
      assert.ok(gain >= 0.995 && gain <= wHigh * 1.01, `width ${width}: side gain at ${f} Hz is ${gain.toFixed(3)}`);
      if (f === 40) close(gain, 1, 0.06, `width ${width}: bass stays anchored`);
      if (f === 500 || f === 1000) assert.ok(gain > 1 && gain < wHigh, `mids open part-way (${wMid.toFixed(2)})`);
      if (f === 12000) close(gain, wHigh, 0.03, `width ${width}: highs open furthest`);
    }
  }
});

// ── DENSITY ────────────────────────────────────────────────────────────
test('DENSITY: the first hit after silence is compressed like any other', () => {
  const settle = (lead: Float32Array) => {
    const comp = new GlueCompressor(FS);
    comp.setAmount(1);
    const tone = sine(1000, 0.5, FS, -10);
    const l = new Float32Array(lead.length + tone.length);
    l.set(lead); l.set(tone, lead.length);
    const r = new Float32Array(l);
    comp.processBlock(l, r, 0, l.length);
    // Level of the tone 20–40 ms in, against its settled level at the end.
    const at = (ms0: number, ms1: number) => rmsDb(l, lead.length + (ms0 * FS) / 1000, lead.length + (ms1 * FS) / 1000);
    return at(40, 60) - at(400, 500);
  };
  const fromSilence = settle(new Float32Array(FS));
  const fromBed = settle(sine(1000, 1, FS, -40));
  // (Before: the detector climbed out of silence for 60 ms with no gain
  // reduction at all, 4 to 5 dB over.)
  assert.ok(fromSilence < 3.2, `40-60 ms after silence the tone is ${fromSilence.toFixed(2)} dB over its settled level`);
  close(fromSilence, fromBed, 0.6, 'after silence vs after a quiet bed');
});

test('DENSITY: its make-up comes in with the knob, not all at once', () => {
  const level = (density: number) => {
    const comp = new GlueCompressor(FS);
    comp.setAmount(density);
    const x = sine(1000, 1, FS, -40);          // far under the threshold
    const r = new Float32Array(x);
    comp.processBlock(x, r, 0, x.length);
    return rmsDb(x, FS / 2) - rmsDb(sine(1000, 1, FS, -40), FS / 2);
  };
  assert.ok(Math.abs(level(0.0011)) < 0.02, `first step moves a quiet signal ${level(0.0011).toFixed(3)} dB`);
  assert.ok(level(0.5) > 0.5, 'and it is there from a tenth of the knob up');
});

// ── LRA ────────────────────────────────────────────────────────────────
test('LRA: EBU Tech 3342 cases', () => {
  // Case 1: 20 s at −20 LUFS then 20 s at −30 LUFS: LRA 10 ± 1.
  // Case 3: −40 then −20: 20 ± 1.  Case 4: −50, −35, −20, −35, −50: 15 ± 1.
  const seq = (levels: number[]) => {
    const parts = levels.map((db) => sine(1000, 20, FS, db));
    const n = parts.reduce((a, p) => a + p.length, 0);
    const x = new Float32Array(n);
    let o = 0;
    for (const p of parts) { x.set(p, o); o += p.length; }
    return loudnessRangeFromHops(computeLoudnessHops(x, x, FS));
  };
  close(seq([-20, -30]), 10, 1, '3342 case 1');
  close(seq([-40, -20]), 20, 1, '3342 case 3');
  close(seq([-50, -35, -20, -35, -50]), 15, 1, '3342 case 4');
});

// ── chain: latency, trim, mid/side EQ ──────────────────────────────────
test('chain: the same latency at every setting, and the master stays in step', () => {
  // No lows: the 18 Hz high-pass a flat console keeps would turn their phase.
  const src = bandOnly(whiteNoise(4, FS, -24, 8), 1500, 12000);
  const s = { l: src, r: new Float32Array(src) };
  const flat = runChain(s, {}, 4096, { limiter: false, clipper: false });
  const busy = runChain(s, { character: 0.02, airRestore: 0.001 }, 4096, { limiter: false, clipper: false });
  assert.equal(flat.latency, busy.latency);
  // Flat: the delayed input itself (but for the 18 Hz high-pass).
  assert.ok(nullDb(src, flat.out.l, FS, 3 * FS) < -38, `flat nulls to ${nullDb(src, flat.out.l, FS, 3 * FS).toFixed(1)} dB`);
  // With the oversampled stages barely on, still in step with the source.
  assert.ok(nullDb(src, busy.out.l, FS, 3 * FS) < -30, `with stages on: ${nullDb(src, busy.out.l, FS, 3 * FS).toFixed(1)} dB`);
});

test('chain: a master with every stage working lines up with its source', () => {
  // Rock, hot enough to drive the saturator: find the lag of best fit.
  const src = song(6);
  const p = PRESETS.find((x) => x.id === 'rock')!;
  const lufs = measureIntegratedLufs(src.l, src.r, FS);
  const m = renderMaster(src.l, src.r, FS, { ...defaultParams(), ...p.macros, targetLufs: -20, ceilingDb: -1, clipMode: 'soft', songLengthSec: 6 }, lufs);
  let best = 0, bestCorr = -Infinity;
  for (let lag = -60; lag <= 60; lag++) {
    let c = 0;
    for (let i = FS; i < 4 * FS; i++) c += src.l[i] * m.L[i + lag];
    if (c > bestCorr) { bestCorr = c; best = lag; }
  }
  assert.equal(best, 0, `master lags its source by ${best} samples`);
});

test('TRIM: silent outside, the fades inside, the export only the kept part', () => {
  const tone = sine(1000, 10, FS, -12);
  const s = { l: tone, r: new Float32Array(tone) };
  const params = { trimStartSec: 2, trimEndSec: 8, fadeInSec: 1, fadeOutSec: 2, fadeInCurve: 'linear' as const, fadeOutCurve: 'linear' as const };
  const { out } = runChain(s, params, 4096, { limiter: false, clipper: false });
  const lvl = (a: number, b: number) => rmsDb(out.l, Math.round(a * FS), Math.round(b * FS));
  assert.ok(lvl(0.1, 1.95) < -120, 'silent before the trim');
  assert.ok(lvl(8.05, 9.9) < -120, 'silent after it');
  close(lvl(4, 5), -15, 0.05, 'full level in the middle');                 // a −12 dBFS sine is −15 dB RMS
  close(lvl(2.45, 2.55), -15 - 6.02, 0.3, 'halfway up the fade-in, 0.5 s into the kept part');
  close(lvl(6.95, 7.05), -15 - 6.02, 0.3, 'halfway down the fade-out, 1 s before the kept part ends');
  // Block size changes nothing.
  assert.equal(nullDb(out.l, runChain(s, params, 128, { limiter: false, clipper: false }).out.l), -Infinity);

  const m = renderMaster(tone, new Float32Array(tone), FS, { ...defaultParams(), ...params, targetLufs: -20, songLengthSec: 10 }, -15);
  const kept = keptAudio(m);
  assert.equal(kept.L.length, 6 * FS);
  assert.equal(m.L.length, 10 * FS);
  assert.ok(Math.abs(kept.L[0]) < 1e-4 && Math.abs(kept.L[kept.L.length - 1]) < 1e-3, 'starts and ends at silence');
});

test('TRIM: a cut with no fade gets a 3 ms edge instead of a click', () => {
  const p = { ...defaultParams(), trimStartSec: 1, trimEndSec: 3, songLengthSec: 5 };
  assert.equal(trimFadeGain(0.99, p), 0);
  assert.equal(trimFadeGain(1, p), 0);
  assert.ok(trimFadeGain(1.0015, p) > 0.4 && trimFadeGain(1.0015, p) < 0.6);
  assert.equal(trimFadeGain(2, p), 1);
  assert.equal(trimFadeGain(3, p), 0);
  // No trim: nothing but the fades.
  assert.equal(trimFadeGain(0, { ...p, trimStartSec: 0, trimEndSec: 0 }), 1);
});

test('EQ: a mid band leaves the sides alone, a side band leaves the centre alone', () => {
  const eq = (ch: 'mid' | 'side' | 'stereo') => {
    const bands = defaultAdvEq();
    bands[2] = { on: true, type: 'peak', freq: 1000, gainDb: 6, q: 1, ch };
    return bands;
  };
  const x = sine(1000, 1, FS, -20);
  const centre = { l: x, r: new Float32Array(x) };
  const sides = { l: x, r: x.map((v) => -v) };
  const gain = (s: Stereo, ch: 'mid' | 'side' | 'stereo') =>
    toneDb(runChain(s, { advEq: eq(ch) }, 4096, { limiter: false, clipper: false }).out.l, 1000, FS, FS / 2) + 20;
  close(gain(centre, 'mid'), 6, 0.05, 'mid band on centre content');
  close(gain(sides, 'mid'), 0, 0.05, 'mid band on side content');
  close(gain(sides, 'side'), 6, 0.05, 'side band on side content');
  close(gain(centre, 'side'), 0, 0.05, 'side band on centre content');
  close(gain(centre, 'stereo'), 6, 0.05, 'stereo band');
});

test('EQ: high-pass and low-pass bands', () => {
  const bands = defaultAdvEq();
  bands[0] = { on: true, type: 'highpass', freq: 100, gainDb: 0, q: 0.7 };
  bands[5] = { on: true, type: 'lowpass', freq: 8000, gainDb: 0, q: 0.7 };
  const at = (f: number) => {
    const x = sine(f, 1, FS, -20);
    return toneDb(runChain({ l: x, r: new Float32Array(x) }, { advEq: bands }, 4096, { limiter: false, clipper: false }).out.l, f, FS, FS / 2) + 20;
  };
  close(at(100), -3, 0.3, 'high-pass corner');
  assert.ok(at(25) < -20, 'well under the high-pass');
  close(at(1000), 0, 0.1, 'passband');
  close(at(8000), -3, 0.3, 'low-pass corner');
  // A side-only high-pass at 100 Hz is how bass is kept mono by hand.
  const sideHp = defaultAdvEq();
  sideHp[0] = { on: true, type: 'highpass', freq: 120, gainDb: 0, q: 0.7, ch: 'side' };
  const lo = sine(50, 1, FS, -20);
  const o = runChain({ l: lo, r: new Float32Array(lo.length) }, { advEq: sideHp }, 4096, { limiter: false, clipper: false }).out;
  const side = new Float32Array(lo.length);
  for (let i = 0; i < side.length; i++) side[i] = 0.5 * (o.l[i] - o.r[i]);
  assert.ok(rmsDb(side, FS / 2) < rmsDb(lo, FS / 2) - 6 - 12, 'side lows are cut');
});

// ── the solve ──────────────────────────────────────────────────────────
test('solve: a target out of reach stops early and says so', () => {
  const pk = pinkNoise(12, FS, -20, 3), pk2 = pinkNoise(12, FS, -20, 4);
  const lufs = measureIntegratedLufs(pk, pk2, FS);
  const params = { ...defaultParams(), targetLufs: -6, ceilingDb: -1, songLengthSec: 12 };
  let passes = 0;
  const heard = renderMaster(pk, pk2, FS, params, lufs, (phase) => { if (phase.startsWith('LIMITING')) passes++; });
  assert.equal(heard.reached, false);
  assert.ok(heard.lufs < -6.5, `landed at ${heard.lufs.toFixed(2)} LUFS`);
  assert.ok(heard.appliedGainDb < 25, `gain ${heard.appliedGainDb.toFixed(1)} dB`);
  assert.ok(passes <= 9, `${passes} passes`);
  // Nobody listening to the progress: the same master.
  const silent = renderMaster(pk, pk2, FS, params, lufs);
  assert.equal(silent.appliedGainDb, heard.appliedGainDb);
  assert.equal(nullDb(silent.L, heard.L), -Infinity);
});

test('render: delivered at 44.1 kHz, loudness and ceiling hold at that rate', () => {
  // Band-limited to 18 kHz, as music is, so the reading does not hang on
  // content at the very edge of the new Nyquist.
  const raw = song(10);
  const src = { l: bandLimit(raw.l, 18000), r: bandLimit(raw.r, 18000) };
  const lufs = measureIntegratedLufs(src.l, src.r, FS);
  const p = PRESETS.find((x) => x.id === 'pop')!;
  const params = { ...defaultParams(), ...p.macros, targetLufs: p.targetLufs, ceilingDb: -1, songLengthSec: 10 };
  const m = renderMaster(src.l, src.r, FS, params, lufs, { outRate: 44100 });
  assert.equal(m.fs, 44100);
  assert.equal(m.L.length, 441000);
  close(measureIntegratedLufs(m.L, m.R, 44100), p.targetLufs, 0.1, 'loudness at 44.1 kHz');
  assert.ok(measureTruePeakDb(m.L, m.R) <= -0.95, `true peak ${measureTruePeakDb(m.L, m.R).toFixed(2)}`);
  const tp8 = Math.max(peakDb(resample(m.L, 44100, 352800)), peakDb(resample(m.R, 44100, 352800)));
  assert.ok(tp8 <= -0.9, `independent 8x reading ${tp8.toFixed(3)} dBTP`);
});

test('SOURCE FIX: a dead side is filled, an inverted side is turned back', () => {
  const x = sine(1000, 1, FS, -20);
  const dead = { l: x, r: new Float32Array(x.length) };
  const filled = runChain(dead, { sourceFix: 'left' }, 4096, { limiter: false, clipper: false }).out;
  assert.equal(nullDb(filled.l, filled.r), -Infinity);
  const inverted = { l: x, r: x.map((v) => -v) };
  const turned = runChain(inverted, { sourceFix: 'flip' }, 128, { limiter: false, clipper: false }).out;
  assert.equal(nullDb(turned.l, turned.r), -Infinity);
  close(toneDb(turned.l, 1000, FS, FS / 2), -20, 0.02, 'level unchanged');
});
