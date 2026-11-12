// WIDTH — stem-aware mid/side stereo image control.
// Widening opens the side signal by different amounts across the band:
//   < 140 Hz   anchored: never widened past unity (mono-compatible bass)
//   140–2 kHz  70% of the width amount: vocals and snare stay planted
//   > 2 kHz    115% of the width amount: cymbals, pads and air open first
// Narrowing (width < 1) is applied uniformly: tilted narrowing sounds odd.
//
// The tilt is two shelves on the side signal, not three bands split and
// summed. A band taken out with a crossover comes back rotated in phase at
// its edge, and the sum dips there: at width 200% the old split left the
// side 5.9 dB DOWN at 140 Hz, narrower than it came in. Shelves move every
// frequency the way the knob points.
import { Biquad } from './biquad';

const LOW_HZ = 140;
const HIGH_HZ = 2000;

export class StereoWidth {
  // Bass mono: the side's lows are removed outright (4th-order high-pass).
  private sideHp1 = new Biquad();
  private sideHp2 = new Biquad();
  // Widening tilt: lows held at unity, highs opened further.
  private lowShelf = new Biquad();
  private highShelf = new Biquad();
  private width = 1;
  private bassMono = false;
  private gain = 1;
  private tilted = false;
  private wasMono = false;
  private wasTilted = false;
  private fs: number;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    this.sideHp1.setHighpass(sampleRate, LOW_HZ, 0.54);
    this.sideHp2.setHighpass(sampleRate, LOW_HZ, 1.31);
  }

  reset(): void {
    this.sideHp1.reset(); this.sideHp2.reset();
    this.lowShelf.reset(); this.highShelf.reset();
  }

  setWidth(width: number): void {
    if (width === this.width) return;
    this.width = width;
    this.tilted = width > 1.0005;
    if (!this.tilted) {
      this.gain = width;
      return;
    }
    const wMid = 1 + (width - 1) * 0.7;
    const wHigh = 1 + (width - 1) * 1.15;
    this.gain = wMid;
    // Against the mids' gain: lows back down to unity, highs up to theirs.
    this.lowShelf.setLowShelf(this.fs, LOW_HZ, -20 * Math.log10(wMid), 0.9);
    this.highShelf.setHighShelf(this.fs, HIGH_HZ, 20 * Math.log10(wHigh / wMid), 0.9);
  }

  setBassMono(on: boolean): void { this.bassMono = on; }

  get active(): boolean { return Math.abs(this.width - 1) > 0.001 || this.bassMono; }

  processBlock(L: Float32Array, R: Float32Array, start: number, len: number): void {
    if (!this.active) { this.wasMono = false; this.wasTilted = false; return; }
    const { sideHp1, sideHp2, lowShelf, highShelf, gain } = this;
    const mono = this.bassMono;
    const tilted = this.tilted;
    // A filter coming into use starts clean.
    if (mono && !this.wasMono) { sideHp1.reset(); sideHp2.reset(); }
    if (tilted && !this.wasTilted) { lowShelf.reset(); highShelf.reset(); }
    this.wasMono = mono;
    this.wasTilted = tilted;
    for (let i = start; i < start + len; i++) {
      const mid = 0.5 * (L[i] + R[i]);
      let s = 0.5 * (L[i] - R[i]);
      if (mono) s = sideHp2.process(sideHp1.process(s));
      else if (tilted) s = lowShelf.process(s);
      if (tilted) s = highShelf.process(s);
      s *= gain;
      L[i] = mid + s;
      R[i] = mid - s;
    }
  }
}
