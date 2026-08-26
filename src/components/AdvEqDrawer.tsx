// Advanced 6-band parametric EQ: live spectrum backdrop, combined response
// curve, draggable band handles (drag = freq/gain, wheel = Q on peaks,
// double-click = zero the band). Sits behind the macro console for the users
// who want surgical control.
import { useEffect, useRef } from 'react';
import { useStore } from '../state/store';
import { engine } from '../audio/engine';
import { Biquad } from '../audio/dsp/biquad';
import { AdvEqBand } from '../audio/dsp/params';

const FS = 48000;
const F_LO = 20;
const F_HI = 20000;
const DB_RANGE = 12;

function freqToX(f: number, w: number): number {
  return (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * w;
}
function xToFreq(x: number, w: number): number {
  return F_LO * Math.pow(F_HI / F_LO, Math.max(0, Math.min(1, x / w)));
}
function gainToY(g: number, h: number): number {
  return h / 2 - (g / DB_RANGE) * (h / 2);
}
function yToGain(y: number, h: number): number {
  return Math.max(-DB_RANGE, Math.min(DB_RANGE, ((h / 2 - y) / (h / 2)) * DB_RANGE));
}

function bandResponseDb(bands: AdvEqBand[], freqs: Float32Array): Float32Array {
  const out = new Float32Array(freqs.length);
  for (const band of bands) {
    if (!band.on || Math.abs(band.gainDb) < 0.01) continue;
    const bq = new Biquad();
    if (band.type === 'lowshelf') bq.setLowShelf(FS, band.freq, band.gainDb, 0.9);
    else if (band.type === 'highshelf') bq.setHighShelf(FS, band.freq, band.gainDb, 0.9);
    else bq.setPeaking(FS, band.freq, band.gainDb, band.q);
    for (let i = 0; i < freqs.length; i++) {
      const w = (2 * Math.PI * freqs[i]) / FS;
      const cw = Math.cos(w), sw = Math.sin(w);
      const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      const nr = bq.b0 + bq.b1 * cw + bq.b2 * c2;
      const ni = -(bq.b1 * sw + bq.b2 * s2);
      const dr = 1 + bq.a1 * cw + bq.a2 * c2;
      const di = -(bq.a1 * sw + bq.a2 * s2);
      const mag2 = (nr * nr + ni * ni) / (dr * dr + di * di);
      out[i] += 10 * Math.log10(Math.max(mag2, 1e-12));
    }
  }
  return out;
}

export function AdvEqDrawer() {
  const advEq = useStore((s) => s.advEq);
  const setAdvBand = useStore((s) => s.setAdvBand);
  const resetAdvEq = useStore((s) => s.resetAdvEq);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragBand = useRef<number>(-1);

  useEffect(() => {
    const canvas = canvasRef.current;
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

    const freqs = new Float32Array(180);
    for (let i = 0; i < freqs.length; i++) {
      freqs[i] = F_LO * Math.pow(F_HI / F_LO, i / (freqs.length - 1));
    }

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (w === 0) return;
      const bands = useStore.getState().advEq;
      const cs = getComputedStyle(document.documentElement);
      const colWell = cs.getPropertyValue('--surface-well').trim() || '#0A0B0D';
      const colHair = cs.getPropertyValue('--border-hairline').trim() || '#26292E';
      const colSignal = cs.getPropertyValue('--signal-500').trim() || '#FF4D00';
      const colSpec = cs.getPropertyValue('--graphite-400').trim() || '#878D93';

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = colWell;
      ctx.fillRect(0, 0, w, h);

      // grid: octave lines + dB rules
      ctx.fillStyle = colHair;
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        ctx.globalAlpha = f === 100 || f === 1000 || f === 10000 ? 0.9 : 0.4;
        ctx.fillRect(freqToX(f, w), 0, 1, h);
      }
      ctx.globalAlpha = 1;
      for (const db of [-6, 0, 6]) {
        ctx.globalAlpha = db === 0 ? 0.9 : 0.4;
        ctx.fillRect(0, gainToY(db, h), w, 1);
      }
      ctx.globalAlpha = 1;

      // live output spectrum backdrop
      const spec = engine.readSpectrum();
      if (spec.length > 0) {
        const nyq = engine.sampleRate / 2;
        ctx.fillStyle = colSignal;
        ctx.globalAlpha = 0.14;
        const cols = 90;
        const bw = w / cols;
        for (let c = 0; c < cols; c++) {
          const f0 = F_LO * Math.pow(F_HI / F_LO, c / cols);
          const f1 = F_LO * Math.pow(F_HI / F_LO, (c + 1) / cols);
          const i0 = Math.max(0, Math.floor((f0 / nyq) * spec.length));
          const i1 = Math.min(spec.length, Math.max(i0 + 1, Math.ceil((f1 / nyq) * spec.length)));
          let pk = 0;
          for (let i = i0; i < i1; i++) if (spec[i] > pk) pk = spec[i];
          const bh = (pk / 255) * h;
          ctx.fillRect(c * bw, h - bh, Math.max(1, bw - 1), bh);
        }
        ctx.globalAlpha = 1;
      }

      // response curve
      const resp = bandResponseDb(bands, freqs);
      ctx.strokeStyle = colSignal;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < freqs.length; i++) {
        const x = freqToX(freqs[i], w);
        const y = gainToY(resp[i], h);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // handles
      ctx.font = `8px 'IBM Plex Mono', monospace`;
      bands.forEach((b, i) => {
        const x = freqToX(b.freq, w);
        const y = gainToY(b.gainDb, h);
        ctx.fillStyle = b.on && Math.abs(b.gainDb) >= 0.05 ? colSignal : colSpec;
        ctx.fillRect(x - 4, y - 4, 8, 8);
        ctx.fillStyle = colWell;
        ctx.textBaseline = 'middle';
        ctx.fillText(`${i + 1}`, x - 2, y + 1);
      });

      // axis labels
      ctx.fillStyle = colSpec;
      ctx.textBaseline = 'bottom';
      for (const [f, label] of [[100, '100'], [1000, '1K'], [10000, '10K']] as [number, string][]) {
        ctx.fillText(label, freqToX(f, w) + 3, h - 2);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  // interactions
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const rect = () => wrap.getBoundingClientRect();

    const hit = (cx: number, cy: number): number => {
      const r = rect();
      const bands = useStore.getState().advEq;
      let best = -1, bestD = 14;
      bands.forEach((b, i) => {
        const x = freqToX(b.freq, r.width);
        const y = gainToY(b.gainDb, r.height);
        const d = Math.hypot(cx - r.left - x, cy - r.top - y);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    };

    const onDown = (e: PointerEvent) => {
      const i = hit(e.clientX, e.clientY);
      if (i >= 0) {
        dragBand.current = i;
        canvas.setPointerCapture(e.pointerId);
      }
    };
    const onMove = (e: PointerEvent) => {
      const r = rect();
      if (dragBand.current >= 0) {
        const i = dragBand.current;
        const band = useStore.getState().advEq[i];
        const freq = band.type === 'peak'
          ? Math.max(40, Math.min(18000, xToFreq(e.clientX - r.left, r.width)))
          : Math.max(40, Math.min(16000, xToFreq(e.clientX - r.left, r.width)));
        const gainDb = +yToGain(e.clientY - r.top, r.height).toFixed(1);
        useStore.getState().setAdvBand(i, { freq: Math.round(freq), gainDb });
      } else {
        canvas.style.cursor = hit(e.clientX, e.clientY) >= 0 ? 'grab' : 'crosshair';
      }
    };
    const onUp = () => { dragBand.current = -1; };
    const onWheel = (e: WheelEvent) => {
      const i = hit(e.clientX, e.clientY);
      if (i < 0) return;
      e.preventDefault();
      const band = useStore.getState().advEq[i];
      if (band.type !== 'peak') return;
      const q = +Math.max(0.3, Math.min(8, band.q * (e.deltaY < 0 ? 1.15 : 1 / 1.15))).toFixed(2);
      useStore.getState().setAdvBand(i, { q });
    };
    const onDbl = (e: MouseEvent) => {
      const i = hit(e.clientX, e.clientY);
      if (i >= 0) useStore.getState().setAdvBand(i, { gainDb: 0 });
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDbl);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDbl);
    };
  }, []);

  return (
    <div className="adveq">
      <div className="boxlabel">
        <span className="spec" style={{ color: 'var(--text-body)' }}>ADVANCED EQ</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <span className="spec">DRAG · WHEEL = Q · DBLCLK = ZERO</span>
          <button className="btn btn-sm btn-ghost" style={{ height: 18, padding: '0 6px', fontSize: 10 }} onClick={resetAdvEq}>RESET</button>
        </span>
      </div>
      <div className="adveq-canvas" ref={wrapRef}>
        <canvas ref={canvasRef} />
      </div>
      <div className="adveq-readout">
        {advEq.map((b, i) => (
          <span key={i} className="spec" style={Math.abs(b.gainDb) >= 0.05 ? { color: 'var(--text-accent)' } : undefined}>
            {i + 1}·{b.freq >= 1000 ? `${(b.freq / 1000).toFixed(1)}K` : b.freq}
            {' '}{b.gainDb >= 0 ? '+' : ''}{b.gainDb.toFixed(1)}
          </span>
        ))}
      </div>
    </div>
  );
}
