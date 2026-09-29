// IMPACT — transient contour. Positive: attacks are emphasised (punch).
// Negative: attacks are rounded off (soft, lofi). Stereo linked.
import { dbToLin } from './params';

export class TransientShaper {
  private fastEnv = 0;
  private slowEnv = 0;
  private gainSmDb = 0;
  private fastAtt: number;
  private fastRel: number;
  private slowAtt: number;
  private slowRel: number;
  private gAtt: number;
  private gRel: number;
  private amount = 0; // -1..1

  constructor(sampleRate: number) {
    this.fastAtt = 1 - Math.exp(-1 / (sampleRate * 0.0002));
    this.fastRel = 1 - Math.exp(-1 / (sampleRate * 0.03));
    this.slowAtt = 1 - Math.exp(-1 / (sampleRate * 0.015));
    this.slowRel = 1 - Math.exp(-1 / (sampleRate * 0.3));
    this.gAtt = 1 - Math.exp(-1 / (sampleRate * 0.0005));
    this.gRel = 1 - Math.exp(-1 / (sampleRate * 0.03));
  }

  reset(): void { this.fastEnv = 0; this.slowEnv = 0; this.gainSmDb = 0; }

  setAmount(impact: number): void { this.amount = impact; }

  get active(): boolean { return Math.abs(this.amount) > 0.001; }

  processBlock(L: Float32Array, R: Float32Array, start: number, len: number): void {
    if (!this.active) return;
    const { fastAtt, fastRel, slowAtt, slowRel, gAtt, gRel, amount } = this;
    let fastEnv = this.fastEnv, slowEnv = this.slowEnv, gainSmDb = this.gainSmDb;
    for (let i = start; i < start + len; i++) {
      const mag = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      fastEnv += (mag > fastEnv ? fastAtt : fastRel) * (mag - fastEnv);
      slowEnv += (mag > slowEnv ? slowAtt : slowRel) * (mag - slowEnv);
      // Transient measure: how far the fast envelope rises above the slow one.
      const diffDb = 20 * Math.log10((fastEnv + 1e-9) / (slowEnv + 1e-9));
      const transient = Math.min(Math.max(diffDb, 0), 10);
      const targetDb = amount * transient * 0.6; // up to ±6 dB on strong attacks
      gainSmDb += (Math.abs(targetDb) > Math.abs(gainSmDb) ? gAtt : gRel) * (targetDb - gainSmDb);
      const g = dbToLin(gainSmDb);
      L[i] *= g;
      R[i] *= g;
    }
    this.fastEnv = fastEnv; this.slowEnv = slowEnv; this.gainSmDb = gainSmDb;
  }
}
