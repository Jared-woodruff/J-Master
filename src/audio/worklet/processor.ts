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
        this.chain.reset();
        this.meter.reset();
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
    while (written < n) {
      const limit = loopOn && pos < this.loopEnd ? this.loopEnd : total;
      const chunk = Math.min(n - written, limit - pos);
      if (chunk <= 0) break; // end of track
      for (let i = 0; i < chunk; i++) {
        outL[written + i] = srcL[pos + i];
        outR[written + i] = srcR[pos + i];
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

    // Metronome: mixed in after every meter tap so readings stay honest.
    this.mixClick(outL, outR, n, start);

    this.tickMeterClock(n, false);
    return true;
  }

  private mixClick(outL: Float32Array, outR: Float32Array, n: number, blockStart: number): void {
    const p = this.params;
    if (!p.metronome || !p.gridBpm || p.gridBpm <= 0) {
      this.clickActive = null;
      return;
    }
    const period = (sampleRate * 60) / p.gridBpm;
    const firstBeat = p.gridFirstBeatSec * sampleRate;
    // Beats whose start falls inside this block.
    let k = Math.ceil((blockStart - firstBeat) / period);
    if (k < 0) k = 0;
    let nextBeat = firstBeat + k * period;
    for (let i = 0; i < n; i++) {
      const pos = blockStart + i;
      if (pos >= nextBeat) {
        this.clickActive = k % 4 === 0 ? this.clickAccent : this.clickBeat;
        this.clickIdx = 0;
        k++;
        nextBeat = firstBeat + k * period;
      }
      if (this.clickActive && this.clickIdx < this.clickActive.length) {
        const c = this.clickActive[this.clickIdx++];
        outL[i] += c;
        outR[i] += c;
      }
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
