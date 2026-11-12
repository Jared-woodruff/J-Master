// STEM LANES — stem-aware component trims without neural separation:
//   BASS   the low end, both channels: a shelf at 120 Hz
//   DRUMS  the transient component, full band (fast-vs-slow envelope split)
//   VOCAL  the centre channel's 250 Hz – 3.5 kHz band
//   AIR    the top, both channels: a shelf at 8 kHz
// Each lane trims ±3 dB. The extraction is heuristic (honest DSP, not ML),
// but the lane interface is exactly what a neural separator can feed later.
//
// The three tonal lanes are minimum-phase filters in the signal path, not
// bands split off and added back. A band taken out with a crossover comes
// back rotated in phase near its edge, and the sum carves a notch beside
// every boost: BASS +3 dB used to cut 120 Hz by 3 dB, VOCAL +3 dB cut
// 250 Hz and 3.5 kHz by 3 dB, and AIR −3 dB dug 6 dB out of 8 kHz. A shelf
// or a bell moves every frequency the way the trim points, by no more than
// the trim.
import { Biquad } from './biquad';
import { dbToLin } from './params';

const BASS_HZ = 120;
const AIR_HZ = 8000;
/** Centre and Q of the bell whose half-gain points sit at 250 Hz and 3.5 kHz. */
const VOCAL_HZ = Math.sqrt(250 * 3500);
const VOCAL_Q = 0.29;
/** A trim under this is off. */
const OFF_DB = 0.05;

export class StemLanes {
  private bassL = new Biquad(); private bassR = new Biquad();
  private airL = new Biquad(); private airR = new Biquad();
  private vocalM = new Biquad();
  private fastEnv = 0;
  private slowEnv = 0;
  private fastAtt: number; private fastRel: number;
  private slowAtt: number; private slowRel: number;

  private bassDb = 0; private vocalDb = 0; private airDb = 0;
  private gDrums = 1;
  private fs: number;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    this.fastAtt = 1 - Math.exp(-1 / (sampleRate * 0.0003));
    this.fastRel = 1 - Math.exp(-1 / (sampleRate * 0.035));
    this.slowAtt = 1 - Math.exp(-1 / (sampleRate * 0.02));
    this.slowRel = 1 - Math.exp(-1 / (sampleRate * 0.3));
  }

  reset(): void {
    for (const b of [this.bassL, this.bassR, this.airL, this.airR, this.vocalM]) b.reset();
    this.fastEnv = 0; this.slowEnv = 0;
  }

  setTrims(bassDb: number, drumsDb: number, vocalDb: number, airDb: number): void {
    const fs = this.fs;
    // A lane coming back from off starts clean; a lane already on is
    // retuned in place, so a drag never thumps.
    if (bassDb !== this.bassDb) {
      if (Math.abs(this.bassDb) < OFF_DB) { this.bassL.reset(); this.bassR.reset(); }
      this.bassDb = bassDb;
      this.bassL.setLowShelf(fs, BASS_HZ, bassDb, 0.9);
      this.bassR.copyCoefficientsFrom(this.bassL);
    }
    if (vocalDb !== this.vocalDb) {
      if (Math.abs(this.vocalDb) < OFF_DB) this.vocalM.reset();
      this.vocalDb = vocalDb;
      this.vocalM.setPeaking(fs, VOCAL_HZ, vocalDb, VOCAL_Q);
    }
    if (airDb !== this.airDb) {
      if (Math.abs(this.airDb) < OFF_DB) { this.airL.reset(); this.airR.reset(); }
      this.airDb = airDb;
      this.airL.setHighShelf(fs, AIR_HZ, airDb, 0.9);
      this.airR.copyCoefficientsFrom(this.airL);
    }
    this.gDrums = dbToLin(drumsDb);
  }

  get active(): boolean {
    return (
      Math.abs(this.bassDb) >= OFF_DB || Math.abs(this.vocalDb) >= OFF_DB ||
      Math.abs(this.airDb) >= OFF_DB || Math.abs(this.gDrums - 1) > 0.003
    );
  }

  processBlock(L: Float32Array, R: Float32Array, start: number, len: number): void {
    if (!this.active) return;
    const { gDrums, fastAtt, fastRel, slowAtt, slowRel } = this;
    const bass = Math.abs(this.bassDb) >= OFF_DB;
    const vocal = Math.abs(this.vocalDb) >= OFF_DB;
    const air = Math.abs(this.airDb) >= OFF_DB;
    const drums = Math.abs(gDrums - 1) > 0.003;

    if (bass) { this.bassL.processBlock(L, start, len); this.bassR.processBlock(R, start, len); }

    // VOCAL lane: the bell works on the centre (mid) only; the sides pass.
    if (vocal) {
      const bell = this.vocalM;
      for (let i = start; i < start + len; i++) {
        const mid = 0.5 * (L[i] + R[i]);
        const d = bell.process(mid) - mid;
        L[i] += d;
        R[i] += d;
      }
    }

    if (air) { this.airL.processBlock(L, start, len); this.airR.processBlock(R, start, len); }

    // DRUMS lane: scale only the transient portion of the signal.
    if (drums) {
      let fastEnv = this.fastEnv, slowEnv = this.slowEnv;
      for (let i = start; i < start + len; i++) {
        const l = L[i], r = R[i];
        const mag = Math.max(Math.abs(l), Math.abs(r));
        fastEnv += (mag > fastEnv ? fastAtt : fastRel) * (mag - fastEnv);
        slowEnv += (mag > slowEnv ? slowAtt : slowRel) * (mag - slowEnv);
        const ratio = slowEnv > 1e-6 ? fastEnv / slowEnv : 1;
        const transientWeight = Math.max(0, Math.min(1, (ratio - 1.1) / 1.2));
        const g = 1 + (gDrums - 1) * transientWeight;
        L[i] = l * g;
        R[i] = r * g;
      }
      this.fastEnv = fastEnv; this.slowEnv = slowEnv;
    }
  }
}
