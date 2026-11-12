// J-Master real-time processor. The worklet IS the playback source: it holds
// the full song, tracks the playhead sample-accurately, runs the MasterChain,
// and reports meters. Transport is driven by port messages.
import { MasterChain } from '../dsp/chain';
import { LoudnessMeter } from '../dsp/loudness';
import { TruePeakDetector } from '../dsp/limiter';
import { Biquad } from '../dsp/biquad';
import { ChainParams, defaultParams, dbToLin, keptRange } from '../dsp/params';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const METER_INTERVAL = 1024; // samples between meter frames (~21 ms @ 48k)
const MAX_SPANS = 8;
/** After a jump (a seek, a play from stop), the sound comes up over this many samples. */
const DECLICK = 240;

class JMasterProcessor extends AudioWorkletProcessor {
  private chain = new MasterChain(sampleRate, 128);
  private meter = new LoudnessMeter(sampleRate);
  private tpL = new TruePeakDetector();
  private tpR = new TruePeakDetector();
  private srcL: Float32Array | null = null;
  private srcR: Float32Array | null = null;
  private playing = false;
  private playhead = 0;
  private loopStart = -1;
  private loopEnd = -1;   // loop active when loopEnd > loopStart >= 0
  private normGain = 1;   // current platform-preview gain (linear, ramped)
  private params: ChainParams = defaultParams();
  private meterCountdown = METER_INTERVAL;
  private framePeak = 0;
  private framePeakL = 0;
  private framePeakR = 0;
  // Gain reduction is read once a block; a frame reports the deepest.
  private frameClipGr = 0;
  private frameCompGr = 0;
  private frameLimGr = 0;
  private frameDeharshGr = 0;
  private corrLR = 0;
  private corrLL = 1e-12;
  private corrRR = 1e-12;
  private corrCoef = 1 - Math.exp(-128 / (sampleRate * 0.3));
  // The same below 150 Hz: where a mono fold-down loses its bass.
  private lowL = new Biquad();
  private lowR = new Biquad();
  private lowLR = 0;
  private lowLL = 1e-12;
  private lowRR = 1e-12;
  // The part of the song a trim keeps, in samples: [keepStart, keepEnd).
  private keepStart = 0;
  private keepEnd = 0;
  /** Samples of the chain's tail still to play out after the song's last sample (−1: not at the end). */
  private drain = -1;
  /** Samples since the chain last started from clean (a load, a seek, a stop). */
  private sinceClean = 0;

  // Metronome click buffers (accent = bar start).
  private clickBeat: Float32Array;
  private clickAccent: Float32Array;
  private clickActive: Float32Array | null = null;
  private clickIdx = 0;
  // A drifting track's tracked beats (sample positions); null = fixed grid.
  private clickBeats: Float64Array | null = null;
  private clickDownbeat = 0;
  // Source runs behind the current block, as [output offset, source start,
  // length] triples: more than one when a loop wraps mid-block.
  private spans = new Int32Array(3 * MAX_SPANS);
  private spanCount = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => this.onMessage(e.data);
    const mkClick = (freq: number): Float32Array => {
      const len = Math.round(sampleRate * 0.02);
      const buf = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        buf[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * Math.exp(-i / (len * 0.28)) * 0.24;
      }
      return buf;
    };
    this.clickBeat = mkClick(1047);
    this.clickAccent = mkClick(1568);
    this.lowL.setLowpass(sampleRate, 150, 0.707);
    this.lowR.setLowpass(sampleRate, 150, 0.707);
  }

  /** Where playback starts and ends: the trim's range, or the whole song. */
  private setRange(): void {
    const total = this.srcL ? this.srcL.length : 0;
    const [a, b] = keptRange({ ...this.params, songLengthSec: total / sampleRate });
    this.keepStart = Math.min(total, Math.round(a * sampleRate));
    this.keepEnd = Math.max(this.keepStart, Math.min(total, Math.round(b * sampleRate)));
  }

  /**
   * The chain starts over from nothing: what it was still holding belongs
   * to the place the playhead just left. The sound then comes up over a few
   * milliseconds instead of cutting in.
   */
  private clean(): void {
    this.chain.reset();
    this.meter.reset();
    this.tpL.reset();
    this.tpR.reset();
    this.sinceClean = 0;
    this.drain = -1;
    this.clickActive = null;
  }

  private onMessage(msg: any): void {
    switch (msg.type) {
      case 'load':
        this.srcL = new Float32Array(msg.l);
        this.srcR = new Float32Array(msg.r);
        this.playhead = 0;
        this.playing = false;
        this.loopStart = -1;
        this.loopEnd = -1;
        this.clickBeats = null;
        this.clean();
        this.setRange();
        break;
      case 'beats':
        this.clickBeats = msg.beats && msg.beats.length > 0
          ? Float64Array.from(msg.beats as number[], (s) => s * sampleRate)
          : null;
        this.clickDownbeat = msg.downbeat ?? 0;
        break;
      case 'loop':
        if (msg.start === null || msg.end === null || !Number.isFinite(msg.start) || !Number.isFinite(msg.end)) {
          this.loopStart = -1;
          this.loopEnd = -1;
        } else {
          const len = this.srcL ? this.srcL.length : 0;
          this.loopStart = Math.max(0, Math.round(msg.start));
          this.loopEnd = Math.min(len, Math.round(msg.end));
          if (this.loopEnd <= this.loopStart) { this.loopStart = -1; this.loopEnd = -1; }
        }
        break;
      case 'params':
        this.params = msg.params;
        this.chain.setParams(this.params);
        // Nothing is sounding: a setting made while stopped is simply in
        // place when play starts (it used to glide in over the first 40 ms).
        if (!this.playing) this.chain.snapParams();
        this.setRange();
        break;
      case 'play':
        // From the end (or from outside a trim), play starts over.
        if (this.drain >= 0 || this.playhead >= this.keepEnd || this.playhead < this.keepStart) {
          this.playhead = this.keepStart;
          this.clean();
        }
        this.playing = true;
        break;
      case 'pause':
        this.playing = false;
        break;
      case 'seek': {
        if (!Number.isFinite(msg.sample)) break;
        const len = this.srcL ? this.srcL.length : 0;
        this.playhead = Math.max(0, Math.min(len, Math.round(msg.sample)));
        this.clean();
        break;
      }
      case 'stop':
        this.playing = false;
        this.playhead = this.keepStart;
        this.clean();
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : out[0];
    // Second output: the untouched source at matched loudness, feeding the
    // "before" spectrum analyser. Never routed to the speakers.
    const pre = outputs.length > 1 ? outputs[1] : null;
    const preL = pre ? pre[0] : null;
    const preR = pre && pre.length > 1 ? pre[1] : preL;
    const n = outL.length;

    if (!this.srcL || !this.srcR || !this.playing) {
      outL.fill(0);
      outR.fill(0);
      if (preL) preL.fill(0);
      if (preR) preR.fill(0);
      this.tickMeterClock(n, true);
      return true;
    }

    const srcL = this.srcL, srcR = this.srcR;
    // Playback ends where the trim does.
    const total = this.keepEnd;
    const start = this.playhead;
    // Copy source, wrapping seamlessly at the loop point mid-block if needed.
    const loopOn = this.loopStart >= 0 && this.loopEnd > this.loopStart;
    let pos = start;
    let written = 0;
    this.spanCount = 0;
    while (written < n) {
      const limit = loopOn && pos < this.loopEnd ? this.loopEnd : total;
      const chunk = Math.min(n - written, limit - pos);
      if (chunk <= 0) break; // end of track
      for (let i = 0; i < chunk; i++) {
        outL[written + i] = srcL[pos + i];
        outR[written + i] = srcR[pos + i];
      }
      if (this.spanCount < MAX_SPANS) {
        const s = 3 * this.spanCount++;
        this.spans[s] = written;
        this.spans[s + 1] = pos;
        this.spans[s + 2] = chunk;
      }
      written += chunk;
      pos += chunk;
      if (loopOn && pos >= this.loopEnd) pos = this.loopStart;
    }
    for (let i = written; i < n; i++) { outL[i] = 0; outR[i] = 0; }

    if (preL && preR) {
      const g = dbToLin(this.params.stagingGainDb + this.params.refOutputGainDb);
      for (let i = 0; i < n; i++) {
        preL[i] = outL[i] * g;
        preR[i] = outR[i] * g;
      }
    }

    // Fades follow the source positions run by run, so a loop that wraps
    // mid-block fades (or doesn't) exactly where the song does.
    this.chain.processBlock(outL, outR, 0, n, start, this.spans, this.spanCount);
    this.playhead = pos;
    {
      const m = this.chain.meters;
      if (m.clipGrDb > this.frameClipGr) this.frameClipGr = m.clipGrDb;
      if (m.compGrDb > this.frameCompGr) this.frameCompGr = m.compGrDb;
      if (m.limiterGrDb > this.frameLimGr) this.frameLimGr = m.limiterGrDb;
      if (m.deharshGrDb > this.frameDeharshGr) this.frameDeharshGr = m.deharshGrDb;
    }

    // Coming up from clean: silence while the chain's delay fills, then a
    // short rise, so a seek into the middle of a note doesn't click.
    const lat = this.chain.latency;
    if (this.sinceClean < lat + DECLICK) {
      let k = this.sinceClean;
      for (let i = 0; i < n && k < lat + DECLICK; i++, k++) {
        const t = k < lat ? 0 : (k - lat) / DECLICK;
        const g = t * t * (3 - 2 * t);
        outL[i] *= g;
        outR[i] *= g;
      }
    }
    this.sinceClean += n;

    // Monitor matrix (worklet-only, never in a render): fold or solo AFTER
    // the chain, BEFORE metering, so the meters read what you hear.
    const mon = this.params.monitor ?? 'stereo';
    if (mon !== 'stereo') {
      for (let i = 0; i < n; i++) {
        const l = outL[i], r = outR[i];
        if (mon === 'mono') { const m = 0.5 * (l + r); outL[i] = m; outR[i] = m; }
        else if (mon === 'side') { const s = 0.5 * (l - r); outL[i] = s; outR[i] = s; }
        else if (mon === 'left') { outR[i] = l; }
        else { outL[i] = r; }
      }
    }

    // Metering on the processed output.
    this.meter.processBlock(outL, outR, 0, n);
    {
      // Only a new maximum for the frame matters, so each detector skips
      // whatever can't be one.
      let pkL = this.framePeakL, pkR = this.framePeakR;
      for (let i = 0; i < n; i++) {
        const a = this.tpL.process(outL[i], pkL);
        if (a > pkL) pkL = a;
        const b = this.tpR.process(outR[i], pkR);
        if (b > pkR) pkR = b;
      }
      this.framePeakL = pkL; this.framePeakR = pkR;
      this.framePeak = pkL > pkR ? pkL : pkR;
    }
    // Stereo correlation (smoothed), full band and below 150 Hz.
    let lr = 0, ll = 0, rr = 0, blr = 0, bll = 0, brr = 0;
    const { lowL, lowR } = this;
    for (let i = 0; i < n; i++) {
      const l = outL[i], r = outR[i];
      lr += l * r; ll += l * l; rr += r * r;
      const bl = lowL.process(l), br = lowR.process(r);
      blr += bl * br; bll += bl * bl; brr += br * br;
    }
    this.corrLR += this.corrCoef * (lr - this.corrLR);
    this.corrLL += this.corrCoef * (ll - this.corrLL);
    this.corrRR += this.corrCoef * (rr - this.corrRR);
    this.lowLR += this.corrCoef * (blr - this.lowLR);
    this.lowLL += this.corrCoef * (bll - this.lowLL);
    this.lowRR += this.corrCoef * (brr - this.lowRR);

    // The song's last sample has gone in: the chain still holds its tail,
    // which plays out before the transport stops.
    if (written < n) {
      if (this.drain < 0) this.drain = lat;
      this.drain -= n - written;
      if (this.drain <= 0) {
        this.playing = false;
        this.port.postMessage({ type: 'ended' });
      }
    }

    // Platform-normalization preview: playback level only, after the
    // meters (they keep reading the master), and on the "before" feed too
    // so the spectrum compare stays level. Ramped per block: no clicks.
    const normTarget = dbToLin(Math.min(0, this.params.monitorGainDb ?? 0));
    if (normTarget !== 1 || this.normGain !== 1) {
      const g0 = this.normGain;
      const step = (normTarget - g0) / n;
      const scalePre = preL && preR && preL !== preR;
      for (let i = 0; i < n; i++) {
        const g = g0 + step * (i + 1);
        outL[i] *= g;
        outR[i] *= g;
        if (scalePre) { preL![i] *= g; preR![i] *= g; }
      }
      this.normGain = normTarget;
    }

    // Metronome: mixed in after every meter tap so readings stay honest.
    this.mixClick(outL, outR, n, lat);

    this.tickMeterClock(n, false);
    return true;
  }

  /**
   * Clicks are placed on source positions, run by run, so when a loop wraps
   * mid-block the loop's first beat still clicks, with its own accent. A
   * drifting track clicks on its tracked beats; others on the fixed grid.
   * Each click waits out the chain's delay, to land with the beat it marks.
   */
  private mixClick(outL: Float32Array, outR: Float32Array, n: number, lat: number): void {
    const p = this.params;
    if (!p.metronome || !p.gridBpm || p.gridBpm <= 0) {
      this.clickActive = null;
      return;
    }
    const beats = this.clickBeats;
    const period = (sampleRate * 60) / p.gridBpm;
    const firstBeat = p.gridFirstBeatSec * sampleRate;
    let i = 0;
    for (let s = 0; s < this.spanCount; s++) {
      const off = this.spans[3 * s];
      // The position now SOUNDING at the head of this run.
      const src = this.spans[3 * s + 1] - lat;
      const end = off + this.spans[3 * s + 2];
      // The first beat after the sample before this run. (At or after this
      // run's first sample would skip a beat that falls in the fraction of
      // a sample between two runs: one click every 15 s at 128 BPM.)
      let k: number;
      if (beats) {
        let lo = 0, hi = beats.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (beats[mid] <= src - 1) lo = mid + 1; else hi = mid;
        }
        k = lo;
      } else {
        k = Math.max(0, Math.floor((src - 1 - firstBeat) / period) + 1);
      }
      let next = beats ? (k < beats.length ? beats[k] : Infinity) : firstBeat + k * period;
      for (; i < end; i++) {
        if (src + (i - off) >= next) {
          const bar = beats ? k - this.clickDownbeat : k;
          this.clickActive = ((bar % 4) + 4) % 4 === 0 ? this.clickAccent : this.clickBeat;
          this.clickIdx = 0;
          k++;
          next = beats ? (k < beats.length ? beats[k] : Infinity) : firstBeat + k * period;
        }
        this.clickTail(outL, outR, i);
      }
    }
    // Past the end of the track: let a sounding click finish.
    for (; i < n; i++) this.clickTail(outL, outR, i);
  }

  private clickTail(outL: Float32Array, outR: Float32Array, i: number): void {
    if (this.clickActive && this.clickIdx < this.clickActive.length) {
      const c = this.clickActive[this.clickIdx++];
      outL[i] += c;
      outR[i] += c;
    }
  }

  private tickMeterClock(n: number, idle: boolean): void {
    this.meterCountdown -= n;
    if (this.meterCountdown > 0) return;
    this.meterCountdown = METER_INTERVAL;
    const denom = Math.sqrt(this.corrLL * this.corrRR);
    const lowDenom = Math.sqrt(this.lowLL * this.lowRR);
    const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-10));
    this.port.postMessage({
      type: 'meters',
      playhead: this.playhead,
      playing: this.playing,
      idle,
      momentary: this.meter.momentary,
      shortTerm: this.meter.shortTerm,
      integrated: this.meter.integrated,
      truePeakDb: db(this.framePeak),
      peakLDb: db(this.framePeakL),
      peakRDb: db(this.framePeakR),
      compGrDb: this.frameCompGr,
      limiterGrDb: this.frameLimGr,
      deharshGrDb: this.frameDeharshGr,
      clipGrDb: this.frameClipGr,
      correlation: denom > 1e-9 ? this.corrLR / denom : 1,
      // Nothing down there to judge reads as in phase.
      correlationLow: lowDenom > 1e-7 ? this.lowLR / lowDenom : 1,
    });
    this.framePeak = 0;
    this.framePeakL = 0;
    this.framePeakR = 0;
    this.frameClipGr = 0;
    this.frameCompGr = 0;
    this.frameLimGr = 0;
    this.frameDeharshGr = 0;
  }
}

registerProcessor('jmaster-processor', JMasterProcessor);
