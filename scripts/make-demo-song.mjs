// Generates the demo track used for the README media: a 110 BPM synthwave
// cue of about 80 s in clean 8-bar sections (intro, drop, breakdown, drop,
// outro) with a deliberately wide stereo image, so the waveform, section
// markers, meters and vectorscope all have something to show.
// Deterministic: the same bytes on every run.
//
// This is not the test fixture. scripts/make-test-song.mjs stays the track
// the verification numbers in the README were measured on.
//
// Usage: node scripts/make-demo-song.mjs [out.wav]
import { writeFileSync } from 'node:fs';

const SR = 44100;
const BPM = 110;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
const BARS = 36;
const DUR = BARS * BAR + 0.25;
const N = Math.ceil(DUR * SR);
const L = new Float64Array(N);
const R = new Float64Array(N);
const SEND = new Float64Array(N); // mono reverb send

// Arrangement, in bars.
const DROP1 = 8, BREAK = 16, DROP2 = 24, OUTRO = 32;
const inDrop = (bar) => (bar >= DROP1 && bar < BREAK) || (bar >= DROP2 && bar < OUTRO);
// The last two bars before each drop lift: hats come in, the filter opens.
const lifting = (bar) => (bar >= DROP1 - 2 && bar < DROP1) || (bar >= DROP2 - 2 && bar < DROP2);
// Half-beat stops on the quiet side of each change (before a drop, after
// one ends), with only the echoes and reverb sounding. Besides being the
// classic move, they pin every section change to its bar line.
const GAP = BEAT / 2;
const STOPS = [[DROP1 * BAR - GAP, DROP1 * BAR], [DROP2 * BAR - GAP, DROP2 * BAR],
  [BREAK * BAR, BREAK * BAR + GAP], [OUTRO * BAR, OUTRO * BAR + GAP]];
const END = BARS * BAR;
function play(t) {
  const ramp = 0.005;
  let g = Math.min(1, t / ramp, Math.max(0, (END - t) / BEAT));
  for (const [a, b] of STOPS) {
    if (t > a - ramp && t < b + ramp) g = Math.min(g, Math.max(0, (a - t) / ramp, (t - b) / ramp));
  }
  return g;
}
const stopped = (t) => STOPS.some(([a, b]) => t >= a && t < b);

let seed = 0x2545f491;
const rand = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return ((seed >>> 0) / 4294967296) * 2 - 1;
};
const hz = (semisFromA4) => 440 * 2 ** (semisFromA4 / 12);

// Piecewise-linear automation over bars; `log` interpolates in log space.
function lane(points, log = false) {
  return (bar) => {
    if (bar <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      const [b1, v1] = points[i];
      if (bar <= b1) {
        const [b0, v0] = points[i - 1];
        const u = (bar - b0) / (b1 - b0);
        return log ? Math.exp(Math.log(v0) + u * (Math.log(v1) - Math.log(v0))) : v0 + u * (v1 - v0);
      }
    }
    return points[points.length - 1][1];
  };
}

// Zavalishin state-variable filter; stable under per-sample cutoff moves.
function svf() {
  let ic1 = 0, ic2 = 0;
  return (x, f, q, mode) => {
    const g = Math.tan((Math.PI * Math.min(f, SR * 0.45)) / SR);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    return mode === 'bp' ? v1 : mode === 'hp' ? x - k * v1 - v2 : v2;
  };
}

// Band-limited saw (polyBLEP) on a phase accumulator in cycles.
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
function saw() {
  let ph = rand() * 0.5 + 0.5;
  return (f) => {
    const dt = f / SR;
    ph += dt; if (ph >= 1) ph -= 1;
    return 2 * ph - 1 - blep(ph, dt);
  };
}

// Fm7, Dbmaj7, Abmaj7, Eb(add9): one chord per bar. Semitones from A4.
const CHORDS = [
  { root: -28, notes: [-16, -13, -9, -6] },
  { root: -32, notes: [-20, -16, -13, -9] },
  { root: -37, notes: [-13, -9, -6, -2] },
  { root: -30, notes: [-18, -14, -11, -4] },
];
const chordAt = (bar) => CHORDS[Math.floor(bar) % 4];

// Kick-driven pump for the drops.
const duck = (t, bar) => (inDrop(bar) ? 1 - 0.55 * Math.exp(-(t % BEAT) / 0.11) : 1);

// ── pads: three detuned saws per chord tone, spread across the field ──
{
  const voices = [];
  for (let n = 0; n < 4; n++) {
    for (const [det, pan] of [[-0.09, -1], [0, 0.25 * (n % 2 ? 1 : -1)], [0.09, 1]]) {
      voices.push({ n, det, osc: saw(), gl: Math.sqrt((1 - pan) / 2), gr: Math.sqrt((1 + pan) / 2) });
    }
  }
  const fl = svf(), fr = svf();
  const cutoff = lane([[0, 600], [DROP1 - 2, 900], [DROP1, 3200], [DROP1 + 0.01, 5200], [BREAK, 5200], [BREAK + 0.01, 1300],
    [DROP2 - 2, 1500], [DROP2, 3400], [DROP2 + 0.01, 5600], [OUTRO, 5600], [OUTRO + 0.01, 2400], [BARS, 400]], true);
  const gain = lane([[0, 0.85], [DROP1, 0.9], [BREAK, 1], [DROP2, 0.9], [OUTRO, 0.9]]);
  for (let i = 0; i < N; i++) {
    const t = i / SR, bar = t / BAR;
    const ch = chordAt(Math.min(bar, BARS - 0.001));
    let l = 0, r = 0;
    for (const v of voices) {
      const s = v.osc(hz(ch.notes[v.n] + v.det));
      l += s * v.gl; r += s * v.gr;
    }
    const g = 0.045 * gain(bar) * duck(t, bar) * play(t);
    const c = cutoff(bar);
    const ol = fl(l, c, 0.8) * g, or = fr(r, c, 0.8) * g;
    L[i] += ol; R[i] += or;
    SEND[i] += (ol + or) * 0.35;
  }
}

// ── bass: sub everywhere, pumped saw eighths in the drops ─────────────
{
  const osc = saw();
  const f = svf();
  let sub = 0;
  const OCT = [0, 12, 0, 0, 12, 0, 7, 0];
  const level = (t) => 0.8 * play(t);
  for (let i = 0; i < N; i++) {
    const t = i / SR, bar = t / BAR;
    if (bar >= BARS) break;
    const ch = chordAt(bar);
    const et = t % (BEAT / 2);
    const eighth = Math.floor(t / (BEAT / 2));
    sub += (2 * Math.PI * hz(ch.root)) / SR;
    let s = Math.sin(sub) * 0.55;
    const drv = osc(hz(ch.root + (inDrop(bar) ? OCT[eighth % 8] : 0)));
    if (inDrop(bar)) {
      const cut = 900 * (0.6 + 1.4 * Math.exp(-et / 0.06));
      s += f(drv, cut, 0.9) * 0.5 * Math.min(1, et / 0.004) * Math.exp(-et / 0.22);
    }
    const v = Math.tanh(s * 1.4) * 0.26 * duck(t, bar) * level(t);
    L[i] += v; R[i] += v;
  }
}

// ── arp: plucked saw/square through a ping-pong delay ─────────────────
{
  const PATTERN = [0, 1, 2, 3, 2, 1, 3, 2];
  const osc = saw();
  const f = svf();
  let sq = 0;
  const dry = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR, bar = t / BAR;
    if (bar >= BARS) continue;
    const sixteenths = inDrop(bar);
    const step = sixteenths ? BEAT / 4 : BEAT / 2;
    const k = Math.floor(t / step);
    const st = t % step;
    const ch = chordAt(bar);
    const note = ch.notes[PATTERN[k % 8]] + 12 + (k % 16 >= 8 && sixteenths ? 12 : 0);
    const fq = hz(note);
    sq += fq / SR; if (sq >= 1) sq -= 1;
    const tone = osc(fq) * 0.6 + (sq < 0.5 ? 0.4 : -0.4);
    const env = Math.min(1, st / 0.003) * Math.exp(-st / (sixteenths ? 0.09 : 0.16));
    const level = sixteenths ? 0.55 : bar >= BREAK && bar < DROP2 ? 0.65 : 0.45;
    dry[i] = f(tone, 900 + 5200 * Math.exp(-st / 0.05), 1.1) * env * level * 0.2 * play(t);
  }
  const D = Math.round(0.75 * BEAT * SR);
  const dl = new Float64Array(D), dr = new Float64Array(D);
  let lp = 0;
  for (let i = 0; i < N; i++) {
    const j = i % D;
    const outL = dl[j], outR = dr[j];
    lp += 0.35 * (outR - lp);
    dl[j] = dry[i] + lp * 0.5;
    dr[j] = outL;
    L[i] += dry[i] * 0.8 + outL * 0.75;
    R[i] += dry[i] * 0.8 + outR * 0.75;
    SEND[i] += dry[i] * 0.6;
  }
}

// ── drums and effects ─────────────────────────────────────────────────
function kick(t0, gain = 1) {
  let ph = 0;
  const i0 = Math.round(t0 * SR);
  for (let n = 0; n < 0.42 * SR && i0 + n < N; n++) {
    const t = n / SR;
    ph += (2 * Math.PI * (46 + 120 * Math.exp(-t * 32))) / SR;
    const v = Math.sin(ph) * Math.min(1, t / 0.0015) * Math.exp(-t / 0.17) * 0.74 * gain;
    L[i0 + n] += v; R[i0 + n] += v;
  }
}
function clap(t0, gain = 1, tail = 0.09) {
  const fl = svf(), fr = svf();
  const i0 = Math.round(t0 * SR);
  for (let n = 0; n < 0.35 * SR && i0 + n < N; n++) {
    const t = n / SR;
    let env = Math.exp(-t / tail) * 0.6;
    for (let k = 0; k < 3; k++) if (t >= k * 0.011) env += Math.exp(-(t - k * 0.011) / 0.005) * 0.5;
    const l = fl(rand(), 1400, 0.9, 'bp') * env * 0.5 * gain;
    const r = fr(rand(), 1400, 0.9, 'bp') * env * 0.5 * gain;
    L[i0 + n] += l; R[i0 + n] += r;
    SEND[i0 + n] += (l + r) * 0.8;
  }
}
function hat(t0, gain, pan, open = false) {
  const f = svf();
  const i0 = Math.round(t0 * SR);
  const dec = open ? 0.13 : 0.02;
  const gl = Math.sqrt((1 - pan) / 2), gr = Math.sqrt((1 + pan) / 2);
  for (let n = 0; n < dec * 6 * SR && i0 + n < N; n++) {
    const t = n / SR;
    const v = f(rand(), 7500, 0.7, 'hp') * Math.exp(-t / dec) * 0.07 * gain;
    L[i0 + n] += v * gl; R[i0 + n] += v * gr;
  }
}
function crash(t0, gain = 1) {
  const fl = svf(), fr = svf();
  const i0 = Math.round(t0 * SR);
  let ph = 0;
  for (let n = 0; n < 2.4 * SR && i0 + n < N; n++) {
    const t = n / SR;
    const env = Math.exp(-t / 0.7) * 0.16 * gain;
    L[i0 + n] += fl(rand(), 5000, 0.6, 'hp') * env;
    R[i0 + n] += fr(rand(), 5000, 0.6, 'hp') * env;
    ph += (2 * Math.PI * (34 + 30 * Math.exp(-t * 6))) / SR;
    const boom = Math.sin(ph) * Math.exp(-t / 0.55) * 0.4 * gain;
    L[i0 + n] += boom; R[i0 + n] += boom;
  }
}
for (let bar = 0; bar < BARS; bar++) {
  const b = (beat) => (bar * 4 + beat) * BEAT;
  if (inDrop(bar)) {
    for (let q = 0; q < 4; q++) kick(b(q));
    clap(b(1)); clap(b(3));
    for (let s = 0; s < 16; s++) {
      const accent = [1, 0.4, 0.65, 0.4][s % 4];
      hat(b(s / 4), accent, s % 2 ? 0.7 : -0.7);
    }
    for (let q = 0; q < 4; q++) hat(b(q + 0.5), 0.8, 0, true);
  }
  if (lifting(bar)) {
    const late = bar === DROP1 - 1 || bar === DROP2 - 1;
    for (let e = 0; e < 8; e++) {
      if (!stopped(b(e / 2 + 0.25))) hat(b(e / 2 + 0.25), late ? 0.55 : 0.35, e % 2 ? 0.6 : -0.6);
    }
  }
}
crash(DROP1 * BAR);
crash(DROP2 * BAR);

// ── stereo reverb on the send (Freeverb topology, spread right channel) ──
{
  const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const APS = [556, 441, 341, 225];
  const make = (spread) => ({
    combs: COMBS.map((n) => ({ buf: new Float64Array(n + spread), i: 0, store: 0 })),
    aps: APS.map((n) => ({ buf: new Float64Array(n + spread), i: 0 })),
  });
  const chans = [make(0), make(23)];
  const out = [L, R];
  for (let i = 0; i < N; i++) {
    const x = SEND[i] * 0.015;
    chans.forEach((c, ch) => {
      let y = 0;
      for (const cb of c.combs) {
        const o = cb.buf[cb.i];
        cb.store = o * 0.75 + cb.store * 0.25;
        cb.buf[cb.i] = x + cb.store * 0.86;
        cb.i = (cb.i + 1) % cb.buf.length;
        y += o;
      }
      for (const ap of c.aps) {
        const o = ap.buf[ap.i];
        ap.buf[ap.i] = y + o * 0.5;
        ap.i = (ap.i + 1) % ap.buf.length;
        y = o - y;
      }
      out[ch][i] += y * 0.55;
    });
  }
}

// Normalize to -1 dBFS sample peak and write 16-bit PCM.
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const norm = 10 ** (-1 / 20) / peak;
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
let off = 44;
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * norm * 32767))), off); off += 2;
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * norm * 32767))), off); off += 2;
}
const out = process.argv[2] ?? 'midnight-static.wav';
writeFileSync(out, buf);
console.log(`wrote ${out}: ${DUR.toFixed(1)} s stereo 44.1k/16 at ${BPM} BPM`);
