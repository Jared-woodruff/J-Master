// What the meters remember between frames: the latched true peak and its
// over count, the ticks that hold over each bar, the short-term values the
// running loudness range is read from, and the loudness of every part of
// the track that has been played. Pure: frames in, figures out, no DOM.
//
// A meter frame arrives about 47 times a second whether or not anything is
// playing. An idle frame carries silence, and nothing here moves on one:
// what the meters last read stays on the glass while the transport rests.
import type { MeterFrame } from '../audio/engine';
import { LUFS_FLOOR, OverCounter, PeakHold, ShortTermSeries, SlidingMax } from './meter-math';

/** One point of the loudness history per this much track. */
export const HISTORY_STEP_SEC = 0.25;
/** Playback that starts this close to the top is a new pass, not a resume. */
const RESTART_WINDOW_SEC = 0.35;
/** The running range means little before it has seen this much music. */
const LRA_MIN_VALUES = 50;
/** A frame every 1024 samples: three seconds of them, for the peak PSR is read against. */
const PSR_FRAMES = 141;
/** How long the low band has to sit out of phase before it is called out. */
const LOW_PHASE_WARN_SEC = 0.4;

export interface BookClock {
  /** A steady clock, seconds. */
  nowSec: number;
  sampleRate: number;
  ceilingDb: number;
  /** Where playback begins (the trim's start), seconds. */
  keepStartSec: number;
}

export class MeterBook {
  /** Loudest true peak since playback began (or since it was reset). */
  tpMax = -Infinity;
  readonly overs = new OverCounter();
  readonly holdL = new PeakHold(-200, 1.2, 14);
  readonly holdR = new PeakHold(-200, 1.2, 14);
  readonly holdSmooth = new PeakHold(0, 0.9, 8);
  readonly holdComp = new PeakHold(0, 0.9, 8);
  readonly holdClip = new PeakHold(0, 0.9, 8);
  readonly holdLimit = new PeakHold(0, 0.9, 8);

  /** Peak to short-term loudness over the last 3 s; NaN while there is nothing to read. */
  psr = NaN;
  /** Latched peak to integrated loudness; NaN until both exist. */
  plr = NaN;
  /** Running loudness range; NaN until enough has played. */
  lra = NaN;
  /** True once the low band has sat out of phase long enough to matter. */
  lowPhaseWarn = false;

  /** Short-term and momentary loudness by track position (NaN where nothing has played). */
  st: Float32Array<ArrayBuffer> = new Float32Array(0);
  mom: Float32Array<ArrayBuffer> = new Float32Array(0);
  durationSec = 0;
  /** Bumps whenever the history changes, so a display knows to redraw. */
  version = 0;

  private readonly series = new ShortTermSeries();
  private readonly recentPeak = new SlidingMax(PSR_FRAMES, -200);
  private wasLive = false;
  private lastSec: number | null = null;
  private seriesClock = 0;
  private sincePush = 0;
  private lowNegSec = 0;
  private lastBin = -1;

  /** A new track, or a new take of it: everything starts over. */
  setSource(durationSec: number): void {
    this.durationSec = Math.max(0, durationSec);
    const bins = Math.max(1, Math.ceil(this.durationSec / HISTORY_STEP_SEC));
    this.st = new Float32Array(bins).fill(NaN);
    this.mom = new Float32Array(bins).fill(NaN);
    this.lastBin = -1;
    this.wasLive = false;
    this.lastSec = null;
    this.reset();
    this.version++;
  }

  /** The latched peak, its over count and the ticks over the bars: what a click on the readout clears. */
  resetPeaks(): void {
    this.tpMax = -Infinity;
    this.overs.reset();
    for (const h of [this.holdL, this.holdR, this.holdSmooth, this.holdComp, this.holdClip, this.holdLimit]) h.reset();
    this.plr = NaN;
  }

  /** The latches, the counters and the running range (the history stays). */
  reset(): void {
    this.resetPeaks();
    this.recentPeak.reset();
    this.series.clear();
    this.seriesClock = 0;
    this.sincePush = 0;
    this.psr = NaN;
    this.plr = NaN;
    this.lra = NaN;
    this.lowNegSec = 0;
    this.lowPhaseWarn = false;
  }

  frame(m: MeterFrame, at: BookClock): void {
    const dt = this.lastSec === null ? 0 : Math.max(0, Math.min(0.25, at.nowSec - this.lastSec));
    this.lastSec = at.nowSec;
    if (m.idle) {
      this.wasLive = false;
      return;
    }
    const posSec = m.playhead / at.sampleRate;
    // From the top again (stop then play, the end then play): a new pass,
    // read on its own. A resume mid-track carries on where it was.
    if (!this.wasLive && posSec <= at.keepStartSec + RESTART_WINDOW_SEC) this.reset();
    this.wasLive = true;

    if (m.truePeakDb > this.tpMax) this.tpMax = m.truePeakDb;
    this.overs.update(m.truePeakDb, at.ceilingDb);
    this.holdL.update(m.peakLDb, dt);
    this.holdR.update(m.peakRDb, dt);
    this.holdSmooth.update(m.deharshGrDb, dt);
    this.holdComp.update(m.compGrDb, dt);
    this.holdClip.update(m.clipGrDb, dt);
    this.holdLimit.update(m.limiterGrDb, dt);

    const peak3 = this.recentPeak.push(m.truePeakDb);
    this.psr = m.shortTerm > LUFS_FLOOR && peak3 > -100 ? peak3 - m.shortTerm : NaN;
    this.plr = m.integrated > LUFS_FLOOR && this.tpMax > -100 ? this.tpMax - m.integrated : NaN;

    // Ten short-term values a second, as the offline measurement takes them.
    this.seriesClock += dt;
    while (this.seriesClock >= 0.1) {
      this.seriesClock -= 0.1;
      this.series.push(m.shortTerm);
      if (++this.sincePush >= 10) {
        this.sincePush = 0;
        this.lra = this.series.length >= LRA_MIN_VALUES ? this.series.lra() : NaN;
      }
    }

    // Only where there is bass to judge (silence reads as in phase).
    if (m.correlationLow < 0) this.lowNegSec = Math.min(2, this.lowNegSec + dt);
    else this.lowNegSec = Math.max(0, this.lowNegSec - 2 * dt);
    // Called once it has lasted, withdrawn only once it is well and truly back.
    if (this.lowNegSec >= LOW_PHASE_WARN_SEC) this.lowPhaseWarn = true;
    else if (this.lowNegSec <= 0) this.lowPhaseWarn = false;

    const bin = Math.floor(posSec / HISTORY_STEP_SEC);
    if (bin >= 0 && bin < this.st.length) {
      const mom = m.momentary > LUFS_FLOOR ? m.momentary : NaN;
      if (bin !== this.lastBin) {
        this.mom[bin] = mom;
        this.lastBin = bin;
      } else if (mom > this.mom[bin] || Number.isNaN(this.mom[bin])) {
        // The loudest moment of this pass through the bin.
        this.mom[bin] = mom;
      }
      this.st[bin] = m.shortTerm > LUFS_FLOOR ? m.shortTerm : NaN;
      this.version++;
    }
  }
}
