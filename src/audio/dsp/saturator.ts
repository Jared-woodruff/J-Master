// CHARACTER — musical harmonic saturation, 4x oversampled.
// Soft tanh drive (odd harmonics) with a DC-compensated bias term (even
// harmonics, tube-ish warmth). The curve's slope at rest is exactly one at
// every setting, so the knob adds colour, not level; and its drive starts
// from nothing, so the first step of the knob is as small as any other.
import { Oversampler4x } from './oversampler';
import { DelayLine } from './delay';

/** How many recent samples re-prime the oversampler when the stage wakes (its filters span 80). */
export const OS_PRIME = 112;

/** The last OS_PRIME samples a delay line saw, oldest first. */
export function recentOf(d: DelayLine, into: Float32Array): Float32Array {
  for (let k = 0; k < OS_PRIME; k++) into[k] = d.recent(OS_PRIME - 1 - k);
  return into;
}

export class Saturator {
  private osL = new Oversampler4x();
  private osR = new Oversampler4x();
  private dryL = new DelayLine(Oversampler4x.latency, OS_PRIME);
  private dryR = new DelayLine(Oversampler4x.latency, OS_PRIME);
  private scratch = new Float32Array(OS_PRIME);
  private dcL = 0;
  private dcR = 0;
  private drive = 0;      // 0..1, slewed by the chain
  private g = 1;
  private bias = 0;
  private biasOffset = 0;
  private norm = 1;
  private dcCoef: number;
  private wasOn = false;

  /** Constant, working or resting. */
  static readonly latency = Oversampler4x.latency;

  constructor(sampleRate: number) {
    // Gentle DC blocker after the asymmetric stage (~5 Hz one-pole highpass).
    this.dcCoef = 1 - Math.exp((-2 * Math.PI * 5) / sampleRate);
  }

  reset(): void {
    this.osL.reset(); this.osR.reset(); this.dryL.reset(); this.dryR.reset();
    this.dcL = 0; this.dcR = 0; this.wasOn = false;
  }

  setDrive(drive: number): void {
    this.drive = drive;
    // Up to +10 dB into the shaper, less a term that takes the gain to zero
    // with the knob (tanh(g·x)/g is the identity as g → 0). From the middle
    // of the knob up, the drive is the plain 10^(drive/2).
    this.g = Math.max(1e-3, Math.pow(10, drive / 2) - Math.pow(1 - drive, 3));
    this.bias = 0.12 * drive;
    this.biasOffset = Math.tanh(this.g * this.bias);
    // d/ds tanh(g(s + b)) at s = 0 is g·sech²(g·b): dividing by it keeps
    // quiet signal at exactly unity.
    this.norm = 1 / (this.g * (1 - this.biasOffset * this.biasOffset));
  }

  get active(): boolean { return this.drive > 0.001; }

  private channel(os: Oversampler4x, x: Float32Array, start: number, len: number, dc: number): number {
    const { g, bias, biasOffset, norm, dcCoef } = this;
    const hi = os.up(x, start, len);
    for (let i = 0; i < hi.length; i++) hi[i] = (Math.tanh(g * (hi[i] + bias)) - biasOffset) * norm;
    os.down(x, start, len);
    for (let i = start; i < start + len; i++) {
      const v = x[i];
      dc += dcCoef * (v - dc);
      x[i] = v - dc;
    }
    return dc;
  }

  /** `engaged: false` holds the stage out (REF) while keeping its delay. */
  processBlock(L: Float32Array, R: Float32Array, start: number, len: number, engaged = true): void {
    const on = this.active && engaged;
    const { osL, osR, dryL, dryR } = this;
    if (on && !this.wasOn) {
      // Waking: run the last stretch of signal through the oversampler so
      // it carries on from exactly where the resting delay leaves off.
      osL.reset(); osR.reset();
      const s = this.scratch;
      osL.up(recentOf(dryL, s), 0, OS_PRIME); osL.down(s, 0, OS_PRIME);
      osR.up(recentOf(dryR, s), 0, OS_PRIME); osR.down(s, 0, OS_PRIME);
      this.dcL = 0; this.dcR = 0;
    }
    this.wasOn = on;
    if (!on) {
      for (let i = start; i < start + len; i++) {
        L[i] = dryL.push(L[i]);
        R[i] = dryR.push(R[i]);
      }
      return;
    }
    for (let i = start; i < start + len; i++) { dryL.push(L[i]); dryR.push(R[i]); }
    this.dcL = this.channel(osL, L, start, len, this.dcL);
    this.dcR = this.channel(osR, R, start, len, this.dcR);
  }
}
