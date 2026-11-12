// The meters rack's arithmetic and memory: the running loudness range
// against the offline measurement, the holds and counters, the spectrum's
// axis, and what the book keeps (and lets go of) from frame to frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FS, pinkNoise } from './lib/signals';
import { computeLoudnessHops, loudnessRangeFromHops } from '../src/audio/dsp/loudness';
import {
  lraFromShortTerm, ShortTermSeries, PeakHold, SlidingMax, OverCounter,
  hzToX, xToHz, slopeDb, spectrumBands, noteName, hzText, levelText, timeTickStep,
} from '../src/lib/meter-math';
import { MeterBook, HISTORY_STEP_SEC } from '../src/lib/meter-book';
import type { MeterFrame } from '../src/audio/engine';

const near = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

/** Quiet, loud, quieter, near-silence: something with a range to measure. */
function dynamicHops(): number[] {
  const parts: [number, number][] = [[8, -34], [8, -16], [6, -24], [5, -78], [6, -19]];
  const total = parts.reduce((a, [sec]) => a + sec, 0) * FS;
  const l = new Float32Array(total);
  const r = new Float32Array(total);
  let at = 0;
  parts.forEach(([sec, db], i) => {
    l.set(pinkNoise(sec, FS, db, 11 + i), at);
    r.set(pinkNoise(sec, FS, db, 31 + i), at);
    at += sec * FS;
  });
  return computeLoudnessHops(l, r, FS);
}

/** The short-term values the offline measurement gates: one per hop, each over the last 3 s. */
function shortTermOf(hops: number[]): number[] {
  const out: number[] = [];
  for (let end = 30; end <= hops.length; end++) {
    let e = 0;
    for (let i = end - 30; i < end; i++) e += hops[i];
    out.push(-0.691 + 10 * Math.log10(Math.max(e / 30, 1e-12)));
  }
  return out;
}

test('the running loudness range is the offline one, given the same short-term values', () => {
  const hops = dynamicHops();
  const offline = loudnessRangeFromHops(hops);
  assert.ok(offline > 5, `the material has a range to measure (${offline.toFixed(2)} LU)`);
  near(lraFromShortTerm(shortTermOf(hops)), offline, 1e-6);
  // And through the series the live meter fills.
  const series = new ShortTermSeries();
  for (const v of shortTermOf(hops)) series.push(v);
  near(series.lra(), offline, 1e-3, 'float32 storage');
});

test('silence and a steady level have no range', () => {
  assert.equal(lraFromShortTerm([]), 0);
  assert.equal(lraFromShortTerm([-80, -90, -75]), 0);
  assert.equal(lraFromShortTerm(new Array(100).fill(-14)), 0);
  assert.equal(lraFromShortTerm([-14]), 0);
});

test('the gates: silence never counts, and what sits 20 LU under the rest is left out', () => {
  const loud = new Array(200).fill(0).map((_, i) => -16 + (i % 5));       // -16 .. -12
  const withTail = [...loud, ...new Array(60).fill(-50), ...new Array(60).fill(-90)];
  near(lraFromShortTerm(withTail), lraFromShortTerm(loud), 1e-9);
  assert.equal(lraFromShortTerm(loud), 4);
});

test('the series ignores silence, grows, and stops at its cap', () => {
  const s = new ShortTermSeries();
  s.push(-80);
  s.push(NaN);
  assert.equal(s.length, 0);
  for (let i = 0; i < 5000; i++) s.push(-20 + (i % 10));
  assert.equal(s.length, 5000);
  // Ten levels a decibel apart, -20 to -11: the 10th percentile is -19, the 95th -11.
  near(s.lra(), 8, 1e-6);
  for (let i = 0; i < ShortTermSeries.MAX + 10; i++) s.push(-14);
  assert.equal(s.length, ShortTermSeries.MAX);
  s.clear();
  assert.equal(s.length, 0);
  assert.equal(s.lra(), 0);
});

test('a hold stays where the peak landed, then falls, and never under what is there now', () => {
  const h = new PeakHold(-200, 1, 10);
  assert.equal(h.update(-6, 0.02), -6);
  // Held for its second.
  for (let i = 0; i < 49; i++) h.update(-30, 0.02);
  assert.equal(h.value, -6);
  // Then ten decibels a second.
  for (let i = 0; i < 50; i++) h.update(-30, 0.02);
  near(h.value, -15.8, 0.25);
  // A new peak takes over at once; the fall stops at the signal.
  assert.equal(h.update(-3, 0.02), -3);
  for (let i = 0; i < 500; i++) h.update(-12, 0.02);
  assert.equal(h.value, -12);
  h.reset();
  assert.equal(h.value, -200);
});

test('the sliding maximum forgets what has left its window', () => {
  const m = new SlidingMax(4, -200);
  assert.equal(m.push(-10), -10);
  assert.equal(m.push(-3), -3);
  assert.equal(m.push(-20), -3);
  assert.equal(m.push(-20), -3);
  assert.equal(m.push(-20), -3);
  assert.equal(m.push(-20), -20);
  m.reset();
  assert.equal(m.push(-50), -50);
});

test('an over is counted once, however long it lasts', () => {
  const c = new OverCounter();
  assert.equal(c.update(-1.2, -1), false);
  assert.equal(c.update(-0.97, -1), false, 'within the detector\'s own margin');
  assert.equal(c.update(-0.5, -1), true);
  assert.equal(c.update(-0.4, -1), true);
  assert.equal(c.count, 1);
  c.update(-2, -1);
  c.update(-0.2, -1);
  assert.equal(c.count, 2);
  c.reset();
  assert.equal(c.count, 0);
  assert.equal(c.over, false);
});

test('the frequency axis is even per octave and comes back to where it started', () => {
  assert.equal(hzToX(20), 0);
  near(hzToX(20000), 1, 1e-12);
  near(hzToX(200) - hzToX(100), hzToX(4000) - hzToX(2000), 1e-12);
  for (const f of [20, 63, 440, 1000, 9999, 20000]) near(xToHz(hzToX(f)), f, 1e-6);
});

test('the slope adds nothing at 1 kHz and 4.5 dB per octave either side', () => {
  assert.equal(slopeDb(1000), 0);
  near(slopeDb(2000), 4.5, 1e-12);
  near(slopeDb(250), -9, 1e-12);
  near(slopeDb(8000, 3), 9, 1e-12);
});

test('a tone lands in its band; bands narrower than the bins read between them', () => {
  const bins = 4096;                       // an 8192-point FFT at 48 kHz: 5.86 Hz a bin
  const binHz = FS / 2 / bins;
  const db = new Float32Array(bins).fill(-100);
  const toneBin = Math.round(1000 / binHz);
  db[toneBin] = -20;
  db[3] = -40;                             // 17.6 Hz
  db[4] = -60;                             // 23.4 Hz
  db[10] = -Infinity;                      // a silent bin
  const out = new Float32Array(100);
  spectrumBands(db, FS, out, -120);
  const bandOf = (hz: number) => Math.floor(hzToX(hz) * out.length);
  assert.equal(out[bandOf(toneBin * binHz)], -20);
  assert.equal(out[bandOf(3000)], -100);
  // The first band (20 to 21.4 Hz) holds no bin: read between 17.6 and 23.4 Hz.
  assert.ok(out[0] < -40 && out[0] > -60, `interpolated: ${out[0]}`);
  for (const v of out) assert.ok(Number.isFinite(v) && v >= -120);
  // No data at all reads as the floor.
  spectrumBands(new Float32Array(0), FS, out, -120);
  assert.ok(out.every((v) => v === -120));
});

test('note names, frequency text and the unlit display', () => {
  assert.equal(noteName(440), 'A4');
  assert.equal(noteName(261.63), 'C4');
  assert.equal(noteName(27.5), 'A0');
  assert.equal(noteName(1244.5), 'D#6');
  assert.equal(noteName(0), '');
  assert.equal(hzText(63.4), '63 HZ');
  assert.equal(hzText(1250), '1.25 KHZ');
  assert.equal(hzText(12500), '12.5 KHZ');
  assert.equal(levelText(-14.04), '-14.0');
  assert.equal(levelText(-70), '--.-');
  assert.equal(levelText(NaN), '--.-');
  assert.equal(levelText(-Infinity, -99), '--.-');
  assert.equal(timeTickStep(200, 4), 60);
  assert.equal(timeTickStep(30, 6), 5);
  assert.equal(timeTickStep(3600, 3), 1800);
});

// ── the book ──────────────────────────────────────────────────────────
const FRAME = 1024;

function frame(over: Partial<MeterFrame> = {}): MeterFrame {
  return {
    playhead: 0, playing: true, idle: false,
    momentary: -14, shortTerm: -14, integrated: -14,
    truePeakDb: -3, peakLDb: -3, peakRDb: -4,
    compGrDb: 0, limiterGrDb: 0, deharshGrDb: 0, clipGrDb: 0,
    correlation: 0.8, correlationLow: 0.9,
    ...over,
  };
}

/** Plays `sec` of frames into the book from `fromSec`; returns where the playhead ended up. */
function play(
  book: MeterBook, clock: { t: number }, fromSec: number, sec: number,
  over: (posSec: number) => Partial<MeterFrame> = () => ({}), ceilingDb = -1, keepStartSec = 0,
): number {
  let playhead = Math.round(fromSec * FS);
  const frames = Math.round((sec * FS) / FRAME);
  for (let i = 0; i < frames; i++) {
    playhead += FRAME;
    clock.t += FRAME / FS;
    book.frame(frame({ playhead, ...over(playhead / FS) }), { nowSec: clock.t, sampleRate: FS, ceilingDb, keepStartSec });
  }
  return playhead / FS;
}

function rest(book: MeterBook, clock: { t: number }, atSec: number, frames = 5): void {
  for (let i = 0; i < frames; i++) {
    clock.t += FRAME / FS;
    book.frame(frame({ playhead: Math.round(atSec * FS), playing: false, idle: true, truePeakDb: -200, peakLDb: -200, peakRDb: -200 }),
      { nowSec: clock.t, sampleRate: FS, ceilingDb: -1, keepStartSec: 0 });
  }
}

test('the book latches the loudest peak, counts overs, and reads the ratios', () => {
  const book = new MeterBook();
  const clock = { t: 100 };
  book.setSource(60);
  play(book, clock, 0, 4, (pos) => ({
    truePeakDb: pos > 1 && pos < 1.2 ? -0.3 : pos > 2 && pos < 2.1 ? -0.6 : -3,
    integrated: -13,
  }));
  near(book.tpMax, -0.3, 1e-9);
  assert.equal(book.overs.count, 2);
  near(book.plr, -0.3 - -13, 1e-9);
  // The last 3 s still hold both overs' peaks: -0.3 over a short-term of -14.
  near(book.psr, -0.3 - -14, 1e-6);
  play(book, clock, 4, 3.5);
  near(book.psr, -3 - -14, 1e-6, 'three seconds on, only the plain peaks are left');
  near(book.tpMax, -0.3, 1e-9, 'the latch is for the whole pass');
});

test('idle frames move nothing: the meters rest where they were', () => {
  const book = new MeterBook();
  const clock = { t: 0 };
  book.setSource(60);
  const at = play(book, clock, 10, 2, () => ({ limiterGrDb: 4 }));
  const before = { tp: book.tpMax, hold: book.holdL.value, gr: book.holdLimit.value, v: book.version };
  rest(book, clock, at, 200);
  assert.deepEqual({ tp: book.tpMax, hold: book.holdL.value, gr: book.holdLimit.value, v: book.version }, before);
});

test('playback from the top is a new pass; a resume mid-track carries on', () => {
  const book = new MeterBook();
  const clock = { t: 0 };
  book.setSource(60);
  let at = play(book, clock, 0, 2, () => ({ truePeakDb: -0.2 }));
  assert.equal(book.overs.count, 1);
  // Pause, then resume where it stopped.
  rest(book, clock, at);
  at = play(book, clock, at, 1);
  near(book.tpMax, -0.2, 1e-9);
  assert.equal(book.overs.count, 1);
  // Stop (back to the top), then play.
  rest(book, clock, 0);
  play(book, clock, 0, 1);
  near(book.tpMax, -3, 1e-9);
  assert.equal(book.overs.count, 0);
  // With a trim, the top is where the trim starts.
  play(book, clock, 20, 1, () => ({ truePeakDb: -0.1 }), -1, 20);
  rest(book, clock, 20);
  play(book, clock, 20, 1, () => ({}), -1, 20);
  near(book.tpMax, -3, 1e-9);
});

test('the running range waits for five seconds of music, and a peak reset leaves it be', () => {
  const book = new MeterBook();
  const clock = { t: 0 };
  book.setSource(120);
  play(book, clock, 0, 3, (pos) => ({ shortTerm: pos < 1.5 ? -20 : -12 }));
  assert.ok(Number.isNaN(book.lra));
  play(book, clock, 3, 9, (pos) => ({ shortTerm: Math.floor(pos) % 2 ? -20 : -12 }));
  assert.ok(book.lra > 7 && book.lra <= 8, `range of a -20/-12 alternation: ${book.lra}`);
  const lra = book.lra;
  book.resetPeaks();
  assert.equal(book.lra, lra);
  assert.equal(book.tpMax, -Infinity);
  assert.ok(Number.isNaN(book.plr));
});

test('the history is written where the playhead is, and a new track clears it', () => {
  const book = new MeterBook();
  const clock = { t: 0 };
  book.setSource(30);
  assert.equal(book.st.length, 30 / HISTORY_STEP_SEC);
  assert.ok(book.st.every((v) => Number.isNaN(v)));
  play(book, clock, 10, 2, (pos) => ({ shortTerm: -15, momentary: pos < 11 ? -9 : -13 }));
  const bin = (sec: number) => Math.floor(sec / HISTORY_STEP_SEC);
  near(book.st[bin(10.5)], -15, 1e-6);
  near(book.mom[bin(10.5)], -9, 1e-6);
  near(book.mom[bin(11.5)], -13, 1e-6);
  assert.ok(Number.isNaN(book.st[bin(5)]) && Number.isNaN(book.st[bin(20)]), 'only what was played');
  // Silence leaves a gap rather than a floor.
  play(book, clock, 20, 1, () => ({ shortTerm: -120, momentary: -120 }));
  assert.ok(Number.isNaN(book.st[bin(20.5)]));
  // A playhead past the end writes nowhere.
  play(book, clock, 40, 1);
  const v = book.version;
  book.setSource(12);
  assert.equal(book.st.length, 12 / HISTORY_STEP_SEC);
  assert.ok(book.st.every((x) => Number.isNaN(x)));
  assert.ok(book.version > v);
  assert.equal(book.tpMax, -Infinity);
});

test('bass that sits out of phase is called out, and the call is withdrawn when it comes back', () => {
  const book = new MeterBook();
  const clock = { t: 0 };
  book.setSource(60);
  play(book, clock, 0, 0.2, () => ({ correlationLow: -0.4 }));
  assert.equal(book.lowPhaseWarn, false, 'a blip is not a warning');
  play(book, clock, 0.2, 0.6, () => ({ correlationLow: -0.4 }));
  assert.equal(book.lowPhaseWarn, true);
  play(book, clock, 0.8, 1.5, () => ({ correlationLow: 0.9 }));
  assert.equal(book.lowPhaseWarn, false);
});

test('gain reduction holds its deepest moment for a beat', () => {
  const book = new MeterBook();
  const clock = { t: 0 };
  book.setSource(60);
  play(book, clock, 0, 0.5, (pos) => ({ limiterGrDb: pos < 0.1 ? 5 : 1, clipGrDb: 2, compGrDb: 0 }));
  assert.equal(book.holdLimit.value, 5);
  assert.equal(book.holdClip.value, 2);
  assert.equal(book.holdComp.value, 0);
  play(book, clock, 0.5, 3, () => ({ limiterGrDb: 1 }));
  assert.equal(book.holdLimit.value, 1);
});
