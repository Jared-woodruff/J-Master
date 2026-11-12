// AIR RESTORE — rebuilds the top of a band-limited source.
//
// Generated tracks and lossy files often stop dead at 15 or 16 kHz: nothing
// above the cut for a shelf to lift. This stage makes that band again from
// the octave under the cut, the way an exciter does: the band is rectified
// (which doubles its frequencies and follows its level sample by sample, so
// a hi-hat hit makes a hi-hat-shaped burst of air), and only what lands
// above the cut is kept and added.
//
// It is synthesis, not recovery: what the source lost is gone. What comes
// back is content with the same rhythm and level as the band below it.
// The rectifier runs 4x oversampled, so nothing folds back into the band.
import { Biquad } from './biquad';
import { Oversampler4x } from './oversampler';
import { DelayLine } from './delay';
import { OS_PRIME, recentOf } from './saturator';

/** At full amount the new band sits this far under the octave it came from, dB. */
export const RESTORE_FULL_REL_DB = -6;
/**
 * What the rectifier and its filters make of pink noise cut at 16 kHz,
 * against the octave it was made from, at unity gain (measured), dB.
 */
const RECTIFIER_REL_DB = -12.2;

class Channel {
  // Source band: the octave under the cut.
  private bp1 = new Biquad(); private bp2 = new Biquad();
  // Keeps only the new band: 4th-order high-pass at the cut.
  private hp1 = new Biquad(); private hp2 = new Biquad();
  private os = new Oversampler4x();
  readonly dry = new DelayLine(Oversampler4x.latency, OS_PRIME);
  private wetBuf = new Float32Array(256);
  private scratch = new Float32Array(OS_PRIME);

  tune(fs: number, cutHz: number): void {
    const lo = cutHz / 2;
    this.bp1.setHighpass(fs, lo, 0.54);
    this.bp2.setHighpass(fs, lo, 1.31);
    const hp = Math.min(cutHz, fs * 0.45);
    this.hp1.setHighpass(fs, hp, 0.54);
    this.hp2.setHighpass(fs, hp, 1.31);
  }

  reset(): void {
    this.bp1.reset(); this.bp2.reset(); this.hp1.reset(); this.hp2.reset();
    this.os.reset(); this.dry.reset();
  }

  /** The filters and oversampler, caught up on the last OS_PRIME samples. */
  prime(): void {
    this.bp1.reset(); this.bp2.reset(); this.hp1.reset(); this.hp2.reset(); this.os.reset();
    this.wet(recentOf(this.dry, this.scratch), 0, OS_PRIME);
  }

  /** The new band for a block, in place. */
  wet(x: Float32Array, start: number, len: number): void {
    this.bp1.processBlock(x, start, len);
    this.bp2.processBlock(x, start, len);
    const hi = this.os.up(x, start, len);
    for (let i = 0; i < hi.length; i++) if (hi[i] < 0) hi[i] = -hi[i];
    this.os.down(x, start, len);
    this.hp1.processBlock(x, start, len);
    this.hp2.processBlock(x, start, len);
  }

  /** The block with its new band added, delayed to match. */
  process(x: Float32Array, start: number, len: number, gain: number): void {
    if (this.wetBuf.length < len) this.wetBuf = new Float32Array(len);
    const w = this.wetBuf;
    for (let i = 0; i < len; i++) w[i] = x[start + i];
    this.wet(w, 0, len);
    const dry = this.dry;
    for (let i = 0; i < len; i++) x[start + i] = dry.push(x[start + i]) + gain * w[i];
  }
}

export class AirRestore {
  private l = new Channel();
  private r = new Channel();
  private amount = 0;
  private gain = 0;
  private cutHz = 16000;
  private wasOn = false;

  /** Constant, working or resting. */
  static readonly latency = Oversampler4x.latency;

  constructor(private fs: number) {
    this.l.tune(fs, this.cutHz);
    this.r.tune(fs, this.cutHz);
  }

  reset(): void { this.l.reset(); this.r.reset(); this.wasOn = false; }

  /** Where the source stops, Hz (from the source check). */
  setCutoff(hz: number): void {
    const f = Math.max(4000, Math.min(this.fs * 0.45, hz));
    if (f === this.cutHz) return;
    this.cutHz = f;
    this.l.tune(this.fs, f);
    this.r.tune(this.fs, f);
    // New filters start clean on the next block.
    this.wasOn = false;
  }

  /** 0 = off .. 1 = the new band RESTORE_FULL_REL_DB under its source octave; linear between. */
  setAmount(amount: number): void {
    this.amount = amount;
    this.gain = amount > 0.001 ? amount * Math.pow(10, (RESTORE_FULL_REL_DB - RECTIFIER_REL_DB) / 20) : 0;
  }

  get active(): boolean { return this.amount > 0.001; }

  processBlock(L: Float32Array, R: Float32Array, start: number, len: number, engaged = true): void {
    const on = this.active && engaged;
    const { l, r, gain } = this;
    if (on && !this.wasOn) { l.prime(); r.prime(); }
    this.wasOn = on;
    if (!on) {
      for (let i = start; i < start + len; i++) {
        L[i] = l.dry.push(L[i]);
        R[i] = r.dry.push(R[i]);
      }
      return;
    }
    l.process(L, start, len, gain);
    r.process(R, start, len, gain);
  }
}
