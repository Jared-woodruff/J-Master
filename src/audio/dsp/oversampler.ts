// 2x halfband interpolator/decimator stages, cascaded for 4x oversampling
// around nonlinearities.
//
// Halfband design, TAPS = 31 (odd), centre M = 15: h[M] = 0.5 and h[M+m] = 0
// for all even m ≠ 0. The non-zero side taps therefore sit at EVEN indices.
// Polyphase split by index parity gives:
//   E branch (even indices): 16 non-zero taps — a real FIR.
//   O branch (odd indices): all zero except the centre h[15] = 0.5 — a pure delay.

const TAPS = 31;
const M = (TAPS - 1) / 2; // 15
const EV = 16;            // number of even-index taps
const ODD_DELAY = 7;      // (15 - 1) / 2 — centre tap position within the odd branch

function designEvenTaps(): Float64Array {
  const h = new Float64Array(TAPS);
  for (let n = 0; n < TAPS; n++) {
    const m = n - M;
    const sinc = m === 0 ? 0.5 : Math.sin(0.5 * Math.PI * m) / (Math.PI * m);
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * n) / (TAPS - 1)) +
      0.08 * Math.cos((4 * Math.PI * n) / (TAPS - 1));
    h[n] = sinc * w;
  }
  // Normalize overall DC gain to exactly 1 (h[M] stays 0.5 by construction,
  // so scale side taps to make the even-branch DC gain exactly 0.5).
  let sideSum = 0;
  for (let n = 0; n < TAPS; n += 2) sideSum += h[n];
  const scale = 0.5 / sideSum;
  const even = new Float64Array(EV);
  for (let k = 0; k < EV; k++) even[k] = h[2 * k] * scale;
  return even;
}

const HE = designEvenTaps();

/** Upsampler by 2: one input sample in, two output samples out. */
class Halfband2xUp {
  private hist = new Float32Array(EV);
  private pos = 0;

  reset(): void { this.hist.fill(0); this.pos = 0; }

  process(x: number, out: Float32Array, o: number): void {
    const hist = this.hist;
    hist[this.pos] = x;
    let acc = 0;
    for (let k = 0; k < EV; k++) {
      acc += HE[k] * hist[(this.pos - k + EV) % EV];
    }
    out[o] = 2 * acc;                                   // even phase: FIR branch
    out[o + 1] = hist[(this.pos - ODD_DELAY + EV) % EV]; // odd phase: 2 · 0.5 · delay
    this.pos = (this.pos + 1) % EV;
  }
}

/** Downsampler by 2: two input samples in, one output sample out. */
class Halfband2xDown {
  private histE = new Float32Array(EV);
  private histO = new Float32Array(EV);
  private pos = 0;

  reset(): void { this.histE.fill(0); this.histO.fill(0); this.pos = 0; }

  process(x0: number, x1: number): number {
    const { histE, histO } = this;
    histE[this.pos] = x0;
    histO[this.pos] = x1;
    let acc = 0;
    for (let k = 0; k < EV; k++) {
      acc += HE[k] * histE[(this.pos - k + EV) % EV];
    }
    acc += 0.5 * histO[(this.pos - ODD_DELAY + EV) % EV];
    this.pos = (this.pos + 1) % EV;
    return acc;
  }
}

/** 4x oversampler for one channel: fn is applied per-sample at 4x rate. */
export class Oversampler4x {
  private up1 = new Halfband2xUp();
  private up2 = new Halfband2xUp();
  private down1 = new Halfband2xDown();
  private down2 = new Halfband2xDown();
  private mid = new Float32Array(2);
  private hi = new Float32Array(4);

  reset(): void {
    this.up1.reset(); this.up2.reset(); this.down1.reset(); this.down2.reset();
  }

  process(x: number, fn: (s: number) => number): number {
    const { mid, hi } = this;
    this.up1.process(x, mid, 0);
    this.up2.process(mid[0], hi, 0);
    this.up2.process(mid[1], hi, 2);
    hi[0] = fn(hi[0]); hi[1] = fn(hi[1]); hi[2] = fn(hi[2]); hi[3] = fn(hi[3]);
    const d0 = this.down2.process(hi[0], hi[1]);
    const d1 = this.down2.process(hi[2], hi[3]);
    return this.down1.process(d0, d1);
  }
}
