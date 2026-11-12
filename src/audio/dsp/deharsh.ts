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
/**
 * The cut is decided every STEP samples, counted from the start of the
 * stream, never per processing block: the preview's 128-sample blocks and
 * the export's 4096 must hear exactly the same thing.
 */
const STEP = 32;
/** Below this programme level (≈ −60 dBFS) nothing is judged harsh. */
const FLOOR = 0.001;

export class DeHarsh {
  private scBand = new Biquad();     // sidechain bandpass (mono sum)
  private cutL = new Biquad();
  private cutR = new Biquad();
  private bandEnv = 0;
  private wideEnv = 0;
  private grSmDb = 0;
  private appliedGrDb = -1;          // last coefficient update
  private phase = 0;                 // samples since the last decision
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
    this.phase = 0;
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
    const { envAtt, envRel, amount, cutL, cutR } = this;
    const attStep = Math.min(1, this.grAtt * STEP);
    const relStep = Math.min(1, this.grRel * STEP);
    let bandEnv = this.bandEnv, wideEnv = this.wideEnv, grSmDb = this.grSmDb, phase = this.phase;

    for (let i = start; i < start + len; i++) {
      const mono = 0.5 * (L[i] + R[i]);
      const band = Math.abs(this.scBand.process(mono));
      const wide = Math.abs(mono);
      bandEnv += (band > bandEnv ? envAtt : envRel) * (band - bandEnv);
      wideEnv += (wide > wideEnv ? envAtt : envRel) * (wide - wideEnv);
      L[i] = cutL.process(L[i]);
      R[i] = cutR.process(R[i]);
      if (++phase < STEP) continue;
      phase = 0;
      // Harshness: band level rising above its graceful share of the
      // programme (and never in near-silence, where the ratio means nothing).
      const harshDb = wideEnv > FLOOR
        ? 20 * Math.log10((bandEnv + 1e-9) / (wideEnv + 1e-9)) + GRACE_DB
        : 0;
      const targetGr = Math.min(MAX_CUT_DB, Math.max(0, harshDb)) * amount;
      grSmDb += (targetGr > grSmDb ? attStep : relStep) * (targetGr - grSmDb);
      if (grSmDb < 0) grSmDb = 0;
      // Refresh the cut filter only when the reduction moved meaningfully.
      if (Math.abs(grSmDb - this.appliedGrDb) > 0.05) {
        cutL.setPeaking(this.fs, BAND_HZ, -grSmDb, 1.1);
        cutR.copyCoefficientsFrom(cutL);
        this.appliedGrDb = grSmDb;
      }
    }

    this.bandEnv = bandEnv; this.wideEnv = wideEnv; this.grSmDb = grSmDb; this.phase = phase;
  }
}

export { dbToLin };
