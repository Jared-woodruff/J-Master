// J-Master real-time processor. The worklet IS the playback source: it holds
// the full song, tracks the playhead sample-accurately, runs the MasterChain,
// and reports meters. Transport is driven by port messages.
import { MasterChain } from '../dsp/chain';
import { LoudnessMeter } from '../dsp/loudness';
import { TruePeakDetector } from '../dsp/limiter';
import { ChainParams, defaultParams, dbToLin } from '../dsp/params';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const METER_INTERVAL = 1024; // samples between meter frames (~21 ms @ 48k)
const MAX_SPANS = 8;

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
  private corrLR = 0;
  private corrLL = 1e-12;
  private corrRR = 1e-12;
  private corrCoef = 1 - Math.exp(-128 / (sampleRate * 0.3));

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
        this.chain.reset();
        this.meter.reset();
        break;
      case 'beats':
        this.clickBeats = msg.beats && msg.beats.length > 0
          ? Float64Array.from(msg.beats as number[], (s) => s * sampleRate)
          : null;
        this.clickDownbeat = msg.downbeat ?? 0;
        break;
      case 'loop':
        if (msg.start === null || msg.end === null) {
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
        break;
      case 'play':
        this.playing = true;
        break;
      case 'pause':
        this.playing = false;
        break;
      case 'seek': {
        const len = this.srcL ? this.srcL.length : 0;
        this.playhead = Math.max(0, Math.min(len, Math.round(msg.sample)));
        // Position jump: clear time-dependent state so meters/dynamics resettle.
        this.meter.reset();
        break;
      }
      case 'stop':
        this.playing = false;
        this.playhead = 0;
        this.meter.reset();
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
    const total = srcL.length;
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

    this.chain.processBlock(outL, outR, 0, n, start);
    this.playhead = pos;

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
    for (let i = 0; i < n; i++) {
      const p = Math.max(this.tpL.process(outL[i]), this.tpR.process(outR[i]));
      if (p > this.framePeak) this.framePeak = p;
    }
    // Stereo correlation (smoothed).
    let lr = 0, ll = 0, rr = 0;
    for (let i = 0; i < n; i++) { lr += outL[i] * outR[i]; ll += outL[i] * outL[i]; rr += outR[i] * outR[i]; }
    this.corrLR += this.corrCoef * (lr - this.corrLR);
    this.corrLL += this.corrCoef * (ll - this.corrLL);
    this.corrRR += this.corrCoef * (rr - this.corrRR);

    if (this.playhead >= total && written < n) {
      this.playing = false;
      this.port.postMessage({ type: 'ended' });
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
    this.mixClick(outL, outR, n);

    this.tickMeterClock(n, false);
    return true;
  }

  /**
   * Clicks are placed on source positions, run by run, so when a loop wraps
   * mid-block the loop's first beat still clicks, with its own accent. A
   * drifting track clicks on its tracked beats; others on the fixed grid.
   */
  private mixClick(outL: Float32Array, outR: Float32Array, n: number): void {
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
      const src = this.spans[3 * s + 1];
      const end = off + this.spans[3 * s + 2];
      // First beat at or after this run's first source sample.
      let k: number;
      if (beats) {
        let lo = 0, hi = beats.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (beats[mid] < src) lo = mid + 1; else hi = mid;
        }
        k = lo;
      } else {
        k = Math.max(0, Math.ceil((src - firstBeat) / period));
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
    const meters = this.chain.meters;
    this.port.postMessage({
      type: 'meters',
      playhead: this.playhead,
      playing: this.playing,
      idle,
      momentary: this.meter.momentary,
      shortTerm: this.meter.shortTerm,
      integrated: this.meter.integrated,
      truePeakDb: 20 * Math.log10(Math.max(this.framePeak, 1e-10)),
      compGrDb: meters.compGrDb,
      limiterGrDb: meters.limiterGrDb,
      deharshGrDb: meters.deharshGrDb,
      correlation: denom > 1e-9 ? this.corrLR / denom : 1,
    });
    this.framePeak = 0;
  }
}

registerProcessor('jmaster-processor', JMasterProcessor);
