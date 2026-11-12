// DENSITY — stereo-linked glue compressor.
// Slow-ish RMS detection, soft knee, low ratio: thickness and sustain,
// not pumping. Auto-makeup keeps preview level steady while the knob moves.
// Assumes the chain's staging has put programme material near -18 LUFS.
import { dbToLin, linToDb } from './params';

export class GlueCompressor {
  private thresholdDb = -16;
  private ratio = 1.2;
  private kneeDb = 8;
  private makeupLin = 1;
  private envDb = -80;         // detector level, dB
  private grSmDb = 0;          // smoothed gain reduction, dB
  private attCoef: number;
  private relCoef: number;
  private grAttCoef: number;
  private grRelCoef: number;
  private msSm = 0;
  private msCoef: number;
  /** Current gain reduction in dB (positive number), for the meter. */
  grDb = 0;
  private amount = 0;
  /** 0..1: takes the whole stage to nothing over the first tenth of the knob. */
  private depth = 0;
  private makeupDb = 0;

  constructor(sampleRate: number) {
    this.attCoef = Math.exp(-1 / (sampleRate * 0.03));
    this.relCoef = Math.exp(-1 / (sampleRate * 0.25));
    this.grAttCoef = Math.exp(-1 / (sampleRate * 0.01));
    this.grRelCoef = Math.exp(-1 / (sampleRate * 0.15));
    this.msCoef = 1 - Math.exp(-1 / (sampleRate * 0.005));
  }

  reset(): void { this.envDb = -80; this.grSmDb = 0; this.msSm = 0; this.grDb = 0; }

  setAmount(density: number): void {
    this.amount = density;
    this.thresholdDb = -16 - 8 * density;
    this.ratio = 1.2 + 0.8 * density;
    // Static makeup for the expected GR at ~-12 dB detector level.
    const over = Math.max(0, -12 - this.thresholdDb);
    const expectedGr = over * (1 - 1 / this.ratio);
    // The ratio starts at 1.2, not 1, so the knob's first step used to
    // switch on half a dB of make-up at once. Both the reduction and its
    // make-up now grow from zero across the first tenth of the knob; from
    // there up nothing changes.
    this.depth = Math.min(1, density / 0.1);
    this.makeupDb = expectedGr * 0.7 * this.depth;
    this.makeupLin = dbToLin(this.makeupDb);
  }

  get active(): boolean { return this.amount > 0.001; }

  processBlock(L: Float32Array, R: Float32Array, start: number, len: number): void {
    if (!this.active) { this.grDb = 0; return; }
    const { attCoef, relCoef, grAttCoef, grRelCoef, msCoef, thresholdDb, ratio, kneeDb, makeupLin, depth } = this;
    let envDb = this.envDb, grSmDb = this.grSmDb, msSm = this.msSm;
    const halfKnee = kneeDb / 2;
    const slope = (1 - 1 / ratio) * depth;
    // The detector's ballistics run in dB, so from digital silence it had
    // 60 dB to climb before it reached the knee, and the first hit after a
    // break went through uncompressed for 60 ms or more. It now never
    // falls further than a knee's width under the threshold: every
    // entrance meets the same attack.
    const envFloor = thresholdDb - kneeDb;
    for (let i = start; i < start + len; i++) {
      const l = L[i], r = R[i];
      // Quasi-RMS level, stereo linked.
      const ms = 0.5 * (l * l + r * r);
      msSm += msCoef * (ms - msSm);
      const levelDb = 10 * Math.log10(msSm + 1e-12);
      // Attack/release ballistics in dB domain.
      const coef = levelDb > envDb ? attCoef : relCoef;
      envDb = levelDb + coef * (envDb - levelDb);
      if (envDb < envFloor) envDb = envFloor;
      // Soft-knee gain computer.
      const over = envDb - thresholdDb;
      let grDb = 0;
      if (over >= halfKnee) grDb = over * slope;
      else if (over > -halfKnee) {
        const t = over + halfKnee;
        grDb = (slope * t * t) / (2 * kneeDb);
      }
      // Smooth the applied gain.
      const gCoef = grDb > grSmDb ? grAttCoef : grRelCoef;
      grSmDb = grDb + gCoef * (grSmDb - grDb);
      const gain = dbToLin(-grSmDb) * makeupLin;
      L[i] = l * gain;
      R[i] = r * gain;
    }
    this.envDb = envDb; this.grSmDb = grSmDb; this.msSm = msSm;
    this.grDb = grSmDb;
  }
}

export { linToDb };
