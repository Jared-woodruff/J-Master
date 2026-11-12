// The real-time processor, driven block by block the way the audio thread
// drives it, with the worklet's globals stood in.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { defaultParams, ChainParams } from '../src/audio/dsp/params';
import { FS, sine } from './lib/signals';

interface Proc {
  port: { onmessage: ((e: { data: unknown }) => void) | null; sent: any[] };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
let Processor: new () => Proc;

before(async () => {
  const g = globalThis as any;
  g.sampleRate = FS;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null, sent: [] as any[], postMessage(m: any) { this.sent.push(m); } };
  };
  g.registerProcessor = (_name: string, ctor: new () => Proc) => { Processor = ctor; };
  await import('../src/audio/worklet/processor');
});

class Rig {
  proc = new Processor();
  out: number[] = [];
  outR: number[] = [];
  send(msg: Record<string, unknown>) { this.proc.port.onmessage!({ data: msg }); }
  load(l: Float32Array, r = new Float32Array(l)) {
    this.send({ type: 'load', l: l.buffer.slice(0), r: r.buffer.slice(0) });
  }
  params(p: Partial<ChainParams> = {}) {
    this.send({ type: 'params', params: { ...defaultParams(), outputGainDb: 0, refOutputGainDb: 0, ...p } });
  }
  /** Runs `sec` seconds of audio callbacks. */
  run(sec: number) {
    const blocks = Math.ceil((sec * FS) / 128);
    for (let b = 0; b < blocks; b++) {
      const l = new Float32Array(128), r = new Float32Array(128);
      this.proc.process([], [[l, r], [new Float32Array(128), new Float32Array(128)]]);
      for (let i = 0; i < 128; i++) { this.out.push(l[i]); this.outR.push(r[i]); }
    }
  }
  ended() { return this.proc.port.sent.some((m) => m.type === 'ended'); }
  lastMeters() { return [...this.proc.port.sent].reverse().find((m) => m.type === 'meters'); }
}

/** Sample indices where sound starts after at least `gapMs` of silence. */
function onsets(x: number[], gapMs = 5): number[] {
  const gap = (gapMs * FS) / 1000;
  const found: number[] = [];
  let quiet = gap;
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== 0) { if (quiet >= gap) found.push(i); quiet = 0; } else quiet++;
  }
  return found;
}

test('metronome: every beat clicks, on the beat, through block edges', () => {
  for (const [bpm, firstBeat] of [[128, 0.1234], [127.98, 0], [93, 0.2071]] as const) {
    const rig = new Rig();
    rig.load(new Float32Array(FS * 62));
    rig.params({ metronome: true, gridBpm: bpm, gridFirstBeatSec: firstBeat });
    rig.send({ type: 'play' });
    rig.run(60);
    const clicks = onsets(rig.out);
    const period = (60 / bpm) * FS;
    const lat = clicks[0] - firstBeat * FS;      // the chain's delay: every click waits it out
    assert.ok(lat >= 0 && lat < 0.01 * FS, `first click ${lat.toFixed(1)} samples after its beat`);
    const expected = Math.floor((60 * FS - 128 - lat - firstBeat * FS) / period) + 1;
    assert.ok(Math.abs(clicks.length - expected) <= 1, `${bpm} BPM: ${clicks.length} clicks for ${expected} beats`);
    let worst = 0;
    clicks.forEach((c, k) => { worst = Math.max(worst, Math.abs(c - (firstBeat * FS + k * period + lat))); });
    assert.ok(worst <= 1, `${bpm} BPM: a click ${worst.toFixed(2)} samples off its beat`);
  }
});

test('metronome: a loop clicks its first beat on every lap', () => {
  const rig = new Rig();
  rig.load(new Float32Array(FS * 20));
  const bpm = 93, firstBeat = 0.2071, period = (60 / bpm) * FS;
  rig.params({ metronome: true, gridBpm: bpm, gridFirstBeatSec: firstBeat });
  // Four beats, starting on beat 4.
  const start = firstBeat * FS + 4 * period, end = start + 4 * period;
  rig.send({ type: 'loop', start, end });
  rig.send({ type: 'seek', sample: start });
  rig.send({ type: 'play' });
  rig.run(4 * (4 * period) / FS);
  const clicks = onsets(rig.out);
  assert.ok(clicks.length >= 15 && clicks.length <= 17, `${clicks.length} clicks over four laps of four beats`);
});

test('seek: nothing of the place just left is heard', () => {
  const rig = new Rig();
  const src = new Float32Array(FS * 4);
  src.set(sine(440, 1, FS, -6));               // a tone for one second, then silence
  rig.load(src);
  rig.params();
  rig.send({ type: 'play' });
  rig.run(0.5);
  assert.ok(Math.max(...rig.out.slice(-2000).map(Math.abs)) > 0.1, 'the tone is playing');
  rig.send({ type: 'pause' });
  rig.send({ type: 'seek', sample: 2 * FS });   // into the silence
  rig.out = [];
  rig.send({ type: 'play' });
  rig.run(0.2);
  assert.equal(Math.max(...rig.out.map(Math.abs)), 0);
});

test('seek: the sound comes up without a step', () => {
  const rig = new Rig();
  rig.load(sine(100, 4, FS, -6, Math.PI / 2));  // seeks land on a crest
  rig.params();
  rig.send({ type: 'seek', sample: FS });
  rig.send({ type: 'play' });
  rig.run(0.1);
  let step = 0;
  for (let i = 1; i < rig.out.length; i++) step = Math.max(step, Math.abs(rig.out[i] - rig.out[i - 1]));
  // A 100 Hz tone at −6 dBFS moves at most 0.0066 per sample; cutting in on its crest would step by 0.5.
  assert.ok(step < 0.02, `largest step ${step.toFixed(4)}`);
});

test('the end: the last samples play out before the transport stops', () => {
  const rig = new Rig();
  const src = new Float32Array(FS);
  for (let i = 0; i < 10; i++) src[FS - 20 + i] = 0.5 * Math.sin((i / 10) * Math.PI);   // a marker in the last 20 samples
  rig.load(src);
  rig.params();
  rig.send({ type: 'play' });
  rig.run(1.05);
  assert.ok(rig.ended(), 'ended was posted');
  const tail = rig.out.slice(FS - 20);
  assert.ok(Math.max(...tail.map(Math.abs)) > 0.4, 'the marker was heard');
  // Space at the end starts over.
  rig.out = [];
  rig.send({ type: 'play' });
  rig.run(0.05);
  assert.equal(rig.lastMeters().playing, true);
  assert.ok(rig.lastMeters().playhead > 0 && rig.lastMeters().playhead < 0.1 * FS, 'playing from the top again');
  assert.equal(Math.max(...rig.out.map(Math.abs)), 0, 'and none of the old tail with it');
});

test('trim: playback starts and ends with the kept part', () => {
  const rig = new Rig();
  rig.load(sine(440, 4, FS, -12));
  rig.params({ trimStartSec: 1, trimEndSec: 2, songLengthSec: 4 });
  rig.send({ type: 'play' });
  rig.run(0.05);
  assert.ok(Math.abs(rig.lastMeters().playhead - 1.05 * FS) < 1200, `starts at the trim (${rig.lastMeters().playhead})`);
  rig.run(1.1);
  assert.ok(rig.ended());
  assert.equal(rig.lastMeters().playhead, 2 * FS);
});

test('params set while stopped are in place when play starts', () => {
  const rig = new Rig();
  rig.load(sine(1000, 2, FS, -20));
  rig.params({ outputGainDb: 0 });
  rig.params({ outputGainDb: -18 });
  rig.send({ type: 'play' });
  rig.run(0.05);
  // Past the declick rise, the tone sits at its new level at once (no glide from the old one).
  const peak = Math.max(...rig.out.slice(1200, 2400).map(Math.abs));
  assert.ok(Math.abs(20 * Math.log10(peak) + 38) < 0.3, `level ${(20 * Math.log10(peak)).toFixed(2)} dBFS`);
});

test('meters: gain reduction reports the deepest block of the frame, and a NaN seek is ignored', () => {
  const rig = new Rig();
  rig.load(sine(200, 2, FS, 0));
  rig.params({ outputGainDb: 12, ceilingDb: -1 });
  rig.send({ type: 'play' });
  rig.run(0.5);
  const m = rig.lastMeters();
  assert.ok(m.limiterGrDb > 11, `limiter GR ${m.limiterGrDb.toFixed(1)} dB`);
  assert.ok(m.truePeakDb <= -0.9 && m.truePeakDb > -1.3, `true peak ${m.truePeakDb.toFixed(2)}`);
  assert.ok(Math.abs(m.correlation - 1) < 0.01 && Math.abs(m.correlationLow - 1) < 0.01);
  rig.send({ type: 'seek', sample: NaN });
  rig.run(0.05);
  assert.ok(Number.isFinite(rig.lastMeters().playhead));
});
