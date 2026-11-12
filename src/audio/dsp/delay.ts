// A fixed delay that also remembers what passed through it.
//
// Stages built on the 4x oversampler come with its latency. Each keeps one
// of these running beside it at all times, so the signal takes the same
// time through the stage whether it is working or resting: turning a stage
// on or off never shifts the music in time, and the chain's latency is one
// constant the renderer can compensate.

export class DelayLine {
  private buf: Float32Array;
  private pos = 0;
  private mask: number;

  /** `delay` samples of latency; remembers at least `memory` samples. */
  constructor(readonly delay: number, memory = delay) {
    let size = 1;
    while (size < Math.max(delay, memory) + 1) size <<= 1;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
  }

  reset(): void { this.buf.fill(0); this.pos = 0; }

  /** Stores `x`; returns the sample `delay` pushes ago. */
  push(x: number): number {
    this.buf[this.pos] = x;
    const out = this.buf[(this.pos - this.delay) & this.mask];
    this.pos = (this.pos + 1) & this.mask;
    return out;
  }

  /** The sample pushed `back` pushes ago (0 = the newest). */
  recent(back: number): number {
    return this.buf[(this.pos - 1 - back) & this.mask];
  }
}

/**
 * The same, for song positions (sample indices, which outgrow a 32-bit
 * float within minutes): the chain keeps each sample's position travelling
 * beside it, so the fades land on the right sample however long the stages
 * before them take.
 */
export class PositionDelay {
  private buf: Float64Array;
  private pos = 0;
  private mask: number;

  constructor(readonly delay: number) {
    let size = 1;
    while (size < delay + 1) size <<= 1;
    this.buf = new Float64Array(size);
    this.mask = size - 1;
  }

  reset(): void { this.buf.fill(0); this.pos = 0; }

  push(x: number): number {
    this.buf[this.pos] = x;
    const out = this.buf[(this.pos - this.delay) & this.mask];
    this.pos = (this.pos + 1) & this.mask;
    return out;
  }
}
