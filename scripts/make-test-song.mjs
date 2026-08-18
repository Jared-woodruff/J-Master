// Generates a 32-second stereo "song" at 44.1 kHz / 16-bit for J-Master testing:
// kick, bass, detuned chord pads (stereo), hats, and a lead line, with an
// arrangement (intro / full / outro) so dynamics and fades are visible.
import { writeFileSync } from 'node:fs';

const SR = 44100;
const DUR = 32;
const N = SR * DUR;
const L = new Float64Array(N);
const R = new Float64Array(N);

const BPM = 100;
const beat = 60 / BPM;

function noteHz(semisFromA4) { return 440 * Math.pow(2, semisFromA4 / 12); }

// A minor-ish progression: Am, F, C, G (roots relative to A4)
const chords = [
  [-24, -17, -12, -5], // A2 C3 E3 A3-ish voicing (A, E, A, C)
  [-28, -21, -16, -9], // F2...
  [-33, -26, -21, -12], // C2...
  [-26, -19, -14, -7],  // G2...
];

const kickBeats = new Set();
const hatSteps = [];
for (let bar = 0; bar < DUR / (beat * 4); bar++) {
  for (let b = 0; b < 4; b++) {
    kickBeats.add((bar * 4 + b) * beat);
    hatSteps.push((bar * 4 + b) * beat + beat / 2);
  }
}

function env(t, a, d) {
  if (t < 0) return 0;
  if (t < a) return t / a;
  return Math.exp(-(t - a) / d);
}

// Section gains: intro (bass+pad), full band, outro
function sectionGain(t) {
  if (t < 8) return { kick: 0, hat: 0, lead: 0, pad: 0.8, bass: 0.9 };
  if (t < 24) return { kick: 1, hat: 1, lead: 1, pad: 1, bass: 1 };
  return { kick: 1, hat: 0.6, lead: 0, pad: 0.9, bass: 1 };
}

const leadPattern = [0, 3, 7, 12, 10, 7, 3, 5];

let phBass = 0, phLead = 0;
const padPh = [0, 0, 0, 0, 0, 0, 0, 0];

for (let i = 0; i < N; i++) {
  const t = i / SR;
  const g = sectionGain(t);
  const barPos = Math.floor(t / (beat * 4)) % 4;
  const chord = chords[barPos];

  let l = 0, r = 0;

  // Kick: 55 Hz sine with pitch drop, every beat
  const beatT = t % beat;
  if (g.kick > 0) {
    const f = 55 + 90 * Math.exp(-beatT * 35);
    const kick = Math.sin(2 * Math.PI * f * beatT) * env(beatT, 0.002, 0.09) * 0.9 * g.kick;
    l += kick; r += kick;
  }

  // Bass: root, slightly overdriven sine+saw
  const bassHz = noteHz(chord[0]) / 2;
  phBass += (2 * Math.PI * bassHz) / SR;
  const bassRaw = Math.sin(phBass) * 0.7 + Math.sin(phBass * 2) * 0.15;
  // On-grid bass: attacks on the beat, decaying through it (like real playing)
  const bassGate = 0.35 + 0.65 * Math.exp(-(t % beat) / (beat * 0.6));
  const bass = Math.tanh(bassRaw * 1.6) * 0.42 * bassGate * g.bass;
  l += bass; r += bass;

  // Pad: two detuned saw-ish per chord tone, stereo spread
  if (g.pad > 0) {
    for (let v = 0; v < 4; v++) {
      const hz = noteHz(chord[v]);
      padPh[v] += (2 * Math.PI * hz * 1.003) / SR;
      padPh[v + 4] += (2 * Math.PI * hz * 0.997) / SR;
      const sA = (2 * ((padPh[v] / (2 * Math.PI)) % 1) - 1) * 0.5 + Math.sin(padPh[v]) * 0.5;
      const sB = (2 * ((padPh[v + 4] / (2 * Math.PI)) % 1) - 1) * 0.5 + Math.sin(padPh[v + 4]) * 0.5;
      const pan = (v / 3) * 2 - 1; // -1..1
      const amp = 0.055 * g.pad;
      l += (sA * (1 - pan) * 0.5 + sB * 0.25) * amp;
      r += (sB * (1 + pan) * 0.5 + sA * 0.25) * amp;
    }
  }

  // Hats: filtered noise ticks, panned slightly right
  if (g.hat > 0) {
    for (const hs of [beatT - beat / 2]) {
      if (hs >= 0 && hs < 0.05) {
        const n = (Math.random() * 2 - 1) * env(hs, 0.001, 0.02) * 0.16 * g.hat;
        l += n * 0.7; r += n * 1.0;
      }
    }
  }

  // Lead: 8th-note arp in the full section
  if (g.lead > 0) {
    const stepLen = beat / 2;
    const step = Math.floor(t / stepLen) % leadPattern.length;
    const stepT = t % stepLen;
    const hz = noteHz(leadPattern[step] - 0); // around A4
    phLead += (2 * Math.PI * hz) / SR;
    const sq = Math.tanh(Math.sin(phLead) * 3) * 0.5 + Math.sin(phLead * 2) * 0.2;
    const lead = sq * env(stepT, 0.005, 0.12) * 0.14 * g.lead;
    l += lead * 0.85; r += lead * 1.1;
  }

  L[i] = l;
  R[i] = r;
}

// Normalize to -1 dBFS sample peak
let peak = 0;
for (let i = 0; i < N; i++) {
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = Math.pow(10, -1 / 20) / peak;

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
const out = process.argv[2] ?? 'test-song.wav';
writeFileSync(out, buf);
console.log(`wrote ${out}: ${DUR}s stereo 44.1k/16`);
