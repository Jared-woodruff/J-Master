// The J-Master chain. One class, used by BOTH the real-time worklet and the
// offline renderer, so the export is numerically the preview:
//
//   staging gain → HPF → AIR RESTORE → tone tilt → shape contour → air shelf
//   → match EQ → advanced EQ (stereo / mid / side bands) → STEM LANES
//   → SMOOTH → CHARACTER (saturation) → DENSITY (glue) → IMPACT (transients)
//   → WIDTH (M/S) → balance → trim + fades → output gain → CLIP → limiter
//
// Continuous params are slewed per block (~15 ms) for a zipperless console.
//
// Three stages run 4x oversampled (AIR RESTORE, CHARACTER, CLIP) and each
// costs the oversampler's delay. They keep that delay whether they are
// working or resting, so the chain's latency never moves; the fades follow
// each sample's own song position, carried through the same delay.
import { Biquad } from './biquad';
import { Saturator } from './saturator';
import { GlueCompressor } from './compressor';
import { TransientShaper } from './transient';
import { StereoWidth } from './width';
import { Limiter } from './limiter';
import { DeHarsh } from './deharsh';
import { StemLanes } from './stemlanes';
import { AirRestore } from './exciter';
import { Clipper } from './clipper';
import { PositionDelay } from './delay';
import { fadeGainAt } from './fades';
import {
  ChainParams, defaultParams, dbToLin, defaultAdvEq, eqBandActive, keptRange, MATCH_EQ_CENTERS,
  type AdvEqBand, type EqChannel,
} from './params';
import { tuneBand } from './eqband';

const SLEW_MS = 15;
/** A trimmed edge with no fade of its own gets this ramp, so a cut mid-sound can't click. */
export const TRIM_EDGE_SEC = 0.003;

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
  clipGrDb: number;
}

/** Gain of the trim and the fades at a song position (seconds of the source). */
export function trimFadeGain(
  sec: number,
  p: Pick<ChainParams, 'fadeInSec' | 'fadeOutSec' | 'fadeInCurve' | 'fadeOutCurve' | 'songLengthSec' | 'trimStartSec' | 'trimEndSec'>,
): number {
  const [start, end] = keptRange(p);
  const trimmedStart = start > 0;
  const trimmedEnd = p.songLengthSec > 0 && end < p.songLengthSec;
  if (trimmedStart && sec < start) return 0;
  if (trimmedEnd && sec >= end) return 0;
  let g = fadeGainAt(sec - start, p.fadeInSec, p.fadeOutSec, p.fadeInCurve, p.fadeOutCurve, end - start);
  if (trimmedStart && sec - start < TRIM_EDGE_SEC) {
    const t = (sec - start) / TRIM_EDGE_SEC;
    g *= t * t * (3 - 2 * t);
  }
  if (trimmedEnd && end - sec < TRIM_EDGE_SEC) {
    const t = Math.max(0, (end - sec) / TRIM_EDGE_SEC);
    g *= t * t * (3 - 2 * t);
  }
  return g;
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

  // Reference-match correction EQ and the advanced parametric EQ: one
  // filter per band for the chain's life. A change retunes coefficients in
  // place and keeps the filter state, so dragging a band never thumps the
  // others; a band at 0 dB is skipped, and starts clean when it returns.
  private matchL = MATCH_EQ_CENTERS.map(() => new Biquad());
  private matchR = MATCH_EQ_CENTERS.map(() => new Biquad());
  private matchOn = MATCH_EQ_CENTERS.map(() => false);
  private matchKey = '';
  // A stereo band uses the pair; a mid or side band uses the first of it.
  private advL = defaultAdvEq().map(() => new Biquad());
  private advR = defaultAdvEq().map(() => new Biquad());
  private advOn = defaultAdvEq().map(() => false);
  private advCh: EqChannel[] = defaultAdvEq().map(() => 'stereo');
  private advShape: string[] = defaultAdvEq().map(() => '');
  private advKey = '';

  private restoreProc: AirRestore;
  private sat: Saturator;
  private comp: GlueCompressor;
  private trans: TransientShaper;
  private widthProc: StereoWidth;
  private deharsh: DeHarsh;
  private stems: StemLanes;
  private clip = new Clipper();
  private limiter: Limiter;
  /** Each sample's song position, delayed as the audio is by the time it fades. */
  private posDelay = new PositionDelay(AirRestore.latency + Saturator.latency);

  private tone: Slewed;
  private shape: Slewed;
  private air: Slewed;
  private smooth: Slewed;
  private character: Slewed;
  private density: Slewed;
  private impact: Slewed;
  private width: Slewed;
  private restore: Slewed;
  private balance: Slewed;       // dB, -3..+3
  private stagingGain: Slewed;   // linear
  private outputGain: Slewed;    // linear
  private refGain: Slewed;       // linear, REF (bypass) output gain

  /** Samples from input to output: the same at every setting. */
  readonly latency: number;

  /** False when the chain runs without its output stages (offline). */
  private readonly useLimiter: boolean;
  private readonly useClipper: boolean;

  /**
   * `limiter: false` and `clipper: false` leave the output stages out:
   * offline renders run the chain up to the output gain and then solve the
   * loudness through a clipper and limiter of their own.
   */
  constructor(fs: number, blockSize = 128, opts: { limiter?: boolean; clipper?: boolean } = {}) {
    this.fs = fs;
    const slewCoef = 1 - Math.exp(-blockSize / (fs * (SLEW_MS / 1000)));
    this.restoreProc = new AirRestore(fs);
    this.sat = new Saturator(fs);
    this.comp = new GlueCompressor(fs);
    this.trans = new TransientShaper(fs);
    this.widthProc = new StereoWidth(fs);
    this.deharsh = new DeHarsh(fs);
    this.stems = new StemLanes(fs);
    this.limiter = new Limiter(fs);
    this.useLimiter = opts.limiter ?? true;
    this.useClipper = opts.clipper ?? true;
    this.latency = AirRestore.latency + Saturator.latency
      + (this.useClipper ? Clipper.latency : 0)
      + (this.useLimiter ? this.limiter.latency : 0);

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
    this.restore = new Slewed(0, slewCoef);
    this.balance = new Slewed(0, slewCoef);
    this.stagingGain = new Slewed(1, slewCoef);
    this.outputGain = new Slewed(1, slewCoef);
    this.refGain = new Slewed(1, slewCoef);
    this.applyEq();
    this.limiter.setCeiling(this.p.ceilingDb);
    this.clip.setCeiling(this.p.ceilingDb);
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
    this.restore.set(p.airRestore ?? 0);
    this.balance.set(p.balanceDb);
    this.stagingGain.set(dbToLin(p.stagingGainDb));
    this.outputGain.set(dbToLin(p.outputGainDb));
    this.refGain.set(dbToLin(p.refOutputGainDb));
    this.limiter.setCeiling(p.ceilingDb);
    this.limiter.deltaMode = p.limiterDelta && !p.bypass;
    this.clip.setCeiling(p.ceilingDb);
    this.clip.setMode(p.clipMode ?? 'off');
    this.restoreProc.setCutoff(p.airRestoreHz ?? 16000);
    this.widthProc.setBassMono(p.bassMono);
    this.stems.setTrims(p.stemBassDb ?? 0, p.stemDrumsDb ?? 0, p.stemVocalDb ?? 0, p.stemAirDb ?? 0);
    this.rebuildStaticEq(p);
  }

  private slewed(): Slewed[] {
    return [this.tone, this.shape, this.air, this.smooth, this.character, this.density, this.impact,
      this.width, this.restore, this.balance, this.stagingGain, this.outputGain, this.refGain];
  }

  /** Jump all slewed params straight to target (offline render start). */
  snapParams(): void {
    for (const s of this.slewed()) s.current = s.target;
    this.applyEq();
    this.applyDynamics();
  }

  reset(): void {
    for (const b of [this.hpfL, this.hpfR, this.tiltLoL, this.tiltLoR, this.tiltHiL, this.tiltHiR,
      this.shapeAL, this.shapeAR, this.shapeBL, this.shapeBR, this.airL, this.airR,
      ...this.matchL, ...this.matchR, ...this.advL, ...this.advR]) b.reset();
    this.restoreProc.reset();
    this.sat.reset();
    this.comp.reset();
    this.trans.reset();
    this.widthProc.reset();
    this.deharsh.reset();
    this.stems.reset();
    this.clip.reset();
    this.limiter.reset();
    this.posDelay.reset();
  }

  get meters(): ChainMeters {
    return {
      compGrDb: this.comp.grDb, limiterGrDb: this.limiter.grDb,
      deharshGrDb: this.deharsh.grDb, clipGrDb: this.clip.grDb,
    };
  }

  /** Retunes the match/advanced EQ banks when their specs change. */
  private rebuildStaticEq(p: ChainParams): void {
    const fs = this.fs;
    const matchKey = (p.matchEqGains ?? []).join(',');
    if (matchKey !== this.matchKey) {
      this.matchKey = matchKey;
      const gains = p.matchEqGains ?? [];
      for (let i = 0; i < MATCH_EQ_CENTERS.length; i++) {
        const g = gains[i] ?? 0;
        const on = Math.abs(g) >= 0.05;
        const bl = this.matchL[i], br = this.matchR[i];
        if (on && !this.matchOn[i]) { bl.reset(); br.reset(); }
        this.matchOn[i] = on;
        if (!on) continue;
        const f = MATCH_EQ_CENTERS[i];
        if (i === 0) bl.setLowShelf(fs, f * 1.4, g, 0.8);
        else if (i === MATCH_EQ_CENTERS.length - 1) bl.setHighShelf(fs, f * 0.8, g, 0.8);
        else bl.setPeaking(fs, f, g, 1.1);
        br.copyCoefficientsFrom(bl);
      }
    }
    const bands = p.advEq ?? [];
    const advKey = bands
      .map((b) => `${b.on ? 1 : 0}:${b.type}:${b.ch ?? 'stereo'}:${b.freq.toFixed(0)}:${b.gainDb.toFixed(2)}:${b.q.toFixed(2)}`)
      .join('|');
    if (advKey !== this.advKey) {
      this.advKey = advKey;
      for (let i = 0; i < this.advL.length; i++) {
        const band = bands[i];
        const on = eqBandActive(band);
        const bl = this.advL[i], br = this.advR[i];
        const ch: EqChannel = band?.ch ?? 'stereo';
        // A band that returns, or changes what it is, starts clean: its old
        // state belongs to another filter (or another signal).
        const shape = band ? `${band.type}:${ch}` : '';
        if (on && (!this.advOn[i] || shape !== this.advShape[i])) { bl.reset(); br.reset(); }
        this.advOn[i] = on;
        this.advCh[i] = ch;
        this.advShape[i] = shape;
        if (!on) continue;
        tuneBand(bl, fs, band);
        br.copyCoefficientsFrom(bl);
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
    this.restoreProc.setAmount(this.restore.current);
  }

  /**
   * Processes a block in place. `positionSamples` is the absolute song
   * position of the first sample going IN (the trim and fades find their
   * place from it, however late the sample comes out).
   * A block that wraps a loop passes its runs instead: `spans` holds
   * [block offset, source position, length] per run, `spanCount` of them.
   */
  processBlock(
    L: Float32Array, R: Float32Array, start: number, len: number, positionSamples: number,
    spans?: ArrayLike<number>, spanCount = 0,
  ): void {
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
    dynDirty = this.restore.tick() || dynDirty;
    if (dynDirty) this.applyDynamics();
    this.balance.tick();
    this.stagingGain.tick();
    this.outputGain.tick();
    this.refGain.tick();

    const staging = this.stagingGain.current;
    const output = this.outputGain.current;

    // The channels themselves, repaired first (REF hears the repair too:
    // it is the source as it should have arrived).
    const fix = p.sourceFix;
    if (fix === 'left') { for (let i = start; i < start + len; i++) R[i] = L[i]; }
    else if (fix === 'right') { for (let i = start; i < start + len; i++) L[i] = R[i]; }
    else if (fix === 'flip') { for (let i = start; i < start + len; i++) R[i] = -R[i]; }

    if (p.bypass) {
      // Reference mode: the loudness-matched raw signal through the same
      // limiter, and through the same delays, so REF and the master play
      // in step.
      const g = staging * this.refGain.current;
      for (let i = start; i < start + len; i++) { L[i] *= g; R[i] *= g; }
      this.restoreProc.processBlock(L, R, start, len, false);
      this.sat.processBlock(L, R, start, len, false);
      this.applyTrimFades(L, R, start, len, positionSamples, spans, spanCount);
      if (this.useClipper) this.clip.processBlock(L, R, start, len, false);
      if (this.useLimiter) this.limiter.processBlock(L, R, start, len);
      return;
    }

    for (let i = start; i < start + len; i++) { L[i] *= staging; R[i] *= staging; }

    this.hpfL.processBlock(L, start, len);
    this.hpfR.processBlock(R, start, len);
    this.restoreProc.processBlock(L, R, start, len);
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
      if (!this.matchOn[i]) continue;
      this.matchL[i].processBlock(L, start, len);
      this.matchR[i].processBlock(R, start, len);
    }
    for (let i = 0; i < this.advL.length; i++) {
      if (!this.advOn[i]) continue;
      const ch = this.advCh[i];
      if (ch === 'stereo') {
        this.advL[i].processBlock(L, start, len);
        this.advR[i].processBlock(R, start, len);
      } else {
        // Mid or side only: the filter's change to that component goes
        // back onto both channels (with the sides' sign for a side band).
        const bq = this.advL[i];
        const sgn = ch === 'mid' ? 1 : -1;
        for (let k = start; k < start + len; k++) {
          const c = 0.5 * (L[k] + sgn * R[k]);
          const d = bq.process(c) - c;
          L[k] += d;
          R[k] += sgn * d;
        }
      }
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

    this.applyTrimFades(L, R, start, len, positionSamples, spans, spanCount);

    for (let i = start; i < start + len; i++) { L[i] *= output; R[i] *= output; }

    if (this.useClipper) this.clip.processBlock(L, R, start, len);
    if (this.useLimiter) this.limiter.processBlock(L, R, start, len);
  }

  /**
   * The trim and the fades. Every input sample's song position goes into a
   * delay as long as the stages before this one; what comes out is the
   * position of the sample now at hand. Positions come run by run when a
   * loop wraps in the block, so the loop fades exactly where the song does.
   */
  private applyTrimFades(
    L: Float32Array, R: Float32Array, start: number, len: number, positionSamples: number,
    spans: ArrayLike<number> | undefined, spanCount: number,
  ): void {
    const p = this.p;
    const shaped = p.fadeInSec > 0 || p.fadeOutSec > 0 || p.trimStartSec > 0 || p.trimEndSec > 0;
    const fs = this.fs;
    const delay = this.posDelay;
    const run = (off: number, n: number, pos: number) => {
      if (!shaped) {
        for (let i = 0; i < n; i++) delay.push(pos + i);
        return;
      }
      for (let i = 0; i < n; i++) {
        const g = trimFadeGain(delay.push(pos + i) / fs, p);
        L[off + i] *= g;
        R[off + i] *= g;
      }
    };
    if (!spans || spanCount <= 1) { run(start, len, positionSamples); return; }
    let done = 0;
    for (let k = 0; k < spanCount; k++) {
      const n = spans[3 * k + 2];
      run(start + spans[3 * k], n, spans[3 * k + 1]);
      done += n;
    }
    // Past the last run (the end of the song): positions carry on.
    if (done < len) run(start + done, len - done, positionSamples + done);
  }
}
