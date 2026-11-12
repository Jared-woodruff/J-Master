// Loudness against track position: the short-term loudness of everything
// that has been played, drawn where in the track it was heard, so a pass
// through the song leaves its whole loudness curve behind. The target is
// the one orange line, with a band one LU either side of it; the source's
// own curve sits behind, moved to the target's level, to show what the
// chain did to the dynamics; and a flag on the right edge marks where the
// export will land. Click to go there.
import { useRef } from 'react';
import { useStore } from '../../state/store';
import { engine } from '../../audio/engine';
import { keptRange } from '../../audio/dsp/params';
import { palette, type CanvasPalette } from '../../lib/palette';
import { HISTORY_STEP_SEC } from '../../lib/meter-book';
import { LUFS_FLOOR, timeTickStep } from '../../lib/meter-math';
import { mmss } from '../../lib/tempo-text';
import { useCanvasLoop, type DrawFn } from './use-canvas-loop';
import { book, WELL_FONT, drawChip, trackText } from './book';

/** The scale: this much above the target, this much in all. */
const ABOVE_TARGET_LU = 9;
const SPAN_LU = 36;
const GRID_LU = 6;
const AXIS_H = 13;
const PLOT_TOP = 3;

function makeDraw(hover: { x: number | null }): DrawFn {
  let lastPal: CanvasPalette | null = null;
  let lastVersion = -1;
  let lastPlayhead = NaN;
  let lastTarget = NaN;
  let lastEst: unknown = undefined;
  let lastSrc: unknown = undefined;
  let lastK0 = NaN, lastK1 = NaN;
  let lastHover: number | null = null;

  return ({ ctx, w, h }, fresh) => {
    const st = useStore.getState();
    const pal = palette();
    const src = st.source;
    const est = st.masterEstimate;
    const target = st.targetLufs;
    const dur = src?.durationSec ?? 0;
    const [k0, k1] = keptRange({ trimStartSec: st.trimStartSec, trimEndSec: st.trimEndSec, songLengthSec: dur });
    if (!fresh && pal === lastPal && book.version === lastVersion && st.playheadSec === lastPlayhead
      && target === lastTarget && est === lastEst && src === lastSrc && k0 === lastK0 && k1 === lastK1
      && hover.x === lastHover) return;
    lastPal = pal; lastVersion = book.version; lastPlayhead = st.playheadSec; lastTarget = target;
    lastEst = est; lastSrc = src; lastK0 = k0; lastK1 = k1; lastHover = hover.x;

    const plotH = Math.max(10, h - AXIS_H - PLOT_TOP);
    const base = PLOT_TOP + plotH;
    const span = Math.max(0.01, k1 - k0);
    const yTop = Math.min(0, target + ABOVE_TARGET_LU);
    const x = (sec: number): number => ((sec - k0) / span) * w;
    const y = (lufs: number): number =>
      PLOT_TOP + ((yTop - Math.max(yTop - SPAN_LU, Math.min(yTop, lufs))) / SPAN_LU) * plotH;

    ctx.globalAlpha = 1;
    ctx.fillStyle = pal.well;
    ctx.fillRect(0, 0, w, h);

    // Level rules every 6 LU, counted from the target so it sits on one.
    const rules: number[] = [];
    for (let k = -8; k <= 2; k++) {
      const v = target + k * GRID_LU;
      if (k !== 0 && v < yTop - 0.01 && v > yTop - SPAN_LU + 0.01) rules.push(v);
    }
    ctx.fillStyle = pal.hair;
    for (const v of rules) ctx.fillRect(0, Math.round(y(v)), w, 1);
    ctx.fillRect(0, Math.round(base), w, 1);

    // Time along the bottom, in the track's own minutes and seconds.
    ctx.font = WELL_FONT;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    if (dur > 0) {
      const step = timeTickStep(span, Math.max(2, Math.floor(w / 64)));
      for (let t = Math.ceil(k0 / step) * step; t <= k1; t += step) {
        const tx = x(t);
        if (tx < 14 || tx > w - 14) continue;
        ctx.fillStyle = pal.hair;
        ctx.fillRect(Math.round(tx), Math.round(base), 1, 3);
        ctx.fillStyle = pal.spec;
        ctx.fillText(mmss(t), tx, h - 2);
      }
    }

    // The target: one LU either side, and the line itself.
    const ty = Math.round(y(target));
    ctx.fillStyle = pal.signal;
    ctx.globalAlpha = 0.14;
    ctx.fillRect(0, y(target + 1), w, y(target - 1) - y(target + 1));
    ctx.globalAlpha = 1;
    ctx.fillRect(0, ty, w, 1);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // The source's own short-term curve, at the target's level: its shape.
    const lane = engine.loudnessLane;
    let ghost = false;
    if (lane && src && src.lufs > LUFS_FLOOR && dur > 0) {
      const shift = target - src.lufs;
      ctx.strokeStyle = pal.rms;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < lane.values.length; i++) {
        const t = (i + 0.5) * lane.stepSec;
        const v = lane.values[i];
        if (t < k0 || t > k1 || !(v > LUFS_FLOOR)) { pen = false; continue; }
        if (pen) ctx.lineTo(x(t), y(v + shift)); else ctx.moveTo(x(t), y(v + shift));
        pen = true;
        ghost = true;
      }
      ctx.stroke();
    }

    // What has been played: momentary behind, short-term in front.
    const trace = (data: Float32Array): boolean => {
      const i0 = Math.max(0, Math.floor(k0 / HISTORY_STEP_SEC));
      const i1 = Math.min(data.length, Math.ceil(k1 / HISTORY_STEP_SEC));
      const stride = Math.max(1, Math.floor((i1 - i0) / (w * 2)));
      let pen = false;
      let any = false;
      ctx.beginPath();
      for (let i = i0; i < i1; i += stride) {
        let v = NaN;
        const end = Math.min(i1, i + stride);
        for (let j = i; j < end; j++) {
          const d = data[j];
          if (d > v || (Number.isNaN(v) && !Number.isNaN(d))) v = d;
        }
        if (Number.isNaN(v)) { pen = false; continue; }
        const px = x((i + (end - i) / 2) * HISTORY_STEP_SEC);
        const py = y(v);
        if (!pen) ctx.moveTo(px, py);
        // A lone reading still leaves a dot.
        ctx.lineTo(px, py);
        pen = true;
        any = true;
      }
      ctx.stroke();
      return any;
    };
    ctx.strokeStyle = pal.src;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.45;
    trace(book.mom);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = pal.text;
    ctx.lineWidth = 1.5;
    const played = trace(book.st);

    // The playhead.
    if (dur > 0 && st.playheadSec >= k0 && st.playheadSec <= k1) {
      ctx.fillStyle = pal.text;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(Math.round(x(st.playheadSec)), PLOT_TOP, 1, plotH);
      ctx.globalAlpha = 1;
    }

    // Scale figures on the left, on plates so a trace never runs through them.
    ctx.font = WELL_FONT;
    ctx.textBaseline = 'alphabetic';
    const plate = (text: string, tx: number, baseline: number, align: CanvasTextAlign, ink: string) => {
      ctx.textAlign = align;
      const tw = ctx.measureText(text).width;
      const left = align === 'right' ? tx - tw : tx;
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = pal.well;
      ctx.fillRect(left - 1.5, baseline - 8, tw + 3, 10);
      ctx.globalAlpha = 1;
      ctx.fillStyle = ink;
      ctx.fillText(text, tx, baseline);
    };
    const figure = (v: number): string => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));
    for (const v of rules) {
      const gy = Math.round(y(v));
      if (gy > 12) plate(figure(v), 3, gy - 2, 'left', pal.spec);
    }
    plate(target.toFixed(1), 3, ty - 2, 'left', pal.signal);

    // Where the export lands: a flag on the right edge.
    if (est && est.measured) {
      const ey = y(est.lufs);
      const ink = est.reached ? pal.text : pal.warn;
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.moveTo(w - 8, ey);
      ctx.lineTo(w - 1, ey - 4.5);
      ctx.lineTo(w - 1, ey + 4.5);
      ctx.closePath();
      ctx.fill();
      // The figure gives way to the pointer's readout, which lands in the same corner.
      if (hover.x === null) {
        // Clear of the target's own line when the two coincide.
        plate(`EXPORT ${est.lufs.toFixed(1)}`, w - 11, ey > 16 ? ey - 5 : ey + 12, 'right', ink);
      }
    }

    if (!played && !ghost && dur > 0) {
      ctx.font = WELL_FONT;
      trackText(ctx, 0.8);
      ctx.textAlign = 'center';
      ctx.fillStyle = pal.spec;
      ctx.fillText('PLAY TO DRAW ITS LOUDNESS', w / 2, PLOT_TOP + plotH * 0.72);
      trackText(ctx, 0);
    }
    ctx.textAlign = 'left';

    // The pointer: where a click would go, and what was heard there.
    if (hover.x !== null && hover.x >= 0 && hover.x <= w && dur > 0) {
      const hx = Math.round(hover.x);
      ctx.fillStyle = pal.text;
      ctx.globalAlpha = 0.4;
      ctx.fillRect(hx, PLOT_TOP, 1, plotH);
      ctx.globalAlpha = 1;
      const t = k0 + (hover.x / w) * span;
      const v = book.st[Math.max(0, Math.min(book.st.length - 1, Math.floor(t / HISTORY_STEP_SEC)))];
      drawChip(ctx, [mmss(t), v > LUFS_FLOOR ? `S ${v.toFixed(1)} LUFS` : 'NOT PLAYED YET'], hover.x, w, pal.well, pal.text);
    }
  };
}

export function LoudnessHistory({ labelledBy }: { labelledBy: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hover = useRef<{ x: number | null }>({ x: null }).current;
  const loop = useCanvasLoop(wrapRef, canvasRef, () => makeDraw(hover));

  return (
    <div
      className="mx-well seek" ref={wrapRef} role="tabpanel" id="mx-panel-loudness" aria-labelledby={labelledBy}
      onPointerMove={(e) => {
        hover.x = e.clientX - e.currentTarget.getBoundingClientRect().left - e.currentTarget.clientLeft;
        loop.poke();
      }}
      onPointerLeave={() => { hover.x = null; loop.poke(); }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const st = useStore.getState();
        if (!st.source) return;
        const box = e.currentTarget.getBoundingClientRect();
        if (box.width <= 0) return;
        const [k0, k1] = keptRange({
          trimStartSec: st.trimStartSec, trimEndSec: st.trimEndSec, songLengthSec: st.source.durationSec,
        });
        const u = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
        st.seekSec(k0 + u * (k1 - k0));
      }}
    >
      <canvas ref={canvasRef} role="img"
        aria-label="Short-term loudness of what has been played, by position in the track, against the target. Click to play from there." />
    </div>
  );
}
