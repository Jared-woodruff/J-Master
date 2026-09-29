// CHARACTER — musical harmonic saturation, 4x oversampled.
// Soft tanh drive (odd harmonics) with a DC-compensated bias term
// (even harmonics, tube-ish warmth). Small-signal gain stays unity so the
// knob adds colour, not level.
import { Oversampler4x } from './oversampler';

export class Saturator {
  private osL = new Oversampler4x();
  private osR = new Oversampler4x();
  private dcL = 0;
  private dcR = 0;
  private drive = 0;      // 0..1, slewed by the chain
  private g = 1;
  private bias = 0;
  private biasOffset = 0;
  private dcCoef: number;

  constructor(sampleRate: number) {
    // Gentle DC blocker after the asymmetric stage (~5 Hz one-pole highpass).
    this.dcCoef = 1 - Math.exp((-2 * Math.PI * 5) / sampleRate);
  }

  reset(): void {
    this.osL.reset(); this.osR.reset(); this.dcL = 0; this.dcR = 0;
  }

  setDrive(drive: number): void {
    this.drive = drive;
    const driveDb = drive * 10;                    // up to +10 dB into the shaper
    this.g = Math.pow(10, driveDb / 20);
    this.bias = 0.12 * drive;
    this.biasOffset = Math.tanh(this.g * this.bias);
  }

  get active(): boolean { return this.drive > 0.001; }

  private shape = (s: number): number => {
    const g = this.g;
    return (Math.tanh(g * (s + this.bias)) - this.biasOffset) / g;
  };

  processBlock(L: Float32Array, R: Float32Array, start: number, len: number): void {
    if (!this.active) return;
    const { osL, osR, shape, dcCoef } = this;
    let dcL = this.dcL, dcR = this.dcR;
    for (let i = start; i < start + len; i++) {
      let l = osL.process(L[i], shape);
      let r = osR.process(R[i], shape);
      dcL += dcCoef * (l - dcL);
      dcR += dcCoef * (r - dcR);
      L[i] = l - dcL;
      R[i] = r - dcR;
    }
    this.dcL = dcL; this.dcR = dcR;
  }
}
