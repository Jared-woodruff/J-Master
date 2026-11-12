// Vectorscope (goniometer): each sample pair is plotted as side (x) against
// mid (y), rotated so a left-only signal leans up-left and right-only
// up-right. Phosphor-style persistence; auto gain keeps quiet passages
// readable, since the display is about image shape, not level.
import { useRef } from 'react';
import { useStore } from '../../state/store';
import { engine } from '../../audio/engine';
import { palette, type CanvasPalette } from '../../lib/palette';
import { useCanvasLoop, type DrawFn } from './use-canvas-loop';
import { WELL_FONT } from './book';

const SQ = Math.SQRT1_2;

function makeDraw(): DrawFn {
  let gain = 4;
  let idleFrames = 0;
  let lastPal: CanvasPalette | null = null;

  return ({ ctx, w, h }, fresh) => {
    const pal = palette();
    const playing = useStore.getState().playing;
    // The trace fades out over a few frames after playback stops; past
    // that there is nothing left to repaint.
    if (!playing && idleFrames > 30 && pal === lastPal && !fresh) return;
    idleFrames = playing ? 0 : idleFrames + 1;
    const themeChanged = pal !== lastPal;
    lastPal = pal;

    // Persistence: veil the previous frame instead of clearing it.
    ctx.fillStyle = pal.well;
    ctx.globalAlpha = fresh || themeChanged ? 1 : 0.3;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;

    const cx = w / 2, cy = h / 2;
    const R = Math.max(10, Math.min(w, h) / 2 - 8);
    // Guides: M axis (mono), S axis (out of phase), L and R diagonals.
    ctx.strokeStyle = pal.hair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, cy - R); ctx.lineTo(Math.round(cx) + 0.5, cy + R);
    ctx.moveTo(cx - R, Math.round(cy) + 0.5); ctx.lineTo(cx + R, Math.round(cy) + 0.5);
    const d = R * SQ;
    ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d);
    ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d);
    ctx.stroke();
    ctx.fillStyle = pal.spec;
    ctx.font = WELL_FONT;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('M', cx + 4, cy - R);
    ctx.fillText('S', cx + R - 6, cy + 4);
    ctx.fillText('L', cx - d - 8, cy - d - 2);
    ctx.fillText('R', cx + d + 3, cy - d - 2);

    const data = engine.readScope();
    if (!data) return;
    const { l, r } = data;
    let peak = 0;
    for (let i = 0; i < l.length; i++) {
      const x = Math.abs((r[i] - l[i]) * SQ);
      const y = Math.abs((l[i] + r[i]) * SQ);
      if (x > peak) peak = x;
      if (y > peak) peak = y;
    }
    if (peak > 1e-4) {
      const want = 0.9 / Math.max(peak, 0.01);
      gain += (want - gain) * (want < gain ? 0.35 : 0.04);
    }
    ctx.fillStyle = pal.signal;
    ctx.globalAlpha = 0.55;
    const k = gain * R;
    for (let i = 0; i < l.length; i++) {
      const x = (r[i] - l[i]) * SQ * k;
      const y = (l[i] + r[i]) * SQ * k;
      ctx.fillRect(cx + x - 0.6, cy - y - 0.6, 1.3, 1.3);
    }
    ctx.globalAlpha = 1;
  };
}

export function Scope({ labelledBy }: { labelledBy: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useCanvasLoop(wrapRef, canvasRef, makeDraw);

  return (
    <div className="mx-well" ref={wrapRef} role="tabpanel" id="mx-panel-scope" aria-labelledby={labelledBy}>
      <canvas ref={canvasRef} role="img"
        aria-label="Vectorscope: mono is a vertical line, width spreads it sideways, phase trouble leans horizontal" />
    </div>
  );
}
