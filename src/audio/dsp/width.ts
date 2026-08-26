// WIDTH — stem-aware mid/side stereo image control.
// The side signal is split into three bands that widen differently:
//   < 140 Hz   anchored — never widened past unity (mono-compatible bass)
//   140–2 kHz  70% of the width amount — vocals/snare stay planted
//   > 2 kHz    115% of the width amount — cymbals/pads/air open up first
// Narrowing (width < 1) is applied uniformly: tilted narrowing sounds odd.
import { Biquad } from './biquad';

export class StereoWidth {
  private sideHp1 = new Biquad();
  private sideHp2 = new Biquad();
  private sideHi1 = new Biquad();
  private sideHi2 = new Biquad();
  private width = 1;
  private bassMono = false;

  constructor(sampleRate: number) {
    this.sideHp1.setHighpass(sampleRate, 140, 0.54);
    this.sideHp2.setHighpass(sampleRate, 140, 1.31);
    this.sideHi1.setHighpass(sampleRate, 2000, 0.54);
    this.sideHi2.setHighpass(sampleRate, 2000, 1.31);
  }

  reset(): void {
    this.sideHp1.reset(); this.sideHp2.reset();
    this.sideHi1.reset(); this.sideHi2.reset();
  }

  setWidth(width: number): void { this.width = width; }
  setBassMono(on: boolean): void { this.bassMono = on; }

  get active(): boolean { return Math.abs(this.width - 1) > 0.001 || this.bassMono; }

  processBlock(L: Float32Array, R: Float32Array, start: number, len: number): void {
    if (!this.active) return;
    const w = this.width;
    const wLow = this.bassMono ? 0 : Math.min(w, 1);
    const wMid = w < 1 ? w : 1 + (w - 1) * 0.7;
    const wHigh = w < 1 ? w : 1 + (w - 1) * 1.15;
    const { sideHp1, sideHp2, sideHi1, sideHi2 } = this;
    for (let i = start; i < start + len; i++) {
      const mid = 0.5 * (L[i] + R[i]);
      const side = 0.5 * (L[i] - R[i]);
      const above = sideHp2.process(sideHp1.process(side)); // > 140 Hz
      const low = side - above;
      const high = sideHi2.process(sideHi1.process(above)); // > 2 kHz
      const midBand = above - high;
      const s = low * wLow + midBand * wMid + high * wHigh;
      L[i] = mid + s;
      R[i] = mid - s;
    }
  }
}
