// 2x halfband interpolator/decimator stages, cascaded for 4x oversampling
// around nonlinearities.
//
// A halfband of TAPS (odd) taps, centre M = (TAPS − 1) / 2 (odd): h[M] = 0.5
// and h[M + m] = 0 for every even m ≠ 0, so the non-zero side taps sit at
// EVEN indices. Split by index parity:
//   E branch (even indices): (M + 1) taps, a real FIR.
//   O branch (odd indices): all zero except the centre h[M] = 0.5, a pure delay.
// The delay differs by direction. Interpolating, output 2j+1 takes input
// j − (M − 1)/2. Decimating, output j takes the odd input of pair
// j − (M + 1)/2. (With the same delay both ways the centre tap sits two
// samples early and each stage rolls the top octave off like cos(ω).)
//
// The two stages do different jobs. The outer one (1x ↔ 2x) decides how
// much of the audio band survives the round trip, so it is long: flat to
// 20 kHz at 48 kHz, with the fold-back from above 28 kHz down 80 dB. The
// inner one (2x ↔ 4x) only has to clear images far from the band, so it
// stays short.
//
// Everything works a block at a time on plain arrays (the per-sample
// version spent more time in calls than in arithmetic). Each filter keeps
// the tail of its input between blocks, and every output is the same sum
// in the same order wherever the block edges fall: the result does not
// depend on block size.

interface Halfband {
  /** The even-index taps, scaled so the branch's DC gain is exactly 0.5. */
  even: Float64Array;
  /** Centre index of the full filter. */
  m: number;
}

function besselI0(x: number): number {
  let sum = 1, term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 48; k++) { term *= q / (k * k); sum += term; }
  return sum;
}

function designHalfband(taps: number, beta: number): Halfband {
  const m = (taps - 1) / 2;
  const h = new Float64Array(taps);
  const i0b = besselI0(beta);
  for (let n = 0; n < taps; n++) {
    const k = n - m;
    const sinc = k === 0 ? 0.5 : Math.sin(0.5 * Math.PI * k) / (Math.PI * k);
    const r = k / (m + 1);
    h[n] = sinc * (besselI0(beta * Math.sqrt(1 - r * r)) / i0b);
  }
  const count = m + 1;
  let sideSum = 0;
  for (let n = 0; n < taps; n += 2) sideSum += h[n];
  const even = new Float64Array(count);
  for (let k = 0; k < count; k++) even[k] = (h[2 * k] * 0.5) / sideSum;
  return { even, m };
}

/** Outer stage: 63 taps, Kaiser β 7.8. −0.001 dB at 20 kHz, 80 dB stopband. */
const OUTER = designHalfband(63, 7.8);
/** Inner stage: 31 taps, Kaiser β 9. Its transition band is three octaves wide. */
const INNER = designHalfband(31, 9);

/** Upsampler by 2: n samples in, 2n out. */
class Halfband2xUp {
  private readonly even: Float64Array;
  private readonly keep: number;       // inputs remembered between blocks
  private readonly oddDelay: number;
  private work = new Float32Array(0);  // [the last `keep` inputs, this block]

  constructor(hb: Halfband) {
    this.even = hb.even;
    this.keep = hb.even.length - 1;
    this.oddDelay = (hb.m - 1) / 2;
    this.work = new Float32Array(this.keep + 256);
  }

  reset(): void { this.work.fill(0); }

  process(inp: Float32Array, off: number, n: number, out: Float32Array): void {
    const { even, keep, oddDelay } = this;
    if (this.work.length < keep + n) {
      const grown = new Float32Array(keep + n);
      grown.set(this.work.subarray(0, keep));
      this.work = grown;
    }
    const w = this.work;
    for (let i = 0; i < n; i++) w[keep + i] = inp[off + i];
    const taps = even.length;
    for (let j = 0; j < n; j++) {
      const top = keep + j;                 // the newest input for this output pair
      let acc = 0;
      for (let k = 0; k < taps; k++) acc += even[k] * w[top - k];
      out[2 * j] = 2 * acc;                 // even phase: FIR branch
      out[2 * j + 1] = w[top - oddDelay];   // odd phase: 2 · 0.5 · delay
    }
    w.copyWithin(0, n, n + keep);
  }
}

/** Downsampler by 2: 2n samples in, n out. */
class Halfband2xDown {
  private readonly even: Float64Array;
  private readonly keep: number;
  private readonly oddDelay: number;
  private workE = new Float32Array(0);
  private workO = new Float32Array(0);

  constructor(hb: Halfband) {
    this.even = hb.even;
    // The odd branch reaches one pair further back than the even taps do.
    this.keep = Math.max(hb.even.length - 1, (hb.m + 1) / 2);
    this.oddDelay = (hb.m + 1) / 2;
    this.workE = new Float32Array(this.keep + 256);
    this.workO = new Float32Array(this.keep + 256);
  }

  reset(): void { this.workE.fill(0); this.workO.fill(0); }

  process(inp: Float32Array, n: number, out: Float32Array, off: number): void {
    const { even, keep, oddDelay } = this;
    if (this.workE.length < keep + n) {
      const ge = new Float32Array(keep + n), go = new Float32Array(keep + n);
      ge.set(this.workE.subarray(0, keep));
      go.set(this.workO.subarray(0, keep));
      this.workE = ge; this.workO = go;
    }
    const we = this.workE, wo = this.workO;
    for (let j = 0; j < n; j++) { we[keep + j] = inp[2 * j]; wo[keep + j] = inp[2 * j + 1]; }
    const taps = even.length;
    for (let j = 0; j < n; j++) {
      const top = keep + j;
      let acc = 0;
      for (let k = 0; k < taps; k++) acc += even[k] * we[top - k];
      out[off + j] = acc + 0.5 * wo[top - oddDelay];
    }
    we.copyWithin(0, n, n + keep);
    wo.copyWithin(0, n, n + keep);
  }
}

/**
 * 4x oversampler for one channel. `up` hands back the block at four times
 * the rate (in a buffer of its own, valid until the next call), the caller
 * works on it in place, and `down` brings it back.
 *
 * Each filter delays by its centre index at its own rate: 31 base samples
 * for the outer pair, 7.5 for the inner. Two more samples of delay at the
 * 4x rate round the total to a whole number, so a stage built on this can
 * be matched by a plain delay line and compensated exactly.
 */
export class Oversampler4x {
  private up1 = new Halfband2xUp(OUTER);
  private up2 = new Halfband2xUp(INNER);
  private down1 = new Halfband2xDown(OUTER);
  private down2 = new Halfband2xDown(INNER);
  private mid = new Float32Array(512);
  // Two samples of headroom in front: the 4x block sits at index 2, and the
  // two samples held back from the last block go in before it.
  private hi = new Float32Array(1024 + 2);
  private held0 = 0;
  private held1 = 0;

  /** Round-trip delay in base-rate samples. */
  static readonly latency = OUTER.m + (INNER.m + 1) / 2;

  reset(): void {
    this.up1.reset(); this.up2.reset(); this.down1.reset(); this.down2.reset();
    this.held0 = 0; this.held1 = 0;
  }

  /** `len` samples of `x` from `start`, at 4x: a view of 4·len samples. */
  up(x: Float32Array, start: number, len: number): Float32Array {
    if (this.mid.length < 2 * len) {
      this.mid = new Float32Array(2 * len);
      this.hi = new Float32Array(4 * len + 2);
    }
    this.up1.process(x, start, len, this.mid);
    const hiView = this.hi.subarray(2, 2 + 4 * len);
    this.up2.process(this.mid, 0, 2 * len, hiView);
    return hiView;
  }

  /** The 4x block from the last `up` (worked on in place), back to `out`. */
  down(out: Float32Array, start: number, len: number): void {
    const hi = this.hi;
    const n4 = 4 * len;
    // Hold the last two 4x samples back one block.
    const h0 = hi[n4], h1 = hi[n4 + 1];
    hi[0] = this.held0; hi[1] = this.held1;
    this.held0 = h0; this.held1 = h1;
    this.down2.process(hi, 2 * len, this.mid, 0);
    this.down1.process(this.mid, len, out, start);
  }
}
