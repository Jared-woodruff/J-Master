// The master's spec sheet: one self-contained page that says what was measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/lib/report';
import { defaultAdvEq } from '../src/audio/dsp/params';
import { NO_CORRECTIONS, NEUTRAL_MACROS } from '../src/state/console';

function lastExport(over: Record<string, unknown> = {}, stats: Record<string, unknown> = {}): any {
  return {
    fileName: 'song - Master 48k24.wav', dir: 'C:\\out', title: 'Song <One> & "Two"', sourceName: 'song.wav',
    when: '2026-11-12T03:04:05.000Z',
    stats: {
      integratedLufs: -14.02, truePeakDb: -1.0, samplePeakDb: -1.3, appliedGainDb: 4.5, limiterMaxGrDb: 4.8,
      clipMaxGrDb: 0, loudnessMeasured: true, targetReached: true, targetLufs: -14, ceilingDb: -1,
      lra: 5.4, plr: 13.0, maxMomentary: -9.8, maxShortTerm: -11.2, durationSec: 78.5, sampleRate: 48000,
      bitDepth: 24, format: 'wav', bytes: 22_600_000, ...stats,
    },
    report: {
      wave: { mins: Array.from({ length: 400 }, (_, i) => -Math.abs(Math.sin(i / 20)) * 0.8), maxs: Array.from({ length: 400 }, (_, i) => Math.abs(Math.sin(i / 20)) * 0.8) },
      lane: Array.from({ length: 150 }, (_, i) => (i < 3 ? -80 : -14 + Math.sin(i / 9) * 2)), laneStepSec: 0.5,
    },
    console: {
      ...NO_CORRECTIONS, macros: { ...NEUTRAL_MACROS, tone: 0.2, width: 1.15 }, targetLufs: -14, ceilingDb: -1,
      presetId: 'rock', lastPresetId: 'rock', presetAmount: 0.75, platformId: 'spotify', clipMode: 'off',
      advEq: defaultAdvEq(), stems: { bass: 0, drums: 0, vocal: 0, air: 0 },
    },
    presetName: 'ROCK',
    source: { lufs: -18.4, truePeakDb: -0.7, lra: 6.0, sampleRate: 44100, bitDepth: 16, durationSec: 78.5 },
    tempoBpm: 110.01, repaired: false,
    meta: { artist: 'Artist', album: 'Album', year: '2026', genre: 'Rock', catalog: 'JW-001', comment: '' },
    ...over,
  };
}

test('report: a whole page, with the figures that were measured', () => {
  const html = buildReport(lastExport());
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.trimEnd().endsWith('</html>'));
  for (const s of ['-14.0', '-1.00', 'ROCK AT 75%', 'ALL CHECKS CLEAR', 'ON TARGET', 'WAV · 48 kHz · 24-BIT', 'SPOTIFY', 'JW-001', '110.0 BPM']) {
    assert.ok(html.includes(s), `missing ${s}`);
  }
  // Two plots: the waveform and the loudness lane.
  assert.equal(html.match(/<svg /g)?.length, 2);
  // Nothing loads from anywhere, and nothing runs.
  assert.ok(!/<script|https?:\/\/|<link|@import|url\(/i.test(html));
});

test('report: names are escaped, never markup', () => {
  const html = buildReport(lastExport());
  assert.ok(html.includes('Song &lt;One&gt; &amp; &quot;Two&quot;'));
  assert.ok(!html.includes('<One>'));
});

test('report: what went wrong is said, and counted', () => {
  const short = buildReport(lastExport({}, { targetReached: false, integratedLufs: -10.8, targetLufs: -8 }));
  assert.ok(short.includes('2.8 LU SHORT OF -8.0'));
  assert.ok(short.includes('1 TO LOOK AT'));
  const lossy = buildReport(lastExport({}, { format: 'mp3', mp3Kbps: 320, codecPeakDb: -0.4 }));
  assert.ok(lossy.includes('MP3 DECODED'));
  assert.ok(lossy.includes('THE CODEC OVERSHOOTS BY 0.6 dB'));
  const quiet = buildReport(lastExport({}, { loudnessMeasured: false }));
  assert.ok(quiet.includes('TOO QUIET TO MEASURE'));
});

test('report: corrections and the chain are listed as they were', () => {
  const c = lastExport().console;
  const html = buildReport(lastExport({
    repaired: true,
    console: {
      ...c, clipMode: 'soft', bassMono: true, balanceDb: -1.2, sourceFix: 'flip', airRestore: 0.4, airRestoreHz: 16000,
      trimStartSec: 2, trimEndSec: 70, fadeInSec: 0.01, fadeOutSec: 4,
      advEq: c.advEq.map((b: any, i: number) => (i === 2 ? { ...b, gainDb: -2.5, ch: 'side' } : i === 0 ? { ...b, type: 'highpass', freq: 30 } : b)),
      stems: { bass: 1.5, drums: 0, vocal: -0.5, air: 0 },
    },
  }, { clipMaxGrDb: 3.1 }));
  for (const s of ['DRIFT REPAIRED', 'CLIP · SOFT', '3.1 dB OFF THE TALLEST PEAK', 'MONO BELOW 140 Hz', '-1.2 dB TOWARD LEFT',
    'POLARITY FLIPPED BACK', '40% ABOVE 16 kHz', '0:02 TO 1:10 OF 1:19', '10 MS', '4.0 S', 'HIGH-PASS 30 Hz', 'BELL 800 Hz -2.5 dB', 'SIDE ONLY', 'BASS +1.5', 'VOCAL -0.5']) {
    assert.ok(html.includes(s), `missing ${s}`);
  }
});

test('report: no plots without a render to draw, and still a page', () => {
  const html = buildReport(lastExport({ report: null }));
  assert.ok(!html.includes('<svg '));
  assert.ok(html.includes('Source to master'));
});
