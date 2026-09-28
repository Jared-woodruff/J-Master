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
