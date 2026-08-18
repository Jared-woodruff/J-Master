import { useCallback, useRef } from 'react';

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

export function Knob({ label, value, min, max, defaultValue, bipolarFrom, format, onChange, size = 58 }: KnobProps) {
  const drag = useRef<{ startY: number; startVal: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startVal: value };
  }, [value]);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const fine = e.shiftKey ? 0.18 : 1;
    const delta = ((drag.current.startY - e.clientY) / 160) * (max - min) * fine;
    onChange(clamp(drag.current.startVal + delta, min, max));
  }, [max, min, onChange]);

  const onPointerUp = useCallback(() => { drag.current = null; }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    const step = (max - min) / (e.shiftKey ? 200 : 50);
    onChange(clamp(value + (e.deltaY < 0 ? step : -step), min, max));
  }, [value, max, min, onChange]);

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
        className="knob-svg"
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
        onDoubleClick={() => onChange(defaultValue)}
        onWheel={onWheel}
        onKeyDown={(e) => {
          const step = (max - min) / (e.shiftKey ? 200 : 50);
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') onChange(clamp(value + step, min, max));
          else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') onChange(clamp(value - step, min, max));
          else if (e.key === 'Home') onChange(defaultValue);
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
        <circle cx={c} cy={c} r={rArc - 8} fill="var(--surface-control)" stroke="var(--border-hairline)" />
        {/* needle */}
        <line x1={c} y1={c} x2={nx} y2={ny} stroke={engaged ? 'var(--signal-500)' : 'var(--text-secondary)'} strokeWidth="2" />
        {/* spindle: the Jamware square */}
        <rect x={c - 3} y={c - 3} width="6" height="6" fill={engaged ? 'var(--signal-500)' : 'var(--graphite-500)'} />
      </svg>
      <span className="kvalue">{format(value)}</span>
    </>
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
