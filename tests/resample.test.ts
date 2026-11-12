import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resample, planResample, resampledLength, RESAMPLE_STOP_DB } from '../src/audio/dsp/resample';
import { sine, toneDb, whiteNoise, nullDb, rmsDb } from './lib/signals';

const within = (v: number, lo: number, hi: number, what: string) =>
  assert.ok(v >= lo && v <= hi, `${what}: ${v.toFixed(4)} not in [${lo}, ${hi}]`);

for (const [inRate, outRate] of [[44100, 48000], [48000, 44100], [96000, 48000], [88200, 48000]] as const) {
  test(`${inRate} → ${outRate}: flat to 20 kHz`, () => {
    for (const f of [50, 1000, 10000, 16000, 18000, 20000]) {
      const y = resample(sine(f, 0.5, inRate, -6), inRate, outRate);
      const edge = Math.round(0.05 * outRate);
      const db = toneDb(y, f, outRate, edge, y.length - edge);
      within(db, -6.01, -5.99, `${f} Hz level`);
    }
  });
}

test('44.1 → 48: images of the passband are gone', () => {
  // A 10 kHz tone's first image sits at 34.1 kHz, which a 48 kHz stream
  // would fold to 13.9 kHz.
  const y = resample(sine(10000, 1, 44100, -6), 44100, 48000);
  const edge = 4800;
  const tone = toneDb(y, 10000, 48000, edge, y.length - edge);
  const image = toneDb(y, 13900, 48000, edge, y.length - edge);
  assert.ok(image - tone < -(RESAMPLE_STOP_DB - 10), `image at ${(image - tone).toFixed(1)} dB`);
});

test('96 → 44.1: ultrasonics do not fold into the audio band', () => {
  // 30 kHz would land on 14.1 kHz.
  const y = resample(sine(30000, 1, 96000, -6), 96000, 44100);
  const edge = 4410;
  const alias = toneDb(y, 14100, 44100, edge, y.length - edge);
  assert.ok(alias < -6 - (RESAMPLE_STOP_DB - 10), `alias at ${alias.toFixed(1)} dBFS`);
  assert.ok(rmsDb(y, edge, y.length - edge) < -120, 'nothing else comes through either');
});

test('44.1 → 48 → 44.1 returns the signal', () => {
  // Band-limited to 18 kHz so both trips stay inside the passband.
  const x = resample(resample(whiteNoise(1, 44100, -6, 3), 44100, 14000), 14000, 44100);
  const back = resample(resample(x, 44100, 48000), 48000, 44100);
  assert.equal(back.length, x.length);
  const edge = 4410;
  const depth = nullDb(x, back, edge, x.length - edge);
  assert.ok(depth < -110, `round trip nulls to ${depth.toFixed(1)} dB`);
});

test('no delay, same duration', () => {
  const x = new Float32Array(44100);
  x[22050] = 1;
  const y = resample(x, 44100, 48000);
  assert.equal(y.length, 48000);
  let at = 0;
  for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[at])) at = i;
  assert.equal(at, 24000);
  assert.equal(resampledLength(13230000, 44100, 48000), 14400000);
});

test('a rate with no small ratio still converts cleanly', () => {
  // 44056 Hz (an old NTSC-locked rate): too many phases to tabulate, so
  // the filter interpolates between phases.
  assert.equal(planResample(44056, 48000).exact, false);
  const y = resample(sine(1000, 0.5, 44056, -6), 44056, 48000);
  const edge = 2400;
  const tone = toneDb(y, 1000, 48000, edge, y.length - edge);
  within(tone, -6.01, -5.99, '1 kHz level');
  let resid = 0;
  const w = (2 * Math.PI * 1000) / 48000;
  // Everything that isn't the tone.
  let re = 0, im = 0;
  for (let i = edge; i < y.length - edge; i++) { re += y[i] * Math.cos(w * i); im += y[i] * Math.sin(w * i); }
  const n = y.length - 2 * edge;
  const a = (2 * re) / n, b = (2 * im) / n;
  for (let i = edge; i < y.length - edge; i++) {
    const d = y[i] - a * Math.cos(w * i) - b * Math.sin(w * i);
    resid += d * d;
  }
  const residDb = 10 * Math.log10(resid / n);
  assert.ok(residDb < -100, `residual ${residDb.toFixed(1)} dBFS`);
});

test('same rate is a copy', () => {
  const x = whiteNoise(0.1, 48000, -6, 9);
  const y = resample(x, 48000, 48000);
  assert.notEqual(y, x);
  assert.deepEqual(y, x);
});
