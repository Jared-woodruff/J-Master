// SMOOTH — dynamic high-band tamer. A single-band dynamic EQ at ~6.5 kHz:
// when high-band energy rises above its usual relation to the broadband
// level (harsh cymbals, AI-generation zing), a peaking cut ducks it —
// transparent when the material is already smooth. Stereo linked.
import { Biquad } from './biquad';
import { dbToLin } from './params';

const BAND_HZ = 6500;
const MAX_CUT_DB = 6;
/** How far the band may sit below broadband before it counts as harsh. */
const GRACE_DB = 8;

export class DeHarsh {
  private scBand = new Biquad();     // sidechain bandpass (mono sum)
  private cutL = new Biquad();
  private cutR = new Biquad();
  private bandEnv = 0;
  private wideEnv = 0;
  private grSmDb = 0;
  private appliedGrDb = -1;          // last coefficient update
  private envAtt: number;
  private envRel: number;
  private grAtt: number;
  private grRel: number;
  private amount = 0;
  private fs: number;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    // Sidechain listens to everything above ~4.5 kHz.
    this.scBand.setHighpass(sampleRate, 4500, 0.707);
    this.cutL.setIdentity();
    this.cutR.setIdentity();
    this.envAtt = 1 - Math.exp(-1 / (sampleRate * 0.003));
    this.envRel = 1 - Math.exp(-1 / (sampleRate * 0.08));
    this.grAtt = 1 - Math.exp(-1 / (sampleRate * 0.004));
    this.grRel = 1 - Math.exp(-1 / (sampleRate * 0.12));
  }

  reset(): void {
    this.scBand.reset(); this.cutL.reset(); this.cutR.reset();
    this.bandEnv = 0; this.wideEnv = 0; this.grSmDb = 0;
    this.appliedGrDb = -1;
  }

  setAmount(smooth: number): void { this.amount = smooth; }

  get active(): boolean { return this.amount > 0.001; }
  /** Current cut in dB (positive), for potential metering. */
  get grDb(): number { return this.grSmDb; }

  processBlock(L: Float32Array, R: Float32Array, start: number, len: number): void {
    if (!this.active) {
      if (this.appliedGrDb !== 0) {
        this.cutL.setIdentity();
        this.cutR.setIdentity();
        this.appliedGrDb = 0;
      }
      this.grSmDb = 0;
      return;
    }
    const { envAtt, envRel, grAtt, grRel, amount } = this;
    let bandEnv = this.bandEnv, wideEnv = this.wideEnv, grSmDb = this.grSmDb;

    for (let i = start; i < start + len; i++) {
      const mono = 0.5 * (L[i] + R[i]);
      const band = Math.abs(this.scBand.process(mono));
      const wide = Math.abs(mono);
      bandEnv += (band > bandEnv ? envAtt : envRel) * (band - bandEnv);
      wideEnv += (wide > wideEnv ? envAtt : envRel) * (wide - wideEnv);
    }
    // Harshness: band level rising above its graceful share of the programme.
    const harshDb =
      20 * Math.log10((bandEnv + 1e-9) / (wideEnv + 1e-9)) + GRACE_DB;
    const targetGr = Math.min(MAX_CUT_DB, Math.max(0, harshDb)) * amount;
    const coef = Math.min(1, (targetGr > grSmDb ? grAtt : grRel) * len);
    grSmDb += coef * (targetGr - grSmDb);
    if (grSmDb < 0) grSmDb = 0;

    // Refresh the cut filter only when the reduction moved meaningfully.
    if (Math.abs(grSmDb - this.appliedGrDb) > 0.05) {
      this.cutL.setPeaking(this.fs, BAND_HZ, -grSmDb, 1.1);
      this.cutR.copyCoefficientsFrom(this.cutL);
      this.appliedGrDb = grSmDb;
    }
    this.cutL.processBlock(L, start, len);
    this.cutR.processBlock(R, start, len);

    this.bandEnv = bandEnv; this.wideEnv = wideEnv; this.grSmDb = grSmDb;
  }
}

export { dbToLin };
