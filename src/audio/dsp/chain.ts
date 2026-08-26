// The J-Master chain. One class, used by BOTH the real-time worklet and the
// offline renderer, so the export is numerically the preview:
//
//   staging gain → HPF → tone tilt → shape contour → air shelf
//   → CHARACTER (saturation) → DENSITY (glue) → IMPACT (transients)
//   → WIDTH (M/S) → fades → output gain → true-peak limiter
//
// Continuous params are slewed per block (~15 ms) for a zipperless console.
import { Biquad } from './biquad';
import { Saturator } from './saturator';
import { GlueCompressor } from './compressor';
import { TransientShaper } from './transient';
import { StereoWidth } from './width';
import { Limiter } from './limiter';
import { DeHarsh } from './deharsh';
import { StemLanes } from './stemlanes';
import { fadeGainAt } from './fades';
import { ChainParams, defaultParams, dbToLin, MATCH_EQ_CENTERS } from './params';

const SLEW_MS = 15;

class Slewed {
  current: number;
  target: number;
  constructor(v: number, private coef: number) { this.current = v; this.target = v; }
  set(v: number): void { this.target = v; }
  /** Advances one block; returns true if the value moved. */
  tick(): boolean {
    const diff = this.target - this.current;
    if (Math.abs(diff) < 1e-5) {
      if (this.current !== this.target) { this.current = this.target; return true; }
      return false;
    }
    this.current += diff * this.coef;
    return true;
  }
}

export interface ChainMeters {
  compGrDb: number;
  limiterGrDb: number;
  deharshGrDb: number;
}

export class MasterChain {
  private fs: number;
  private p: ChainParams = defaultParams();

  private hpfL = new Biquad(); private hpfR = new Biquad();
  private tiltLoL = new Biquad(); private tiltLoR = new Biquad();
  private tiltHiL = new Biquad(); private tiltHiR = new Biquad();
  private shapeAL = new Biquad(); private shapeAR = new Biquad();
  private shapeBL = new Biquad(); private shapeBR = new Biquad();
  private airL = new Biquad(); private airR = new Biquad();

  // Reference-match correction EQ (static, keyed by its gain vector).
  private matchL: Biquad[] = [];
  private matchR: Biquad[] = [];
  private matchKey = '';
  // Advanced parametric EQ (static, keyed by its band spec).
  private advL: Biquad[] = [];
  private advR: Biquad[] = [];
  private advKey = '';

  private sat: Saturator;
  private comp: GlueCompressor;
  private trans: TransientShaper;
  private widthProc: StereoWidth;
  private deharsh: DeHarsh;
  private stems: StemLanes;
  private limiter: Limiter;

  private tone: Slewed;
  private shape: Slewed;
  private air: Slewed;
  private smooth: Slewed;
  private character: Slewed;
  private density: Slewed;
  private impact: Slewed;
  private width: Slewed;
  private balance: Slewed;       // dB, -3..+3
  private stagingGain: Slewed;   // linear
  private outputGain: Slewed;    // linear
  private refGain: Slewed;       // linear, REF (bypass) output gain

  readonly latency: number;

  constructor(fs: number, blockSize = 128) {
    this.fs = fs;
    const slewCoef = 1 - Math.exp(-blockSize / (fs * (SLEW_MS / 1000)));
    this.sat = new Saturator(fs);
    this.comp = new GlueCompressor(fs);
    this.trans = new TransientShaper(fs);
    this.widthProc = new StereoWidth(fs);
    this.deharsh = new DeHarsh(fs);
    this.stems = new StemLanes(fs);
    this.limiter = new Limiter(fs);
    this.latency = this.limiter.latency;

    this.hpfL.setHighpass(fs, 18, 0.707);
    this.hpfR.setHighpass(fs, 18, 0.707);

    this.tone = new Slewed(0, slewCoef);
    this.shape = new Slewed(0, slewCoef);
    this.air = new Slewed(0, slewCoef);
    this.smooth = new Slewed(0, slewCoef);
    this.character = new Slewed(0, slewCoef);
    this.density = new Slewed(0, slewCoef);
    this.impact = new Slewed(0, slewCoef);
    this.width = new Slewed(1, slewCoef);
    this.balance = new Slewed(0, slewCoef);
    this.stagingGain = new Slewed(1, slewCoef);
    this.outputGain = new Slewed(1, slewCoef);
    this.refGain = new Slewed(1, slewCoef);
    this.applyEq();
    this.limiter.setCeiling(this.p.ceilingDb);
  }

  setParams(p: ChainParams): void {
    this.p = { ...p };
    this.tone.set(p.tone);
    this.shape.set(p.shape);
    this.air.set(p.air);
    this.smooth.set(p.smooth);
    this.character.set(p.character);
    this.density.set(p.density);
    this.impact.set(p.impact);
    this.width.set(p.width);
    this.balance.set(p.balanceDb);
    this.stagingGain.set(dbToLin(p.stagingGainDb));
    this.outputGain.set(dbToLin(p.outputGainDb));
    this.refGain.set(dbToLin(p.refOutputGainDb));
    this.limiter.setCeiling(p.ceilingDb);
    this.limiter.deltaMode = p.limiterDelta && !p.bypass;
    this.widthProc.setBassMono(p.bassMono);
    this.stems.setTrims(p.stemBassDb ?? 0, p.stemDrumsDb ?? 0, p.stemVocalDb ?? 0, p.stemAirDb ?? 0);
    this.rebuildStaticEq(p);
  }

  /** Jump all slewed params straight to target (offline render start). */
  snapParams(): void {
    for (const s of [this.tone, this.shape, this.air, this.smooth, this.character, this.density, this.impact, this.width, this.balance, this.stagingGain, this.outputGain, this.refGain]) {
      s.current = s.target;
    }
    this.applyEq();
    this.applyDynamics();
  }

  reset(): void {
    for (const b of [this.hpfL, this.hpfR, this.tiltLoL, this.tiltLoR, this.tiltHiL, this.tiltHiR,
      this.shapeAL, this.shapeAR, this.shapeBL, this.shapeBR, this.airL, this.airR,
      ...this.matchL, ...this.matchR, ...this.advL, ...this.advR]) b.reset();
    this.sat.reset();
    this.comp.reset();
    this.trans.reset();
    this.widthProc.reset();
    this.deharsh.reset();
    this.stems.reset();
    this.limiter.reset();
  }

  get meters(): ChainMeters {
    return { compGrDb: this.comp.grDb, limiterGrDb: this.limiter.grDb, deharshGrDb: this.deharsh.grDb };
  }

  /** Rebuilds the match/advanced EQ banks only when their specs change. */
  private rebuildStaticEq(p: ChainParams): void {
    const fs = this.fs;
    const matchKey = (p.matchEqGains ?? []).join(',');
    if (matchKey !== this.matchKey) {
      this.matchKey = matchKey;
      this.matchL = [];
      this.matchR = [];
      const gains = p.matchEqGains ?? [];
      for (let i = 0; i < gains.length && i < MATCH_EQ_CENTERS.length; i++) {
        if (Math.abs(gains[i]) < 0.05) continue;
        const bl = new Biquad();
        const f = MATCH_EQ_CENTERS[i];
        if (i === 0) bl.setLowShelf(fs, f * 1.4, gains[i], 0.8);
        else if (i === MATCH_EQ_CENTERS.length - 1) bl.setHighShelf(fs, f * 0.8, gains[i], 0.8);
        else bl.setPeaking(fs, f, gains[i], 1.1);
        const br = new Biquad();
        br.copyCoefficientsFrom(bl);
        this.matchL.push(bl);
        this.matchR.push(br);
      }
    }
    const advKey = (p.advEq ?? [])
      .map((b) => `${b.on ? 1 : 0}:${b.type}:${b.freq.toFixed(0)}:${b.gainDb.toFixed(2)}:${b.q.toFixed(2)}`)
      .join('|');
    if (advKey !== this.advKey) {
      this.advKey = advKey;
      this.advL = [];
      this.advR = [];
      for (const band of p.advEq ?? []) {
        if (!band.on || Math.abs(band.gainDb) < 0.05) continue;
        const bl = new Biquad();
        if (band.type === 'lowshelf') bl.setLowShelf(fs, band.freq, band.gainDb, 0.9);
        else if (band.type === 'highshelf') bl.setHighShelf(fs, band.freq, band.gainDb, 0.9);
        else bl.setPeaking(fs, band.freq, band.gainDb, band.q);
        const br = new Biquad();
        br.copyCoefficientsFrom(bl);
        this.advL.push(bl);
        this.advR.push(br);
      }
    }
  }

  private applyEq(): void {
    const fs = this.fs;
    const tone = this.tone.current;
    const tiltDb = tone * 4.5;
    this.tiltLoL.setLowShelf(fs, 700, -tiltDb, 0.6);
    this.tiltHiL.setHighShelf(fs, 700, tiltDb, 0.6);
    this.tiltLoR.copyCoefficientsFrom(this.tiltLoL);
    this.tiltHiR.copyCoefficientsFrom(this.tiltHiL);

    const shape = this.shape.current;
    // Forward: presence up at 3 kHz, low-mids trimmed at 450 Hz. Scooped: inverse.
    this.shapeAL.setPeaking(fs, 3000, shape * 4, 0.9);
    this.shapeBL.setPeaking(fs, 450, -shape * 2.5, 0.9);
    this.shapeAR.copyCoefficientsFrom(this.shapeAL);
    this.shapeBR.copyCoefficientsFrom(this.shapeBL);

    this.airL.setHighShelf(fs, 13000, this.air.current * 6, 0.75);
    this.airR.copyCoefficientsFrom(this.airL);
  }

  private applyDynamics(): void {
    this.sat.setDrive(this.character.current);
    this.comp.setAmount(this.density.current);
    this.trans.setAmount(this.impact.current);
    this.widthProc.setWidth(this.width.current);
    this.deharsh.setAmount(this.smooth.current);
  }

  /**
   * Processes a block in place. `positionSamples` is the absolute song
   * position of the first sample (pre-limiter-latency), used for fades.
   */
  processBlock(L: Float32Array, R: Float32Array, start: number, len: number, positionSamples: number): void {
    const p = this.p;

    let eqDirty = false;
    eqDirty = this.tone.tick() || eqDirty;
    eqDirty = this.shape.tick() || eqDirty;
    eqDirty = this.air.tick() || eqDirty;
    if (eqDirty) this.applyEq();

    let dynDirty = false;
    dynDirty = this.character.tick() || dynDirty;
    dynDirty = this.density.tick() || dynDirty;
    dynDirty = this.impact.tick() || dynDirty;
    dynDirty = this.width.tick() || dynDirty;
    dynDirty = this.smooth.tick() || dynDirty;
    if (dynDirty) this.applyDynamics();
    this.balance.tick();
    this.stagingGain.tick();
    this.outputGain.tick();
    this.refGain.tick();

    const staging = this.stagingGain.current;
    const output = this.outputGain.current;

    if (p.bypass) {
      // Reference mode: loudness-matched raw signal through the same limiter.
      const g = staging * this.refGain.current;
      for (let i = start; i < start + len; i++) { L[i] *= g; R[i] *= g; }
      this.applyFades(L, R, start, len, positionSamples);
      this.limiter.processBlock(L, R, start, len);
      return;
    }

    for (let i = start; i < start + len; i++) { L[i] *= staging; R[i] *= staging; }

    this.hpfL.processBlock(L, start, len);
    this.hpfR.processBlock(R, start, len);
    this.tiltLoL.processBlock(L, start, len);
    this.tiltLoR.processBlock(R, start, len);
    this.tiltHiL.processBlock(L, start, len);
    this.tiltHiR.processBlock(R, start, len);
    this.shapeAL.processBlock(L, start, len);
    this.shapeAR.processBlock(R, start, len);
    this.shapeBL.processBlock(L, start, len);
    this.shapeBR.processBlock(R, start, len);
    this.airL.processBlock(L, start, len);
    this.airR.processBlock(R, start, len);

    for (let i = 0; i < this.matchL.length; i++) {
      this.matchL[i].processBlock(L, start, len);
      this.matchR[i].processBlock(R, start, len);
    }
    for (let i = 0; i < this.advL.length; i++) {
      this.advL[i].processBlock(L, start, len);
      this.advR[i].processBlock(R, start, len);
    }

    this.stems.processBlock(L, R, start, len);
    this.deharsh.processBlock(L, R, start, len);
    this.sat.processBlock(L, R, start, len);
    this.comp.processBlock(L, R, start, len);
    this.trans.processBlock(L, R, start, len);
    this.widthProc.processBlock(L, R, start, len);

    // Balance trim last, so the correction acts directly on the delivered
    // image rather than being diluted by downstream width processing.
    const balDb = this.balance.current;
    if (Math.abs(balDb) > 0.001) {
      const gL = dbToLin(-balDb / 2);
      const gR = dbToLin(balDb / 2);
      for (let i = start; i < start + len; i++) { L[i] *= gL; R[i] *= gR; }
    }

    this.applyFades(L, R, start, len, positionSamples);

    for (let i = start; i < start + len; i++) { L[i] *= output; R[i] *= output; }

    this.limiter.processBlock(L, R, start, len);
  }

  private applyFades(L: Float32Array, R: Float32Array, start: number, len: number, positionSamples: number): void {
    const p = this.p;
    if (p.fadeInSec <= 0 && p.fadeOutSec <= 0) return;
    const fs = this.fs;
    for (let i = 0; i < len; i++) {
      const posSec = (positionSamples + i) / fs;
      const g = fadeGainAt(posSec, p.fadeInSec, p.fadeOutSec, p.fadeInCurve, p.fadeOutCurve, p.songLengthSec);
      L[start + i] *= g;
      R[start + i] *= g;
    }
  }
}
