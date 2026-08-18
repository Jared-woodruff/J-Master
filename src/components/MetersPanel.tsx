// The metering rack: LUFS momentary/short-term/integrated, true peak with
// over-lamp, compressor & limiter gain reduction, stereo correlation, and a
// live spectrum analyser.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { engine } from '../audio/engine';

const LUFS_MIN = -36;

function lufsPct(v: number): number {
  return Math.max(0, Math.min(1, (v - LUFS_MIN) / (0 - LUFS_MIN))) * 100;
}

function fmtLufs(v: number): string {
  return v <= -69 ? '—' : v.toFixed(1);
}

export function MetersPanel() {
  const meters = useStore((s) => s.meters);
  const targetLufs = useStore((s) => s.targetLufs);
  const ceilingDb = useStore((s) => s.ceilingDb);
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
    <div className="panel">
      <div className="panel-head">
        <span className="title">Meters</span>
        <span className="spec">BS.1770-4</span>
      </div>
      <div className="meters-body">
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

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (w === 0) return;
      const data = engine.readSpectrum();
      const pre = engine.readSpectrumPre();
      const s = getComputedStyle(document.documentElement);
      const colWell = s.getPropertyValue('--surface-well').trim() || '#0A0B0D';
      const colHair = s.getPropertyValue('--border-hairline').trim() || '#26292E';
      const colSignal = s.getPropertyValue('--signal-500').trim() || '#FF4D00';
      const colSrc = s.getPropertyValue('--graphite-300').trim() || '#AFB3B8';

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = colWell;
      ctx.fillRect(0, 0, w, h);

      // octave gridlines: 100 Hz, 1 kHz, 10 kHz
      ctx.fillStyle = colHair;
      for (const f of [100, 1000, 10000]) {
        const x = (Math.log10(f / 20) / Math.log10(20000 / 20)) * w;
        ctx.fillRect(x, 0, 1, h);
      }

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
