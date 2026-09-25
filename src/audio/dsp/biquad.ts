// RBJ cookbook biquad, transposed direct form II.
export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private z1 = 0;
  private z2 = 0;

  reset(): void { this.z1 = 0; this.z2 = 0; }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  processBlock(buf: Float32Array, start: number, len: number): void {
    let z1 = this.z1, z2 = this.z2;
    const { b0, b1, b2, a1, a2 } = this;
    for (let i = start; i < start + len; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    this.z1 = z1; this.z2 = z2;
  }

  copyCoefficientsFrom(o: Biquad): void {
    this.b0 = o.b0; this.b1 = o.b1; this.b2 = o.b2; this.a1 = o.a1; this.a2 = o.a2;
  }

  setIdentity(): void { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; }

  setHighpass(fs: number, f0: number, q: number): void {
    const w0 = (2 * Math.PI * f0) / fs;
    const cosW = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 + cosW) / 2 / a0;
    this.b1 = -(1 + cosW) / a0;
    this.b2 = (1 + cosW) / 2 / a0;
    this.a1 = (-2 * cosW) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  setLowpass(fs: number, f0: number, q: number): void {
    const w0 = (2 * Math.PI * f0) / fs;
    const cosW = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 - cosW) / 2 / a0;
    this.b1 = (1 - cosW) / a0;
    this.b2 = (1 - cosW) / 2 / a0;
    this.a1 = (-2 * cosW) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  setPeaking(fs: number, f0: number, gainDb: number, q: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * f0) / fs;
    const cosW = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha / A;
    this.b0 = (1 + alpha * A) / a0;
    this.b1 = (-2 * cosW) / a0;
    this.b2 = (1 - alpha * A) / a0;
    this.a1 = (-2 * cosW) / a0;
    this.a2 = (1 - alpha / A) / a0;
  }

  setLowShelf(fs: number, f0: number, gainDb: number, slope = 0.9): void {
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * f0) / fs;
    const cosW = Math.cos(w0);
    const sinW = Math.sin(w0);
    const alpha = (sinW / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
    const twoRootAAlpha = 2 * Math.sqrt(A) * alpha;
    const a0 = (A + 1) + (A - 1) * cosW + twoRootAAlpha;
    this.b0 = (A * ((A + 1) - (A - 1) * cosW + twoRootAAlpha)) / a0;
    this.b1 = (2 * A * ((A - 1) - (A + 1) * cosW)) / a0;
    this.b2 = (A * ((A + 1) - (A - 1) * cosW - twoRootAAlpha)) / a0;
    this.a1 = (-2 * ((A - 1) + (A + 1) * cosW)) / a0;
    this.a2 = ((A + 1) + (A - 1) * cosW - twoRootAAlpha) / a0;
  }

  setHighShelf(fs: number, f0: number, gainDb: number, slope = 0.9): void {
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * f0) / fs;
    const cosW = Math.cos(w0);
    const sinW = Math.sin(w0);
    const alpha = (sinW / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
    const twoRootAAlpha = 2 * Math.sqrt(A) * alpha;
    const a0 = (A + 1) - (A - 1) * cosW + twoRootAAlpha;
    this.b0 = (A * ((A + 1) + (A - 1) * cosW + twoRootAAlpha)) / a0;
    this.b1 = (-2 * A * ((A - 1) + (A + 1) * cosW)) / a0;
    this.b2 = (A * ((A + 1) + (A - 1) * cosW - twoRootAAlpha)) / a0;
    this.a1 = (2 * ((A - 1) - (A + 1) * cosW)) / a0;
    this.a2 = ((A + 1) - (A - 1) * cosW - twoRootAAlpha) / a0;
  }

  // BS.1770-4 K-weighting stage 1: +4 dB high shelf at ~1.68 kHz.
  setKWeightShelf(fs: number): void {
    this.setHighShelf(fs, 1681.9744509555319, 3.99984385397, 1.0);
  }

  // BS.1770-4 K-weighting stage 2: highpass at ~38 Hz.
  setKWeightHighpass(fs: number): void {
    this.setHighpass(fs, 38.13547087602444, 0.5003270373238773);
  }
}
