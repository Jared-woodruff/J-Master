import { useCallback, useEffect, useRef, useState } from 'react';
import { pageScrollsUnder } from '../lib/scroll';

interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  /** Value arc grows from 12 o'clock instead of the left stop. */
  bipolarFrom?: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  size?: number;
  /** Display units per raw unit for typed entry (100 when shown as %). */
  entryScale?: number;
  /**
   * The smallest change the control keeps (a lane trim keeps 0.1 dB). Fine
   * steps from the wheel and the arrows never fall under it, so Shift can't
   * turn them into no movement at all.
   */
  step?: number;
}

const SWEEP = 270; // degrees, -135..+135

function angleFor(value: number, min: number, max: number): number {
  const t = (value - min) / (max - min);
  return -135 + t * SWEEP;
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.01) return '';
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** A typed number however a keyboard writes it: "1,5", "−3", "+2 dB". */
export function parseEntry(text: string): number {
  const t = text.replace(/[−–—]/g, '-').replace(',', '.').replace(/[^\d.+-]/g, '');
  return parseFloat(t);
}

export function Knob({
  label, value, min, max, defaultValue, bipolarFrom, format, onChange, size = 58, entryScale = 1, step,
}: KnobProps) {
  // A drag adds up the movement of each event, so changing to fine (Shift)
  // half-way carries on from where the knob is instead of jumping.
  const drag = useRef<{ lastY: number; startVal: number; travel: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  // Lit while held, like a console control under your hand.
  const [grabbed, setGrabbed] = useState(false);

  const snap = useCallback((v: number) => {
    const c = clamp(v, min, max);
    return step ? clamp(Math.round(c / step) * step, min, max) : c;
  }, [min, max, step]);

  const commitEntry = useCallback((text: string) => {
    setEditing(false);
    if (cancelled.current) { cancelled.current = false; return; }
    const parsed = parseEntry(text);
    if (!Number.isFinite(parsed)) return;
    onChange(snap(parsed / entryScale));
  }, [entryScale, snap, onChange]);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    // On the knob itself, never on whichever arc was under the pointer:
    // an arc can leave the tree mid-drag and take the capture with it.
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { lastY: e.clientY, startVal: value, travel: 0 };
    setGrabbed(true);
  }, [value]);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    // The button came up somewhere this never heard about: the drag is over.
    if (e.buttons === 0) { drag.current = null; setGrabbed(false); return; }
    const fine = e.shiftKey ? 0.18 : 1;
    d.travel += ((d.lastY - e.clientY) / 160) * (max - min) * fine;
    d.lastY = e.clientY;
    // Past a stop the knob holds there, and comes back as soon as the hand does.
    d.travel = clamp(d.startVal + d.travel, min, max) - d.startVal;
    onChange(snap(d.startVal + d.travel));
  }, [max, min, onChange, snap]);

  const onPointerUp = useCallback(() => { drag.current = null; setGrabbed(false); }, []);

  const nudge = useCallback((dir: 1 | -1, fineKey: boolean, from: number) => {
    const coarse = (max - min) / (fineKey ? 200 : 50);
    return snap(from + dir * Math.max(coarse, step ?? 0));
  }, [max, min, snap, step]);

  // Wheel over a knob turns it and nothing else: React's wheel handlers are
  // passive and can't stop the panel scrolling too, so this one is native.
  // Where the page itself scrolls, the wheel stays the page's unless the
  // knob has the focus: scrolling past a knob must not turn it.
  const svgRef = useRef<SVGSVGElement>(null);
  const latest = useRef({ value, onChange, nudge });
  latest.current = { value, onChange, nudge };
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (d === 0 || e.ctrlKey) return;
      if (document.activeElement !== el && pageScrollsUnder(el)) return;
      e.preventDefault();
      const k = latest.current;
      k.onChange(k.nudge(d < 0 ? 1 : -1, e.shiftKey, k.value));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const angle = angleFor(value, min, max);
  const zeroAngle = bipolarFrom !== undefined ? angleFor(bipolarFrom, min, max) : -135;
  const engaged = Math.abs(angle - zeroAngle) > 0.5;
  const c = size / 2;
  const rArc = c - 5;
  const [nx, ny] = polar(c, c, rArc - 6, angle);

  const ticks = [-135, zeroAngle !== -135 ? 0 : -45, 45, 135, -45].filter(
    (t, i, a) => a.indexOf(t) === i,
  );

  return (
    <>
      <span className="spec klabel">{label}</span>
      <svg
        ref={svgRef}
        className={`knob-svg ${grabbed ? 'grabbed' : ''}`}
        width={size}
        height={size}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={+value.toFixed(3)}
        aria-valuetext={format(value)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
        onDoubleClick={() => onChange(defaultValue)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') onChange(nudge(1, e.shiftKey, value));
          else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') onChange(nudge(-1, e.shiftKey, value));
          else if (e.key === 'Home') onChange(defaultValue);
          else return;
          e.preventDefault(); // the key is the knob's, not the panel's scroll
        }}
      >
        {/* tick marks */}
        {ticks.map((t) => {
          const [x0, y0] = polar(c, c, rArc, t);
          const [x1, y1] = polar(c, c, rArc + 3.5, t);
          return <line key={t} x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--border-mid)" strokeWidth="1" />;
        })}
        {/* track + value arcs */}
        <path d={arcPath(c, c, rArc, -135, 135)} stroke="var(--border-mid)" strokeWidth="3" fill="none" />
        {engaged && (
          <path
            d={arcPath(c, c, rArc, Math.min(zeroAngle, angle), Math.max(zeroAngle, angle))}
            stroke="var(--signal-500)"
            strokeWidth="3"
            fill="none"
          />
        )}
        {/* dial face */}
        <circle className="knob-face" cx={c} cy={c} r={rArc - 8} fill="var(--surface-control)" stroke="var(--border-hairline)" />
        {/* needle */}
        <line x1={c} y1={c} x2={nx} y2={ny} stroke={engaged ? 'var(--signal-500)' : 'var(--text-secondary)'} strokeWidth="2" />
        {/* spindle: the Jamware square */}
        <rect x={c - 3} y={c - 3} width="6" height="6" fill={engaged ? 'var(--signal-500)' : 'var(--graphite-500)'} />
      </svg>
      {editing ? (
        <input
          className="kvalue-entry"
          autoFocus
          inputMode="decimal"
          defaultValue={+(value * entryScale).toFixed(2)}
          aria-label={`${label} value`}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => commitEntry(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEntry(e.currentTarget.value);
            else if (e.key === 'Escape') {
              // Leaving the field blurs it, and a blur commits: not this time.
              cancelled.current = true;
              setEditing(false);
              e.stopPropagation();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={`kvalue ${grabbed ? 'grabbed' : ''}`}
          title="Click to type a value"
          aria-label={`${label}: ${format(value)} · type a value`}
          onClick={() => { cancelled.current = false; setEditing(true); }}
        >{format(value)}</button>
      )}
    </>
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
