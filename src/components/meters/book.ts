// The one MeterBook the rack reads and writes. It lives outside React so
// what has been measured survives a tab switch or a remount of the panel.
import { MeterBook } from '../../lib/meter-book';

export const book = new MeterBook();

/** Canvas text in the rack's spec style. */
export const WELL_FONT = `8px 'IBM Plex Mono', ui-monospace, monospace`;
export const WELL_FONT_READOUT = `9px 'IBM Plex Mono', ui-monospace, monospace`;

/** Spec-style tracking for canvas text, where the canvas supports it. */
export function trackText(ctx: CanvasRenderingContext2D, px: number): void {
  try { (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`; } catch { /* drawn untracked */ }
}

/** A line or two of readout on a plate of the well's own colour, kept inside the canvas. */
export function drawChip(
  ctx: CanvasRenderingContext2D, lines: string[], atX: number, w: number, well: string, ink: string,
): void {
  ctx.font = WELL_FONT_READOUT;
  trackText(ctx, 0.4);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  let tw = 0;
  for (const line of lines) tw = Math.max(tw, ctx.measureText(line).width);
  const bw = Math.ceil(tw) + 10;
  const bh = lines.length * 11 + 6;
  // On the half the pointer is not in.
  const x = atX < w / 2 ? Math.max(3, w - bw - 3) : 3;
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = well;
  ctx.fillRect(x, 3, bw, bh);
  ctx.globalAlpha = 1;
  ctx.fillStyle = ink;
  lines.forEach((line, i) => ctx.fillText(line, x + 5, 6 + i * 11));
  trackText(ctx, 0);
}
