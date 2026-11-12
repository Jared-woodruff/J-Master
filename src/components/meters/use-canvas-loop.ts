// One animation loop for a canvas in a well: sized to its wrapper at the
// display's pixel ratio (and again when either changes), running only while
// the wrapper is actually on screen. The draw function decides for itself
// whether a frame needs painting; `fresh` tells it the canvas was just
// cleared (a resize, a theme change, a poke) and must be painted whole.
import { useEffect, useRef, type RefObject } from 'react';

export interface Surface {
  ctx: CanvasRenderingContext2D;
  /** CSS pixels; the context is already scaled by `dpr`. */
  w: number;
  h: number;
  dpr: number;
}

export type DrawFn = (s: Surface, fresh: boolean) => void;

export function useCanvasLoop(
  wrapRef: RefObject<HTMLDivElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  makeDraw: () => DrawFn,
): { poke: () => void } {
  // Called from pointer handlers and store subscriptions: paint the next frame whole.
  const pokeRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const draw = makeDraw();
    const surface: Surface = { ctx, w: 0, h: 0, dpr: 1 };
    let fresh = true;
    let raf = 0;
    let onScreen = true;

    const resize = () => {
      surface.dpr = window.devicePixelRatio || 1;
      surface.w = wrap.clientWidth;
      surface.h = wrap.clientHeight;
      const cw = Math.max(1, Math.round(surface.w * surface.dpr));
      const ch = Math.max(1, Math.round(surface.h * surface.dpr));
      // Assigning a size clears the canvas, so only when it really changed.
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      fresh = true;
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      // A window dragged to another display changes ratio without resizing.
      if ((window.devicePixelRatio || 1) !== surface.dpr) resize();
      if (surface.w === 0 || surface.h === 0) return;
      const wasFresh = fresh;
      fresh = false;
      ctx.setTransform(surface.dpr, 0, 0, surface.dpr, 0, 0);
      draw(surface, wasFresh);
    };
    const start = () => {
      if (raf === 0 && onScreen && document.visibilityState !== 'hidden') {
        resize();
        raf = requestAnimationFrame(frame);
      }
    };
    const stop = () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
    };

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    const io = new IntersectionObserver((entries) => {
      onScreen = entries[entries.length - 1]?.isIntersecting ?? true;
      if (onScreen) start(); else stop();
    });
    io.observe(wrap);
    const onVisibility = () => { if (document.visibilityState === 'hidden') stop(); else start(); };
    document.addEventListener('visibilitychange', onVisibility);
    // The ratio also changes with the OS scale setting and with page zoom.
    let mq: MediaQueryList | null = null;
    const onRatio = () => { resize(); watchRatio(); };
    const watchRatio = () => {
      mq?.removeEventListener('change', onRatio);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener('change', onRatio);
    };
    watchRatio();

    pokeRef.current = () => { fresh = true; };
    start();
    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      mq?.removeEventListener('change', onRatio);
      pokeRef.current = () => undefined;
    };
    // The draw function reads everything live; the loop itself never restarts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useRef({ poke: () => pokeRef.current() }).current;
}
