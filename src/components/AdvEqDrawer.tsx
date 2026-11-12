// Advanced 6-band parametric EQ: live spectrum backdrop, the response the
// chain will apply (drawn from the very same filters), and draggable band
// handles. Under the graph, the selected band's inspector: on/off, shape
// (shelves, bell, high-pass, low-pass), where it acts (both channels, the
// MID only, the SIDE only), and typed frequency, gain and Q.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { engine } from '../audio/engine';
import { Biquad } from '../audio/dsp/biquad';
import { tuneBand, biquadDb } from '../audio/dsp/eqband';
import { eqBandActive, type AdvEqBand, type EqBandType, type EqChannel } from '../audio/dsp/params';
import { palette } from '../lib/palette';
import { pageScrollsUnder } from '../lib/scroll';
import { parseEntry } from './Knob';

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
  return h / 2 - (Math.max(-DB_RANGE, Math.min(DB_RANGE, g)) / DB_RANGE) * (h / 2);
}
function yToGain(y: number, h: number): number {
  return Math.max(-DB_RANGE, Math.min(DB_RANGE, ((h / 2 - y) / (h / 2)) * DB_RANGE));
}

const isCut = (b: AdvEqBand) => b.type === 'highpass' || b.type === 'lowpass';

/** What the bands do to the MID and to the SIDE, in dB at each frequency. */
function responses(bands: AdvEqBand[], freqs: Float32Array): { mid: Float32Array; side: Float32Array; split: boolean } {
  const mid = new Float32Array(freqs.length);
  const side = new Float32Array(freqs.length);
  let split = false;
  const bq = new Biquad();
  for (const band of bands) {
    if (!eqBandActive(band)) continue;
    const ch = band.ch ?? 'stereo';
    if (ch !== 'stereo') split = true;
    tuneBand(bq, FS, band);
    for (let i = 0; i < freqs.length; i++) {
      const db = biquadDb(bq, FS, freqs[i]);
      if (ch !== 'side') mid[i] += db;
      if (ch !== 'mid') side[i] += db;
    }
  }
  return { mid, side, split };
}

const fmtHz = (f: number) => (f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 1 : 2)}K` : `${Math.round(f)}`);

const TYPES: { id: EqBandType; label: string; title: string }[] = [
  { id: 'highpass', label: 'HP', title: 'High-pass · 12 dB/octave: everything below goes' },
  { id: 'lowshelf', label: 'LO SHELF', title: 'Low shelf: lifts or lowers everything below' },
  { id: 'peak', label: 'BELL', title: 'Bell: a boost or cut around one frequency · Q sets how wide' },
  { id: 'highshelf', label: 'HI SHELF', title: 'High shelf: lifts or lowers everything above' },
  { id: 'lowpass', label: 'LP', title: 'Low-pass · 12 dB/octave: everything above goes' },
];
const CHANNELS: { id: EqChannel; label: string; title: string }[] = [
  { id: 'stereo', label: 'STEREO', title: 'Both channels alike' },
  { id: 'mid', label: 'MID', title: 'Only what is in the middle (the mono sum): vocal, kick, bass' },
  { id: 'side', label: 'SIDE', title: 'Only what differs between left and right: width, ambience' },
];

/** A number field that commits on Enter or on leaving it, and gives up on Esc. */
function NumField({ label, value, unit, onCommit, width = 62 }: {
  label: string; value: string; unit: string; onCommit: (v: number) => void; width?: number;
}) {
  const [text, setText] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = () => {
    if (!cancelled.current && text !== null) {
      const v = parseEntry(text.replace(/k\s*$/i, ''));
      if (Number.isFinite(v)) onCommit(/k\s*$/i.test(text) ? v * 1000 : v);
    }
    cancelled.current = false;
    setText(null);
  };
  return (
    <label className="eqfield">
      <span className="spec">{label}</span>
      <input
        type="text" inputMode="decimal" spellCheck={false} style={{ width }}
        value={text ?? value}
        aria-label={`${label} ${unit}`}
        onFocus={(e) => { setText(value); e.currentTarget.select(); }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') { cancelled.current = true; e.stopPropagation(); e.currentTarget.blur(); }
        }}
      />
      <span className="spec">{unit}</span>
    </label>
  );
}

export function AdvEqDrawer() {
  const advEq = useStore((s) => s.advEq);
  const setAdvBand = useStore((s) => s.setAdvBand);
  const resetAdvEq = useStore((s) => s.resetAdvEq);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragBand = useRef<number>(-1);
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  selectedRef.current = selected;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let w = 0, h = 0, dpr = 1;
    // Paints only when something drawn changed (or the backdrop moves).
    let prevSig: unknown[] = [];
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      w = wrap.clientWidth; h = wrap.clientHeight;
      const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      prevSig = [];
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const freqs = new Float32Array(240);
    for (let i = 0; i < freqs.length; i++) {
      freqs[i] = F_LO * Math.pow(F_HI / F_LO, i / (freqs.length - 1));
    }

    const draw = () => {
      raf = requestAnimationFrame(draw);
      // Dragged to a display with another scale: the backing store follows.
      if ((window.devicePixelRatio || 1) !== dpr) resize();
      if (w === 0) return;
      const st = useStore.getState();
      const bands = st.advEq;
      const pal = palette();
      // While playing, the live spectrum behind the curve moves every frame.
      const sig = [bands, st.playing || st.audition.active ? performance.now() : 0, w, h, dpr, pal, selectedRef.current];
      if (sig.length === prevSig.length && sig.every((v, i) => v === prevSig[i])) return;
      prevSig = sig;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = pal.well;
      ctx.fillRect(0, 0, w, h);

      // grid: octave lines + dB rules
      ctx.fillStyle = pal.hair;
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        ctx.globalAlpha = f === 100 || f === 1000 || f === 10000 ? 0.9 : 0.4;
        ctx.fillRect(Math.round(freqToX(f, w)), 0, 1, h);
      }
      for (const db of [-6, 0, 6]) {
        ctx.globalAlpha = db === 0 ? 0.9 : 0.4;
        ctx.fillRect(0, Math.round(gainToY(db, h)), w, 1);
      }
      ctx.globalAlpha = 1;

      // live output spectrum backdrop
      const spec = engine.readSpectrum();
      if (spec.length > 0) {
        const nyq = engine.sampleRate / 2;
        ctx.fillStyle = pal.signal;
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

      // response: one curve, or MID and SIDE apart once a band treats them apart
      const resp = responses(bands, freqs);
      const curve = (vals: Float32Array, colour: string, dash: number[]) => {
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.6;
        ctx.setLineDash(dash);
        ctx.beginPath();
        for (let i = 0; i < freqs.length; i++) {
          const x = freqToX(freqs[i], w);
          const y = gainToY(vals[i], h);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      };
      if (resp.split) curve(resp.side, pal.src, [4, 3]);
      curve(resp.mid, pal.signal, []);

      // handles
      ctx.font = `8px 'IBM Plex Mono', monospace`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      bands.forEach((b, i) => {
        const x = freqToX(b.freq, w);
        const y = gainToY(isCut(b) ? 0 : b.gainDb, h);
        const live = eqBandActive(b);
        if (i === selectedRef.current) {
          ctx.strokeStyle = pal.text;
          ctx.lineWidth = 1;
          ctx.strokeRect(x - 6.5, y - 6.5, 13, 13);
        }
        ctx.fillStyle = live ? pal.signal : pal.spec;
        if (!b.on) ctx.globalAlpha = 0.45;
        ctx.fillRect(x - 4, y - 4, 8, 8);
        ctx.globalAlpha = 1;
        ctx.fillStyle = pal.well;
        ctx.fillText(`${i + 1}`, x, y + 0.5);
      });
      ctx.textAlign = 'left';

      // axis labels
      ctx.fillStyle = pal.spec;
      ctx.textBaseline = 'bottom';
      for (const [f, label] of [[100, '100'], [1000, '1K'], [10000, '10K']] as [number, string][]) {
        ctx.fillText(label, freqToX(f, w) + 3, h - 2);
      }
      ctx.textBaseline = 'top';
      ctx.fillText('+6', 3, gainToY(6, h) + 2);
      ctx.fillText('−6', 3, gainToY(-6, h) + 2);
      if (resp.split) {
        ctx.textAlign = 'right';
        ctx.fillStyle = pal.signal;
        ctx.fillText('MID', w - 34, 3);
        ctx.fillStyle = pal.src;
        ctx.fillText('SIDE', w - 4, 3);
        ctx.textAlign = 'left';
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
        const y = gainToY(isCut(b) ? 0 : b.gainDb, r.height);
        const d = Math.hypot(cx - r.left - x, cy - r.top - y);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const i = hit(e.clientX, e.clientY);
      if (i >= 0) {
        dragBand.current = i;
        setSelected(i);
        canvas.setPointerCapture(e.pointerId);
      }
    };
    const onMove = (e: PointerEvent) => {
      const r = rect();
      // The button came up somewhere this never heard about.
      if (dragBand.current >= 0 && e.buttons === 0) dragBand.current = -1;
      if (dragBand.current >= 0) {
        const i = dragBand.current;
        const band = useStore.getState().advEq[i];
        const freq = Math.round(Math.max(20, Math.min(20000, xToFreq(e.clientX - r.left, r.width))));
        // A high-pass or low-pass has no gain to drag: it only moves along.
        const patch: Partial<AdvEqBand> = isCut(band)
          ? { freq }
          : { freq, gainDb: +yToGain(e.clientY - r.top, r.height).toFixed(1) };
        useStore.getState().setAdvBand(i, patch);
      } else {
        canvas.style.cursor = hit(e.clientX, e.clientY) >= 0 ? 'grab' : 'crosshair';
      }
    };
    const onUp = () => { dragBand.current = -1; };
    const onWheel = (e: WheelEvent) => {
      const i = hit(e.clientX, e.clientY);
      if (i < 0 || e.ctrlKey) return;
      // Where the page scrolls, the wheel only turns Q on the band already
      // chosen: a scroll that happens to pass over a handle keeps scrolling.
      if (pageScrollsUnder(canvas) && i !== selectedRef.current) return;
      const band = useStore.getState().advEq[i];
      if (band.type !== 'peak') return;
      // Shift turns a vertical wheel into a horizontal one: take whichever moved.
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (d === 0) return;
      e.preventDefault();
      const k = e.shiftKey ? 1.05 : 1.15;
      const q = +Math.max(0.3, Math.min(8, band.q * (d < 0 ? k : 1 / k))).toFixed(2);
      useStore.getState().setAdvBand(i, { q });
    };
    const onDbl = (e: MouseEvent) => {
      const i = hit(e.clientX, e.clientY);
      if (i < 0) return;
      const band = useStore.getState().advEq[i];
      // A cut has no gain to zero: double-click takes it out instead.
      useStore.getState().setAdvBand(i, isCut(band) ? { on: !band.on } : { gainDb: 0 });
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('lostpointercapture', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDbl);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('lostpointercapture', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDbl);
    };
  }, []);

  const band = advEq[selected] ?? advEq[0];
  const cut = isCut(band);
  const setType = (type: EqBandType) => {
    // Becoming a cut switches the band on (a cut with the band off is nothing).
    setAdvBand(selected, type === 'highpass' || type === 'lowpass' ? { type, on: true } : { type });
  };

  return (
    <div className="adveq">
      <div className="boxlabel">
        <span className="spec" style={{ color: 'var(--text-body)' }}>ADVANCED EQ</span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <span className="spec hide-narrow">DRAG A BAND · WHEEL = Q · DOUBLE-CLICK = ZERO</span>
          <button className="btn btn-sm btn-ghost" style={{ height: 18, padding: '0 6px', fontSize: 10 }}
            title="Every band back to flat" onClick={resetAdvEq}>RESET</button>
        </span>
      </div>
      <div className="adveq-canvas" ref={wrapRef}>
        <canvas ref={canvasRef} style={{ touchAction: 'none' }} aria-hidden="true" />
      </div>
      <div className="eqbands" role="tablist" aria-label="EQ bands">
        {advEq.map((b, i) => (
          <button key={i} role="tab" aria-selected={i === selected}
            className={`eqband ${i === selected ? 'on' : ''} ${eqBandActive(b) ? 'live' : ''}`}
            title={`Band ${i + 1} · click to edit it below`}
            onClick={() => setSelected(i)}>
            <span className="n">{i + 1}</span>
            <span className="v">
              {fmtHz(b.freq)}
              {isCut(b) ? ` ${b.type === 'highpass' ? 'HP' : 'LP'}` : ` ${b.gainDb >= 0 ? '+' : ''}${b.gainDb.toFixed(1)}`}
              {(b.ch ?? 'stereo') !== 'stereo' ? ` ${b.ch === 'mid' ? 'M' : 'S'}` : ''}
            </span>
          </button>
        ))}
      </div>
      <div className="eqinspect" role="group" aria-label={`Band ${selected + 1}`}>
        <button className={`btn btn-sm btn-toggle ${band.on ? 'on' : ''}`} aria-pressed={band.on}
          title={band.on ? 'This band is in · click to take it out' : 'This band is out · click to bring it in'}
          onClick={() => setAdvBand(selected, { on: !band.on })}>
          <span className={`lamp ${band.on ? 'signal' : ''}`} />
          {band.on ? 'IN' : 'OUT'}
        </button>
        <div className="seg" role="group" aria-label="Band shape">
          {TYPES.map((t) => (
            <button key={t.id} className={band.type === t.id ? 'on' : ''} aria-pressed={band.type === t.id}
              title={t.title} onClick={() => setType(t.id)}>{t.label}</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Acts on">
          {CHANNELS.map((c) => (
            <button key={c.id} className={(band.ch ?? 'stereo') === c.id ? 'on' : ''} aria-pressed={(band.ch ?? 'stereo') === c.id}
              title={c.title} onClick={() => setAdvBand(selected, { ch: c.id })}>{c.label}</button>
          ))}
        </div>
        <NumField label="FREQ" unit="HZ" value={`${Math.round(band.freq)}`}
          onCommit={(v) => setAdvBand(selected, { freq: Math.round(Math.max(20, Math.min(20000, v))) })} />
        {!cut && (
          <NumField label="GAIN" unit="DB" width={54} value={band.gainDb.toFixed(1)}
            onCommit={(v) => setAdvBand(selected, { gainDb: +Math.max(-DB_RANGE, Math.min(DB_RANGE, v)).toFixed(1) })} />
        )}
        {band.type === 'peak' && (
          <NumField label="Q" unit="" width={48} value={band.q.toFixed(2)}
            onCommit={(v) => setAdvBand(selected, { q: +Math.max(0.3, Math.min(8, v)).toFixed(2) })} />
        )}
      </div>
    </div>
  );
}
