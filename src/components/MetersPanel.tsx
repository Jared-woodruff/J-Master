// The metering rack: LUFS momentary/short-term/integrated, true peak with
// over-lamp, compressor & limiter gain reduction, stereo correlation, and a
// live spectrum analyser.
import { useEffect, useRef, useState } from 'react';
import { useStore, normPreviewGainDb } from '../state/store';
import { engine } from '../audio/engine';
import { palette } from '../lib/palette';
import { PLATFORMS } from '../audio/dsp/params';

const LUFS_MIN = -36;

function lufsPct(v: number): number {
  return Math.max(0, Math.min(1, (v - LUFS_MIN) / (0 - LUFS_MIN))) * 100;
}

function fmtLufs(v: number): string {
  return v <= -69 ? '—' : v.toFixed(1);
}

// Distinct normalization behaviours: -14 turn-down (Spotify, YouTube) and
// Apple's -16.
const NORM_PLATFORMS = [
  { id: null, label: 'OFF', name: '' },
  { id: 'spotify', label: 'SPOTIFY', name: 'Spotify' },
  { id: 'apple', label: 'APPLE', name: 'Apple Music' },
  { id: 'youtube', label: 'YOUTUBE', name: 'YouTube' },
] as const;

const MONITOR_MODES = [
  { id: 'stereo', label: 'ST' },
  { id: 'mono', label: 'MONO' },
  { id: 'side', label: 'SIDE' },
  { id: 'left', label: 'L' },
  { id: 'right', label: 'R' },
] as const;

export function MetersPanel() {
  const meters = useStore((s) => s.meters);
  const targetLufs = useStore((s) => s.targetLufs);
  const ceilingDb = useStore((s) => s.ceilingDb);
  const monitor = useStore((s) => s.monitor);
  const setMonitor = useStore((s) => s.setMonitor);
  const normPreview = useStore((s) => s.normPreview);
  const setNormPreview = useStore((s) => s.setNormPreview);
  const normGainDb = useStore(normPreviewGainDb);
  const [tpHold, setTpHold] = useState(-70);

  useEffect(() => {
    if (!meters) return;
    setTpHold((h) => {
      if (meters.truePeakDb > h) return meters.truePeakDb;
      // Decay the hold only while playing; freeze the reading when stopped.
      return meters.playing ? Math.max(-70, h - 0.06) : h;
    });
  }, [meters]);

  const m = meters;
  const tpOver = tpHold > ceilingDb + 0.05;
  const targetPct = lufsPct(targetLufs);

  return (
    <div className="panel panel-meters">
      <div className="panel-head">
        <span className="title">Meters</span>
        <span className="spec">BS.1770-4</span>
      </div>
      <div className="meters-body">
        <div className="seg mon-seg" role="group" aria-label="Monitor matrix">
          {MONITOR_MODES.map((mode) => (
            <button
              key={mode.id}
              className={monitor === mode.id ? 'on' : ''}
              title={mode.id === 'stereo'
                ? 'Monitor the stereo master'
                : `Monitor ${mode.id === 'mono' ? 'the mono fold-down' : mode.id === 'side' ? 'the side signal only' : `the ${mode.id} channel only`} (never exported)`}
              onClick={() => setMonitor(mode.id)}
            >{mode.label}</button>
          ))}
          <span className="spec monlabel">MON</span>
        </div>
        <div className="seg mon-seg" role="group" aria-label="Hear it as a streaming platform plays it">
          {NORM_PLATFORMS.map((p) => {
            const plat = p.id ? PLATFORMS.find((x) => x.id === p.id) : null;
            const turn = plat ? Math.min(0, plat.targetLufs - targetLufs) : 0;
            return (
              <button
                key={p.label}
                className={normPreview === p.id ? 'on' : ''}
                title={plat
                  ? `Hear it as ${p.name} plays it: ${turn < 0 ? `turned down ${Math.abs(turn).toFixed(1)} dB to ${plat.targetLufs} LUFS` : 'plays as mastered'} · playback only, never exported`
                  : 'Hear the master at its own level'}
                onClick={() => setNormPreview(p.id)}
              >{p.label}</button>
            );
          })}
          <span className="spec monlabel" title="Loudness-normalization preview">NORM</span>
        </div>
        {normPreview && (
          <div className="spec normnote">
            {normGainDb < -0.05
              ? <>PLAYBACK TURNED DOWN <span style={{ color: 'var(--text-accent)' }}>{Math.abs(normGainDb).toFixed(1)} DB</span></>
              : 'PLAYS AS MASTERED AT THIS TARGET'}
          </div>
        )}
        <MeterLine label="M" value={m ? fmtLufs(m.momentary) : '—'} pct={m ? lufsPct(m.momentary) : 0} markPct={targetPct} accent />
        <MeterLine label="S" value={m ? fmtLufs(m.shortTerm) : '—'} pct={m ? lufsPct(m.shortTerm) : 0} markPct={targetPct} accent />
        <MeterLine label="I" value={m ? fmtLufs(m.integrated) : '—'} pct={m ? lufsPct(m.integrated) : 0} markPct={targetPct} accent />
        <div className="meter-line">
          <span className="spec mlabel">TP</span>
          <div className="meter-track">
            <div className="meter-fill accent" style={{ width: `${Math.max(0, Math.min(100, ((tpHold + 24) / 24) * 100))}%` }} />
            <div className="meter-mark" style={{ left: `${((ceilingDb + 24) / 24) * 100}%` }} />
          </div>
          <span className="mval">{tpHold <= -69 ? '—' : tpHold.toFixed(1)}</span>
          <span className={`lamp ${tpOver ? 'fault' : m?.playing ? 'run' : ''}`} title={tpOver ? 'True-peak over ceiling' : 'OK'} />
        </div>

        <div className="meter-sep" />

        <MeterLine label="GR·S" value={m ? `-${m.deharshGrDb.toFixed(1)}` : '—'} pct={m ? Math.min(100, (m.deharshGrDb / 6) * 100) : 0} warn />
        <MeterLine label="GR·C" value={m ? `-${m.compGrDb.toFixed(1)}` : '—'} pct={m ? Math.min(100, (m.compGrDb / 12) * 100) : 0} warn />
        <MeterLine label="GR·L" value={m ? `-${m.limiterGrDb.toFixed(1)}` : '—'} pct={m ? Math.min(100, (m.limiterGrDb / 12) * 100) : 0} warn />

        <div className="meter-line">
          <span className="spec mlabel">Φ</span>
          <div className="meter-track">
            <div className="meter-mark" style={{ left: '50%' }} />
            <div
              className={`meter-fill ${m && m.correlation < 0 ? 'warn' : 'accent'}`}
              style={m
                ? m.correlation >= 0
                  ? { left: '50%', width: `${(m.correlation * 50).toFixed(1)}%` }
                  : { left: `${(50 + m.correlation * 50).toFixed(1)}%`, width: `${(-m.correlation * 50).toFixed(1)}%` }
                : { width: 0 }}
            />
          </div>
          <span className="mval">{m ? m.correlation.toFixed(2) : '—'}</span>
        </div>

        <div className="meter-sep" />
        <div className="boxlabel">
          <span className="spec">SPECTRUM</span>
          <span className="spec">
            <span style={{ color: 'var(--signal-500)' }}>■</span> OUT&nbsp;&nbsp;
            <span style={{ color: 'var(--text-secondary)' }}>—</span> SRC
          </span>
        </div>
        <Spectrum />
      </div>
    </div>
  );
}

function MeterLine({ label, value, pct, markPct, accent, warn }: {
  label: string; value: string; pct: number; markPct?: number; accent?: boolean; warn?: boolean;
}) {
  return (
    <div className="meter-line">
      <span className="spec mlabel">{label}</span>
      <div className="meter-track">
        <div className={`meter-fill ${warn ? 'warn' : accent ? 'accent' : ''}`} style={{ width: `${pct}%` }} />
        {markPct !== undefined && <div className="meter-mark" style={{ left: `${markPct}%` }} />}
      </div>
      <span className="mval">{value}</span>
    </div>
  );
}

const BANDS = 56;

function Spectrum() {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let w = 0, h = 0, dpr = 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      w = wrap.clientWidth; h = wrap.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const smoothed = new Float32Array(BANDS);
    const smoothedPre = new Float32Array(BANDS);

    const bandPeak = (data: Uint8Array, b: number): number => {
      const nyquist = engine.sampleRate / 2;
      const f0 = 20 * Math.pow(20000 / 20, b / BANDS);
      const f1 = 20 * Math.pow(20000 / 20, (b + 1) / BANDS);
      const i0 = Math.max(0, Math.floor((f0 / nyquist) * data.length));
      const i1 = Math.min(data.length, Math.max(i0 + 1, Math.ceil((f1 / nyquist) * data.length)));
      let peak = 0;
      for (let i = i0; i < i1; i++) if (data[i] > peak) peak = data[i];
      return peak / 255;
    };

    // Freeze the analyser painting shortly after playback stops: the FFT
    // data is static then, so repainting it 60x/s is pure waste.
    let idleFrames = 0;
    let lastPal: unknown = null;
    let lastW = 0, lastH = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (w === 0) return;
      const pal = palette();
      const playing = useStore.getState().playing;
      if (!playing && idleFrames > 5 && pal === lastPal && w === lastW && h === lastH) return;
      idleFrames = playing ? 0 : idleFrames + 1;
      lastPal = pal;
      lastW = w; lastH = h;
      const hook = (window as any).__jmaster;
      if (hook) hook.spectrumDraws = (hook.spectrumDraws | 0) + 1;
      const data = engine.readSpectrum();
      const pre = engine.readSpectrumPre();
      const colWell = pal.well;
      const colHair = pal.hair;
      const colSignal = pal.signal;
      const colSrc = pal.src;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = colWell;
      ctx.fillRect(0, 0, w, h);

      // decade gridlines: 100 Hz, 1 kHz, 10 kHz (labels paint last, on top)
      const decades: [number, string][] = [[100, '100'], [1000, '1K'], [10000, '10K']];
      const decadeX = (f: number) => (Math.log10(f / 20) / Math.log10(20000 / 20)) * w;
      ctx.fillStyle = colHair;
      for (const [f] of decades) ctx.fillRect(decadeX(f), 0, 1, h);

      const barW = w / BANDS;
      if (data.length > 0) {
        // OUT: solid signal bars
        for (let b = 0; b < BANDS; b++) {
          const target = bandPeak(data, b);
          smoothed[b] += (target - smoothed[b]) * (target > smoothed[b] ? 0.5 : 0.12);
          const bh = smoothed[b] * (h - 4);
          ctx.fillStyle = colSignal;
          ctx.globalAlpha = 0.92;
          ctx.fillRect(b * barW + 0.5, h - bh, Math.max(1, barW - 1), bh);
          ctx.globalAlpha = 1;
        }
      }
      if (pre.length > 0) {
        // SRC: outline over the top, loudness-matched by the worklet
        ctx.strokeStyle = colSrc;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let b = 0; b < BANDS; b++) {
          const target = bandPeak(pre, b);
          smoothedPre[b] += (target - smoothedPre[b]) * (target > smoothedPre[b] ? 0.5 : 0.12);
          const y = h - smoothedPre[b] * (h - 4);
          const x = b * barW + barW / 2;
          if (b === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Frequency labels on a well-coloured chip so bars never swallow them.
      ctx.font = `8px 'IBM Plex Mono', monospace`;
      ctx.textBaseline = 'top';
      for (const [f, label] of decades) {
        const x = decadeX(f) + 3;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = colWell;
        ctx.globalAlpha = 0.75;
        ctx.fillRect(x - 1, 2, tw + 2, 10);
        ctx.globalAlpha = 1;
        ctx.fillStyle = pal.spec;
        ctx.fillText(label, x, 3);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return (
    <div className="spectrum-wrap" ref={wrapRef}>
      <canvas ref={ref} />
    </div>
  );
}
