// The waveform's arithmetic: time text that carries, ruler ticks that
// don't drift, bar.beat on both kinds of grid, snapping and following.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lowerBound, timecode, spanText, rulerStep, rulerTicks, rulerLabel, barBeatAt, nearestBeat, snapTo,
  clampRange, followStart, revealStart, specFreqAt, freqText, type GridTempo,
} from '../src/lib/wave-math';

test('timecode carries seconds into minutes', () => {
  assert.equal(timecode(0), '0:00');
  assert.equal(timecode(59.4), '0:59');
  assert.equal(timecode(59.6), '1:00');
  assert.equal(timecode(59.96, 1), '1:00.0', 'never 0:60.0');
  assert.equal(timecode(119.999, 2), '2:00.00');
  assert.equal(timecode(0.5, 1), '0:00.5');
  assert.equal(timecode(65.25, 2), '1:05.25');
  assert.equal(timecode(3725.04, 1), '62:05.0');
  assert.equal(timecode(-3, 1), '0:00.0');
  assert.equal(timecode(NaN, 1), '0:00.0');
});

test('spans read in the unit that suits them', () => {
  assert.equal(spanText(0.05), '50 MS');
  assert.equal(spanText(0.9996), '1.0 S');
  assert.equal(spanText(7.84), '7.8 S');
  assert.equal(spanText(125), '2:05');
});

test('ruler steps get finer as the view narrows, and labels match the step', () => {
  assert.equal(rulerStep(240), 30);
  assert.equal(rulerStep(240, 24), 10);
  assert.equal(rulerStep(6), 0.5);
  assert.equal(rulerStep(2), 0.2);
  assert.equal(rulerStep(1), 0.1);
  assert.equal(rulerStep(100000), 3600);
  assert.equal(rulerLabel(0.5, 0.5), '0:00.5');
  assert.equal(rulerLabel(61.5, 0.5), '1:01.5');
  assert.equal(rulerLabel(90, 30), '1:30');
});

test('ruler ticks are whole multiples of the step, however many there are', () => {
  assert.deepEqual(rulerTicks(0, 1, 0.5), [0, 0.5, 1]);
  assert.deepEqual(rulerTicks(0.25, 0.75, 0.1), [0.3, 0.4, 0.5, 0.6, 0.7]);
  const many = rulerTicks(100, 130, 0.1);
  assert.equal(many.length, 301);
  assert.equal(many[300], 130);
  assert.equal(many[157], 115.7, 'no accumulated error');
  assert.deepEqual(rulerTicks(-5, 4, 2), [0, 2, 4]);
  assert.deepEqual(rulerTicks(10, 5, 1), []);
  assert.deepEqual(rulerTicks(0, 10, 0), []);
});

const steady: GridTempo = { bpm: 120, firstBeatSec: 0.25, firstBarSec: 1.25, beats: [], downbeat: 0, drift: null };

test('bar.beat on a fixed grid counts from the first bar line', () => {
  assert.equal(barBeatAt(0.5, steady), null, 'the pick-up has no bar yet');
  assert.deepEqual(barBeatAt(1.25, steady), { bar: 1, beat: 1 });
  assert.deepEqual(barBeatAt(1.74, steady), { bar: 1, beat: 1 });
  assert.deepEqual(barBeatAt(1.75, steady), { bar: 1, beat: 2 });
  assert.deepEqual(barBeatAt(3.25, steady), { bar: 2, beat: 1 });
  assert.deepEqual(barBeatAt(1.25 + 2 * 37 + 1.6, steady), { bar: 38, beat: 4 });
  assert.equal(barBeatAt(10, { ...steady, bpm: 0 }), null);
});

// A tempo that speeds up: beats 0.5 s apart, then 0.4 s; the bar line is the third beat.
const beats = [1, 1.5, 2, 2.5, 3, 3.4, 3.8, 4.2, 4.6, 5];
const drifting: GridTempo = { bpm: 130, firstBeatSec: 1, firstBarSec: 2, beats, downbeat: 2, drift: {} };

test('bar.beat on a drifting grid follows the tracked beats', () => {
  assert.equal(barBeatAt(0.9, drifting), null);
  assert.equal(barBeatAt(1.6, drifting), null, 'before the first bar line');
  assert.deepEqual(barBeatAt(2, drifting), { bar: 1, beat: 1 });
  assert.deepEqual(barBeatAt(3.39, drifting), { bar: 1, beat: 3 });
  assert.deepEqual(barBeatAt(3.4, drifting), { bar: 1, beat: 4 });
  assert.deepEqual(barBeatAt(3.8, drifting), { bar: 2, beat: 1 });
  assert.deepEqual(barBeatAt(5.1, drifting), { bar: 2, beat: 4 });
  // Past the last tracked beat the last interval (0.4 s) carries on.
  assert.deepEqual(barBeatAt(5.45, drifting), { bar: 3, beat: 1 });
  assert.deepEqual(barBeatAt(6.25, drifting), { bar: 3, beat: 3 });
});

test('the nearest beat is on the grid that is drawn', () => {
  assert.equal(nearestBeat(1.9, steady), 1.75);
  assert.equal(nearestBeat(2.1, steady), 2.25);
  assert.equal(nearestBeat(0.2, steady), 1.25, 'nothing is drawn before the first bar');
  assert.equal(nearestBeat(3.55, drifting), 3.4);
  assert.equal(nearestBeat(3.65, drifting), 3.8);
  assert.equal(nearestBeat(0, drifting), 1);
  assert.equal(nearestBeat(99, drifting), 5);
  assert.equal(nearestBeat(3, { ...steady, bpm: 0 }), null);
});

test('snapping takes the nearest candidate in reach, or none', () => {
  assert.equal(snapTo(10.04, [10, 12], 0.05), 10);
  assert.equal(snapTo(10.06, [10, 12], 0.05), 10.06);
  assert.equal(snapTo(11, [10, 11.4, 10.8, null, undefined, NaN], 0.5), 10.8);
  assert.equal(snapTo(5, [], 1), 5);
});

test('lowerBound finds the first value at or after', () => {
  assert.equal(lowerBound([1, 2, 3], 0), 0);
  assert.equal(lowerBound([1, 2, 3], 2), 1);
  assert.equal(lowerBound([1, 2, 3], 2.5), 2);
  assert.equal(lowerBound([1, 2, 3], 9), 3);
  assert.equal(lowerBound([], 1), 0);
});

test('a view stays inside the track and never shorter than the closest zoom', () => {
  assert.deepEqual(clampRange(-5, 20, 100, 2), { start: 0, end: 25 });
  assert.deepEqual(clampRange(90, 130, 100, 2), { start: 60, end: 100 });
  assert.deepEqual(clampRange(10, 10.5, 100, 2), { start: 10, end: 12 });
  assert.deepEqual(clampRange(-50, 500, 100, 2), { start: 0, end: 100 });
  assert.deepEqual(clampRange(0, 1, 1.5, 4), { start: 0, end: 1.5 }, 'a track shorter than the closest zoom shows whole');
});

test('following turns the page at the right edge and jumps back for a loop', () => {
  const view = { start: 40, end: 60 };
  assert.equal(followStart(view, 50, 200), null);
  assert.equal(followStart(view, 59.7, 200), 59.7 - 2);
  assert.equal(followStart(view, 30, 200), 28);
  assert.equal(followStart({ start: 180, end: 200 }, 199.9, 200), null, 'nothing to turn to at the end');
  assert.equal(followStart({ start: 0, end: 200 }, 199.9, 200), null, 'the whole track is in view');
});

test('a seek off screen is brought into view; one on screen moves nothing', () => {
  const view = { start: 40, end: 60 };
  assert.equal(revealStart(view, 45, 200), null);
  assert.equal(revealStart(view, 65, 200), 63);
  assert.equal(revealStart(view, 35, 200), 25);
  assert.equal(revealStart({ start: 0, end: 200 }, 500, 200), null);
});

test('the spectrogram axis reads in hertz', () => {
  assert.equal(Math.round(specFreqAt(0)), 20);
  assert.equal(Math.round(specFreqAt(1)), 20000);
  assert.ok(Math.abs(specFreqAt(1 / 3) - 200) < 1e-6);
  assert.equal(freqText(86.4), '86 HZ');
  assert.equal(freqText(2440), '2.4 KHZ');
  assert.equal(freqText(12300), '12 KHZ');
});
