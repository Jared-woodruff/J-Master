/**
 * A radix-2 FFT of one size with its bit-reversal order and twiddles
 * computed once: for work that runs thousands of transforms of the same
 * length (the drift-repair phase vocoder).
 */
export class FftPlan {
  readonly n: number;
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;

  constructor(n: number) {
    this.n = n;
    this.rev = new Uint32Array(n);
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      this.rev[i] = j;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      this.cos[k] = Math.cos((-2 * Math.PI * k) / n);
      this.sin[k] = Math.sin((-2 * Math.PI * k) / n);
    }
  }

  /** In place, forward (e^{-iωt}); for the inverse, conjugate in and out and divide by n. */
  forward(re: Float64Array, im: Float64Array): void {
    const { n, rev, cos, sin } = this;
    for (let i = 1; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0, t = 0; j < half; j++, t += step) {
          const a = i + j, b = a + half;
          const wr = cos[t], wi = sin[t];
          const bR = re[b] * wr - im[b] * wi;
          const bI = re[b] * wi + im[b] * wr;
          re[b] = re[a] - bR; im[b] = im[a] - bI;
          re[a] += bR; im[a] += bI;
        }
      }
    }
  }
}

/** In-place iterative radix-2 complex FFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1, curI = 0;
      for (let j = 0; j < len / 2; j++) {
        const aR = re[i + j], aI = im[i + j];
        const bR = re[i + j + len / 2] * curR - im[i + j + len / 2] * curI;
        const bI = re[i + j + len / 2] * curI + im[i + j + len / 2] * curR;
        re[i + j] = aR + bR;
        im[i + j] = aI + bI;
        re[i + j + len / 2] = aR - bR;
        im[i + j + len / 2] = aI - bI;
        const nR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nR;
      }
    }
  }
}
