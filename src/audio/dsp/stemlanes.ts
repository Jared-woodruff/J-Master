// STEM LANES — stem-aware component trims without neural separation:
//   BASS   < 120 Hz (both channels)
//   DRUMS  the transient component, full band (fast-vs-slow envelope split)
//   VOCAL  the centre channel's 250 Hz – 3.5 kHz band
//   AIR    > 8 kHz (both channels)
// Each lane trims ±3 dB. The extraction is heuristic — honest DSP, not ML —
// but the lane interface is exactly what a neural separator can feed later.
import { Biquad } from './biquad';
import { dbToLin } from './params';

export class StemLanes {
  private bassLpL1 = new Biquad(); private bassLpL2 = new Biquad();
  private bassLpR1 = new Biquad(); private bassLpR2 = new Biquad();
  private vocHp1 = new Biquad(); private vocHp2 = new Biquad();
  private vocLp1 = new Biquad(); private vocLp2 = new Biquad();
  // Air is extracted subtractively (x − LP(x)) so the treated band stays
  // phase-coherent — a direct HP is ~180° rotated near cutoff and cancels.
  private airLpL1 = new Biquad(); private airLpL2 = new Biquad();
  private airLpR1 = new Biquad(); private airLpR2 = new Biquad();
  private fastEnv = 0;
  private slowEnv = 0;
  private fastAtt: number; private fastRel: number;
  private slowAtt: number; private slowRel: number;

  private gBass = 1; private gDrums = 1; private gVocal = 1; private gAir = 1;

  constructor(sampleRate: number) {
    // Linkwitz-Riley-ish 4th order via cascaded Butterworth Q pairs.
    this.bassLpL1.setLowpass(sampleRate, 120, 0.54);
    this.bassLpL2.setLowpass(sampleRate, 120, 1.31);
    this.bassLpR1.setLowpass(sampleRate, 120, 0.54);
    this.bassLpR2.setLowpass(sampleRate, 120, 1.31);
    this.vocHp1.setHighpass(sampleRate, 250, 0.54);
    this.vocHp2.setHighpass(sampleRate, 250, 1.31);
    this.vocLp1.setLowpass(sampleRate, 3500, 0.54);
    this.vocLp2.setLowpass(sampleRate, 3500, 1.31);
    this.airLpL1.setLowpass(sampleRate, 8000, 0.54);
    this.airLpL2.setLowpass(sampleRate, 8000, 1.31);
    this.airLpR1.setLowpass(sampleRate, 8000, 0.54);
    this.airLpR2.setLowpass(sampleRate, 8000, 1.31);
    this.fastAtt = 1 - Math.exp(-1 / (sampleRate * 0.0003));
    this.fastRel = 1 - Math.exp(-1 / (sampleRate * 0.035));
    this.slowAtt = 1 - Math.exp(-1 / (sampleRate * 0.02));
    this.slowRel = 1 - Math.exp(-1 / (sampleRate * 0.3));
  }

  reset(): void {
    for (const b of [
      this.bassLpL1, this.bassLpL2, this.bassLpR1, this.bassLpR2,
      this.vocHp1, this.vocHp2, this.vocLp1, this.vocLp2,
      this.airLpL1, this.airLpL2, this.airLpR1, this.airLpR2,
    ]) b.reset();
    this.fastEnv = 0; this.slowEnv = 0;
  }

  setTrims(bassDb: number, drumsDb: number, vocalDb: number, airDb: number): void {
    this.gBass = dbToLin(bassDb);
    this.gDrums = dbToLin(drumsDb);
    this.gVocal = dbToLin(vocalDb);
    this.gAir = dbToLin(airDb);
  }

  get active(): boolean {
    return (
      Math.abs(this.gBass - 1) > 0.003 || Math.abs(this.gDrums - 1) > 0.003 ||
      Math.abs(this.gVocal - 1) > 0.003 || Math.abs(this.gAir - 1) > 0.003
    );
  }

  processBlock(L: Float32Array, R: Float32Array, start: number, len: number): void {
    if (!this.active) return;
    const { gBass, gDrums, gVocal, gAir, fastAtt, fastRel, slowAtt, slowRel } = this;
    let fastEnv = this.fastEnv, slowEnv = this.slowEnv;
    for (let i = start; i < start + len; i++) {
      let l = L[i], r = R[i];

      // BASS lane: trim the low component.
      if (gBass !== 1) {
        const lowL = this.bassLpL2.process(this.bassLpL1.process(l));
        const lowR = this.bassLpR2.process(this.bassLpR1.process(r));
        l += (gBass - 1) * lowL;
        r += (gBass - 1) * lowR;
      }

      // VOCAL lane: centre-channel presence band, added back to both sides.
      if (gVocal !== 1) {
        const mid = 0.5 * (l + r);
        const band = this.vocLp2.process(this.vocLp1.process(
          this.vocHp2.process(this.vocHp1.process(mid))));
        const add = (gVocal - 1) * band;
        l += add;
        r += add;
      }

      // AIR lane: trim the high component per channel (subtractive split).
      if (gAir !== 1) {
        const airL = l - this.airLpL2.process(this.airLpL1.process(l));
        const airR = r - this.airLpR2.process(this.airLpR1.process(r));
        l += (gAir - 1) * airL;
        r += (gAir - 1) * airR;
      }

      // DRUMS lane: scale only the transient portion of the signal.
      if (gDrums !== 1) {
        const mag = Math.max(Math.abs(l), Math.abs(r));
        fastEnv += (mag > fastEnv ? fastAtt : fastRel) * (mag - fastEnv);
        slowEnv += (mag > slowEnv ? slowAtt : slowRel) * (mag - slowEnv);
        const ratio = slowEnv > 1e-6 ? fastEnv / slowEnv : 1;
        const transientWeight = Math.max(0, Math.min(1, (ratio - 1.1) / 1.2));
        const g = 1 + (gDrums - 1) * transientWeight;
        l *= g;
        r *= g;
      }

      L[i] = l;
      R[i] = r;
    }
    this.fastEnv = fastEnv; this.slowEnv = slowEnv;
  }
}
