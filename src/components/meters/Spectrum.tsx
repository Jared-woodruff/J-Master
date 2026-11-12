// Live spectrum: the master as bars, the loudness-matched source as a line
// behind it, and a cap over each band that holds its peak for a moment
// before falling. Log frequency from 20 Hz to 20 kHz, level in dB (the
// analyser's own float readings, not 8-bit steps). With SLOPE on, the
// display tilts 4.5 dB an octave around 1 kHz so a balanced mix reads level
// and what stands out is what actually stands out.
import { useRef } from 'react';
import { useStore } from '../../state/store';
import { engine } from '../../audio/engine';
import { palette, type CanvasPalette } from '../../lib/palette';
import { hzText, hzToX, noteName, slopeDb, spectrumBands, xToHz } from '../../lib/meter-math';
import { useCanvasLoop, type DrawFn } from './use-canvas-loop';
import { WELL_FONT, drawChip } from './book';

const DB_TOP = -6;
const DB_BOTTOM = -96;
const DB_SPAN = DB_TOP - DB_BOTTOM;
const FLOOR = -120;
/** A cap stays put this long, then falls this fast. */
const CAP_HOLD_SEC = 1.2;
const CAP_FALL_DB_PER_SEC = 10;
/** Under this a band has nothing in it worth a number. */
const SILENT_DB = -110;

const GRID_HZ: [number, string, boolean][] = [
  [50, '50', false], [100, '100', true], [200, '200', false], [500, '500', false],
  [1000, '1K', true], [2000, '2K', false], [5000, '5K', false], [10000, '10K', true],
];
const GRID_DB = [-20, -40, -60, -80];

// What was last on the glass. Kept outside the component so a tab switch
// while paused comes back to the same picture, as long as the playhead is
// still where that picture was taken.
const shot = {
  n: 0,
  out: new Float32Array(0),
  src: new Float32Array(0),
  cap: new Float32Array(0),
  capAge: new Float32Array(0),
  tilt: new Float32Array(0),
  source: null as unknown,
  playheadSec: -1,
};

function clearShot(n: number): void {
  if (shot.n !== n) {
    shot.n = n;
    shot.out = new Float32Array(n);
    shot.src = new Float32Array(n);
    shot.cap = new Float32Array(n);
    shot.capAge = new Float32Array(n);
    shot.tilt = new Float32Array(n);
    for (let b = 0; b < n; b++) shot.tilt[b] = slopeDb(xToHz((b + 0.5) / n));
  }
  shot.out.fill(FLOOR);
  shot.src.fill(FLOOR);
  shot.cap.fill(FLOOR);
  shot.capAge.fill(0);
}

const signed = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;

function makeDraw(hover: { x: number | null }): DrawFn {
  let scratch = new Float32Array(0);
  let lastPal: CanvasPalette | null = null;
  let lastSlope: boolean | null = null;
  let lastHover: number | null = null;
  let lastMs = 0;

  return ({ ctx, w, h }, fresh) => {
    const st = useStore.getState();
    const pal = palette();
    const live = st.playing;
    const n = Math.max(32, Math.min(128, Math.round(w / 4)));

    // Another track, another width, or a playhead that has moved on since
    // the picture was taken: that picture is of something else.
    let cleared = false;
    if (shot.source !== st.source || shot.n !== n
      || (!live && shot.playheadSec >= 0 && Math.abs(st.playheadSec - shot.playheadSec) > 0.5)) {
      clearShot(n);
      shot.source = st.source;
      shot.playheadSec = -1;
      cleared = true;
    }

    const slope = st.spectrumSlope;
    if (!live && !fresh && !cleared && pal === lastPal && slope === lastSlope && hover.x === lastHover) return;
    lastPal = pal;
    lastSlope = slope;
    lastHover = hover.x;

    const now = performance.now();
    const dt = lastMs > 0 ? Math.min(0.1, (now - lastMs) / 1000) : 0;
    lastMs = now;

    if (live) {
      if (scratch.length !== n) scratch = new Float32Array(n);
      const out = engine.readSpectrumDb();
      if (out.length > 0) {
        spectrumBands(out, engine.sampleRate, scratch, FLOOR);
        for (let b = 0; b < n; b++) {
          const target = scratch[b];
          const cur = shot.out[b];
          const v = cur + (target - cur) * (target > cur ? 0.6 : 0.22);
          shot.out[b] = v;
          if (v >= shot.cap[b]) {
            shot.cap[b] = v;
            shot.capAge[b] = 0;
          } else {
            shot.capAge[b] += dt;
            if (shot.capAge[b] > CAP_HOLD_SEC) shot.cap[b] = Math.max(v, shot.cap[b] - CAP_FALL_DB_PER_SEC * dt);
          }
        }
      }
      const pre = engine.readSpectrumPreDb();
      if (pre.length > 0) {
        spectrumBands(pre, engine.sampleRate, scratch, FLOOR);
        for (let b = 0; b < n; b++) {
          const target = scratch[b];
          const cur = shot.src[b];
          shot.src[b] = cur + (target - cur) * (target > cur ? 0.6 : 0.22);
        }
      }
      shot.playheadSec = st.playheadSec;
      const hook = (window as unknown as { __jmaster?: { spectrumDraws?: number } }).__jmaster;
      if (hook) hook.spectrumDraws = (hook.spectrumDraws ?? 0) + 1;
    }

    const y = (db: number): number => Math.max(0, Math.min(h, ((DB_TOP - db) / DB_SPAN) * h));
    const tiltAt = (b: number): number => (slope ? shot.tilt[b] : 0);

    ctx.globalAlpha = 1;
    ctx.fillStyle = pal.well;
    ctx.fillRect(0, 0, w, h);

    // The grid, under everything.
    ctx.fillStyle = pal.hair;
    for (const [f] of GRID_HZ) ctx.fillRect(Math.round(hzToX(f) * w), 0, 1, h);
    for (const db of GRID_DB) ctx.fillRect(0, Math.round(y(db)), w, 1);

    // OUT: solid bars.
    const barW = w / n;
    const gap = barW >= 3 ? 1 : 0;
    ctx.fillStyle = pal.signal;
    ctx.globalAlpha = 0.92;
    for (let b = 0; b < n; b++) {
      const top = y(shot.out[b] + tiltAt(b));
      if (top < h) ctx.fillRect(b * barW, top, Math.max(1, barW - gap), h - top);
    }
    ctx.globalAlpha = 1;

    // SRC: a line over the bars, so a cut and a boost both show.
    ctx.strokeStyle = pal.src;
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (let b = 0; b < n; b++) {
      if (shot.src[b] <= SILENT_DB) { pen = false; continue; }
      const px = (b + 0.5) * barW;
      const py = y(shot.src[b] + tiltAt(b));
      if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      pen = true;
    }
    ctx.stroke();

    // Caps: where each band peaked a moment ago.
    ctx.fillStyle = pal.text;
    ctx.globalAlpha = 0.8;
    for (let b = 0; b < n; b++) {
      if (shot.cap[b] <= SILENT_DB || shot.cap[b] < shot.out[b] + 0.75) continue;
      const top = y(shot.cap[b] + tiltAt(b));
      if (top < h - 1) ctx.fillRect(b * barW, Math.round(top), Math.max(1, barW - gap), 1);
    }
    ctx.globalAlpha = 1;

    // Scales, on plates of the well's colour so the bars never swallow them.
    ctx.font = WELL_FONT;
    ctx.textBaseline = 'alphabetic';
    const plate = (text: string, tx: number, ty: number, align: CanvasTextAlign) => {
      ctx.textAlign = align;
      const tw = ctx.measureText(text).width;
      const left = align === 'right' ? tx - tw : tx;
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = pal.well;
      ctx.fillRect(left - 1.5, ty - 8, tw + 3, 10);
      ctx.globalAlpha = 1;
      ctx.fillStyle = pal.spec;
      ctx.fillText(text, tx, ty);
    };
    for (const [f, label, always] of GRID_HZ) {
      if (!always && w < 250) continue;
      plate(label, Math.round(hzToX(f) * w) + 3, h - 3, 'left');
    }
    for (const db of GRID_DB) {
      const gy = Math.round(y(db));
      if (gy > 12 && gy < h - 14) plate(String(db), w - 3, gy - 2, 'right');
    }
    ctx.textAlign = 'left';

    // The pointer: a hairline, and what it is pointing at.
    if (hover.x !== null && hover.x >= 0 && hover.x <= w) {
      const hx = Math.round(hover.x);
      ctx.fillStyle = pal.text;
      ctx.globalAlpha = 0.45;
      ctx.fillRect(hx, 0, 1, h);
      ctx.globalAlpha = 1;
      const b = Math.max(0, Math.min(n - 1, Math.floor((hover.x / w) * n)));
      const hz = xToHz(Math.max(0, Math.min(1, hover.x / w)));
      const out = shot.out[b];
      const src = shot.src[b];
      const lines = [`${hzText(hz)} · ${noteName(hz)}`, out > SILENT_DB ? `OUT ${out.toFixed(1)} DB` : 'OUT --.-'];
      if (out > SILENT_DB && src > SILENT_DB) lines.push(`${signed(out - src)} VS SRC`);
      drawChip(ctx, lines, hover.x, w, pal.well, pal.text);
      if (out > SILENT_DB) {
        const top = y(out + tiltAt(b));
        ctx.fillStyle = pal.text;
        ctx.fillRect(hx - 3, Math.round(top), 7, 1);
      }
    }
  };
}

export function Spectrum({ labelledBy }: { labelledBy: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hover = useRef<{ x: number | null }>({ x: null }).current;
  const loop = useCanvasLoop(wrapRef, canvasRef, () => makeDraw(hover));

  return (
    <div
      className="mx-well hover" ref={wrapRef} role="tabpanel" id="mx-panel-spectrum" aria-labelledby={labelledBy}
      onPointerMove={(e) => {
        hover.x = e.clientX - e.currentTarget.getBoundingClientRect().left - e.currentTarget.clientLeft;
        loop.poke();
      }}
      onPointerLeave={() => { hover.x = null; loop.poke(); }}
    >
      <canvas ref={canvasRef} role="img"
        aria-label="Spectrum of the master as bars with the loudness-matched source as a line, 20 hertz to 20 kilohertz" />
    </div>
  );
}
