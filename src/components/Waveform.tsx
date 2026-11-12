// The waveform plate: multi-resolution peak rendering with zoom around the
// cursor, pan, an overview strip when zoomed, a playhead the view follows,
// click/scrub seeking, top-and-tail trim brackets, fade handles with live
// curve overlays, and a loop over a section or any stretch you drag out.
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, FocusEvent as ReactFocusEvent } from 'react';
import { useStore } from '../state/store';
import { engine } from '../audio/engine';
import type { TempoCurve } from '../audio/engine';
import { fadeGainAt } from '../audio/dsp/fades';
import { keptRange } from '../audio/dsp/params';
import { palette } from '../lib/palette';
import { lufsText } from '../lib/level-text';
import {
  lowerBound, timecode, spanText, rulerStep, rulerTicks, rulerLabel, barBeatAt, nearestBeat, snapTo,
  clampRange, followStart, revealStart, specFreqAt, freqText,
} from '../lib/wave-math';
import '../styles/waveform.css';

const RULER_H = 20;
/** Surround layouts by channel count, as the spec line names them. */
const SURROUND: Record<number, string> = { 3: '3.0', 4: 'QUAD', 5: '5.0', 6: '5.1', 8: '7.1' };
const OVERVIEW_H = 11;
const HANDLE = 9;
/** Width of a trim bracket (matches .wtrim). */
const GRIP_W = 12;
/** A press that moves less than this is a click, not a drag. */
const DRAG_PX = 4;
/** How near a loop edge has to be to take hold of it: on the plate, and in the ruler. */
const EDGE_PX = 5;
const RULER_EDGE_PX = 8;
/** Loop edges settle on a beat, a section line or a trim point this near. */
const SNAP_PX = 7;

// Tempo curves with their pulse-less gaps bridged, per analysis.
const bridgedCurves = new WeakMap<TempoCurve, number[]>();

/** Local tempo at `sec`, bridged across gaps and held at the ends. */
function curveAt(c: TempoCurve, sec: number): number {
  let v = bridgedCurves.get(c);
  if (!v) {
    const known = c.bpm.map((b, i) => [i, b] as const).filter(([, b]) => Number.isFinite(b));
    v = c.bpm.map((b, i) => {
      if (Number.isFinite(b) || known.length === 0) return b;
      const after = known.findIndex(([j]) => j > i);
      if (after <= 0) return known[after === 0 ? 0 : known.length - 1][1];
      const [i0, b0] = known[after - 1];
      const [i1, b1] = known[after];
      return b0 + ((b1 - b0) * (i - i0)) / (i1 - i0);
    });
    bridgedCurves.set(c, v);
  }
  const x = Math.max(0, Math.min(v.length - 1, (sec - c.startSec) / c.stepSec));
  const i = Math.floor(x);
  const j = Math.min(v.length - 1, i + 1);
  return v[i] + (v[j] - v[i]) * (x - i);
}

type LoopDrag = 'loopNew' | 'loopStart' | 'loopEnd' | 'loopMove';
type DragMode = 'seek' | 'fadeIn' | 'fadeOut' | 'view' | LoopDrag | 'trimStart' | 'trimEnd' | null;
type TrimEnd = 'start' | 'end';

const isLoopDrag = (m: DragMode): m is LoopDrag =>
  m === 'loopNew' || m === 'loopStart' || m === 'loopEnd' || m === 'loopMove';

// Spectrogram colour ramp: well graphite → burnt → signal orange → hot paper.
function buildSpecCanvas(sg: { cols: number; bands: number; data: Uint8Array }): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = sg.cols;
  c.height = sg.bands;
  const g = c.getContext('2d')!;
  const img = g.createImageData(sg.cols, sg.bands);
  const px = img.data;
  const ramp = new Uint8Array(256 * 3);
  const stops: [number, number, number, number][] = [
    [0, 0x0a, 0x0b, 0x0d],
    [0.45, 0x5c, 0x1f, 0x02],
    [0.75, 0xff, 0x4d, 0x00],
    [1, 0xff, 0xe3, 0xd6],
  ];
  for (let i = 0; i < 256; i++) {
    const t = Math.pow(i / 255, 0.85);
    let s0 = stops[0], s1 = stops[stops.length - 1];
    for (let j = 0; j < stops.length - 1; j++) {
      if (t >= stops[j][0] && t <= stops[j + 1][0]) { s0 = stops[j]; s1 = stops[j + 1]; break; }
    }
    const f = s1[0] === s0[0] ? 0 : (t - s0[0]) / (s1[0] - s0[0]);
    ramp[i * 3] = s0[1] + (s1[1] - s0[1]) * f;
    ramp[i * 3 + 1] = s0[2] + (s1[2] - s0[2]) * f;
    ramp[i * 3 + 2] = s0[3] + (s1[3] - s0[3]) * f;
  }
  for (let col = 0; col < sg.cols; col++) {
    for (let b = 0; b < sg.bands; b++) {
      const v = sg.data[col * sg.bands + b];
      // band 0 = lowest frequency → bottom row of the image
      const y = sg.bands - 1 - b;
      const o = (y * sg.cols + col) * 4;
      px[o] = ramp[v * 3];
      px[o + 1] = ramp[v * 3 + 1];
      px[o + 2] = ramp[v * 3 + 2];
      px[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

export function Waveform() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gripStartRef = useRef<HTMLDivElement>(null);
  const gripEndRef = useRef<HTMLDivElement>(null);
  const dragMode = useRef<DragMode>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const view = useRef({ start: 0, end: 1 });
  /** You moved the view away from the playhead: following waits until it is back in sight. */
  const followHold = useRef(false);
  /** The trim bracket being moved or holding the keyboard focus (its rule is lit on the canvas). */
  const trimHot = useRef<TrimEnd | null>(null);
  const trimDrag = useRef<{ which: TrimEnd; offset: number } | null>(null);
  const specCanvas = useRef<HTMLCanvasElement | null>(null);
  const specFor = useRef<unknown>(null);
  const specReq = useRef(0);
  const [zoomed, setZoomed] = useState(false);
  const [specComputing, setSpecComputing] = useState(false);
  const [followHeld, setFollowHeld] = useState(false);
  const [trimActive, setTrimActive] = useState<TrimEnd | null>(null);
  const source = useStore((s) => s.source);
  const waveView = useStore((s) => s.waveView);
  const setWaveView = useStore((s) => s.setWaveView);
  const gridEnabled = useStore((s) => s.gridEnabled);
  const setGridEnabled = useStore((s) => s.setGridEnabled);
  const hasTempo = useStore((s) => (s.tempo?.bpm ?? 0) > 0);
  const loudnessLane = useStore((s) => s.loudnessLane);
  const setLoudnessLane = useStore((s) => s.setLoudnessLane);
  const tempoLane = useStore((s) => s.tempoLane);
  const setTempoLane = useStore((s) => s.setTempoLane);
  const drifting = useStore((s) => !!s.tempo?.drift);
  const waveFocusSeq = useStore((s) => s.waveFocus?.seq ?? 0);
  const processedView = useStore((s) => s.processedView);
  const setProcessedView = useStore((s) => s.setProcessedView);
  const outSplit = useStore((s) => s.outSplit);
  const setOutSplit = useStore((s) => s.setOutSplit);
  const loopOn = useStore((s) => s.loopStartSec !== null);
  const toggleLoop = useStore((s) => s.toggleLoop);
  const followPlayhead = useStore((s) => s.followPlayhead);
  const setFollowPlayhead = useStore((s) => s.setFollowPlayhead);
  const trimStartSec = useStore((s) => s.trimStartSec);
  const trimEndSec = useStore((s) => s.trimEndSec);
  const clearTrim = useStore((s) => s.clearTrim);
  const previewPending = useStore((s) => s.previewPending);
  const loading = useStore((s) => s.loading);
  const loadingName = useStore((s) => s.loadingName);
  const loadPhase = useStore((s) => s.loadPhase);

  // Compute the spectrogram lazily the first time SPEC is selected for a
  // track. The cached image remembers which source it belongs to, so a new
  // track in SPEC view recomputes instead of showing nothing.
  useEffect(() => {
    if (specFor.current !== source) {
      specCanvas.current = null;
      specFor.current = source;
    }
    if (waveView !== 'spec' || !source || specCanvas.current) return;
    const req = ++specReq.current;
    const forSource = source;
    setSpecComputing(true);
    void engine.requestSpectrogram().then((sg) => {
      if (req !== specReq.current) return;
      if (sg && specFor.current === forSource) specCanvas.current = buildSpecCanvas(sg);
      setSpecComputing(false);
    });
  }, [waveView, source]);

  // Reset the view whenever a new track lands.
  useEffect(() => {
    if (source) {
      view.current = { start: 0, end: source.durationSec };
      followHold.current = false;
      setZoomed(false);
    }
  }, [source]);

  const dur = () => useStore.getState().source?.durationSec ?? 1;

  /** What the export keeps: [start, end] of the track, in seconds. */
  const kept = (): [number, number] => {
    const s = useStore.getState();
    return keptRange({ trimStartSec: s.trimStartSec, trimEndSec: s.trimEndSec, songLengthSec: dur() });
  };

  const clampView = (start: number, end: number) => {
    const d = dur();
    const w = wrapRef.current?.clientWidth ?? 1200;
    // The closest zoom: 128 samples to a pixel.
    const r = clampRange(start, end, d, (w * 128) / engine.sampleRate);
    view.current = r;
    setZoomed(r.end - r.start < d - 1e-6);
  };

  /** The view was moved by hand: following holds off until the playhead is back in it. */
  const movedByHand = () => { followHold.current = true; };

  const zoomBy = (factor: number, anchorFrac = 0.5) => {
    const v = view.current;
    const len = v.end - v.start;
    const newLen = len * factor;
    const anchorSec = v.start + len * anchorFrac;
    clampView(anchorSec - newLen * anchorFrac, anchorSec + newLen * (1 - anchorFrac));
  };

  /** Brings a moment into view (no move when it already is). */
  const reveal = (sec: number) => {
    const v = view.current;
    const s = revealStart(v, sec, dur());
    if (s !== null) clampView(s, s + (v.end - v.start));
  };

  /** The moment under a pointer, held inside the visible stretch. */
  const secAtClient = (clientX: number): number => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    const x = Math.max(0, Math.min(r.width, clientX - r.left));
    const v = view.current;
    return v.start + (x / r.width) * (v.end - v.start);
  };

  // Frame a stretch another part of the app points at (the drift panel).
  useEffect(() => {
    const f = useStore.getState().waveFocus;
    if (f && waveFocusSeq > 0) {
      clampView(f.startSec, f.endSec);
      // Asked for: playback elsewhere must not pull the view straight back.
      movedByHand();
    }
  }, [waveFocusSeq]);

  // ── drawing ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || !source) return;

    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let w = 0, h = 0, dpr = 1;

    // Skip frames when nothing observable moved: the signature covers every
    // input the canvas draws from, so a paused, untouched console costs
    // (almost) nothing per frame.
    let prevSig: unknown[] = [];

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      w = wrap.clientWidth;
      h = wrap.clientHeight;
      const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
      // Setting a canvas's size clears it, even to the same size: repaint.
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      prevSig = [];
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    // What the follow rule compares against: where the playhead was a frame
    // ago, and whether the transport was running.
    let lastPlayhead = useStore.getState().playheadSec;
    let wasPlaying = useStore.getState().playing;
    let heldShown = false;

    /** A trim bracket, put where its end of the kept range is on screen. */
    const placeGrip = (el: HTMLDivElement | null, x: number, side: TrimEnd, gy: number, gh: number) => {
      if (!el) return;
      const visible = x >= -0.5 && x <= w + 0.5;
      el.style.visibility = visible ? 'visible' : 'hidden';
      if (!visible) return;
      // The bracket opens inward, over the audio it keeps.
      const left = side === 'start' ? Math.min(x, w - GRIP_W) : Math.max(0, x - GRIP_W);
      el.style.transform = `translate(${left.toFixed(1)}px, ${gy.toFixed(1)}px)`;
      el.style.height = `${Math.round(gh)}px`;
      el.classList.toggle('flip', side === 'start' ? left + 128 > w : left - 116 < 0);
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const st = useStore.getState();
      const wf = engine.waveform;
      if (!wf || w === 0) return;
      const pal = palette();
      // A monitor-scale change moves devicePixelRatio without a resize.
      if ((window.devicePixelRatio || 1) !== dpr) resize();

      const d = st.source?.durationSec ?? 1;

      // ── follow ──
      // Playing, the view turns the page with the playhead. Paused, a seek
      // made elsewhere (the keyboard, a section in the track strip) is
      // brought into view. Neither happens mid-drag, and neither pulls the
      // view back from where you moved it: that waits until the playhead is
      // in sight again, or until FOLLOW is pressed.
      {
        const v = view.current;
        const ph = st.playheadSec;
        const dragging = dragMode.current !== null;
        // The playhead was put somewhere while the transport rests.
        const sought = !st.playing && ph !== lastPlayhead && !dragging;
        // A seek, or pressing play, is asking to see the playhead again.
        if (sought || (st.playing && !wasPlaying)) followHold.current = false;
        if (followHold.current && ph >= v.start && ph <= v.end) followHold.current = false;
        if (st.followPlayhead && !dragging && !followHold.current) {
          const to = st.playing ? followStart(v, ph, d)
            : sought ? revealStart(v, ph, d)
            : null;
          if (to !== null) clampView(to, to + (v.end - v.start));
        }
        lastPlayhead = ph;
        wasPlaying = st.playing;
        const held = st.followPlayhead && followHold.current;
        if (held !== heldShown) { heldShown = held; setFollowHeld(held); }
      }

      const v0 = view.current;
      const hv = hover.current;
      const curSig: unknown[] = [
        st.playheadSec, st.playing, v0.start, v0.end, hv?.x, hv?.y, dragMode.current, trimHot.current,
        st.waveView, st.gridEnabled, st.loudnessLane, st.tempoLane, st.processedView, st.outSplit,
        st.loopStartSec, st.loopEndSec, st.fadeInSec, st.fadeOutSec, st.trimStartSec, st.trimEndSec,
        st.fadeInCurve, st.fadeOutCurve, st.targetLufs, st.tempo,
        engine.processedPreview, engine.loudnessLane, specCanvas.current,
        w, h, dpr, pal, wf,
      ];
      let same = prevSig.length === curSig.length;
      if (same) {
        for (let i = 0; i < curSig.length; i++) {
          if (curSig[i] !== prevSig[i]) { same = false; break; }
        }
      }
      if (same) return;
      prevSig = curSig;
      const hook = (window as any).__jmaster;
      if (hook) hook.waveDraws = (hook.waveDraws | 0) + 1;

      const colWell = pal.well;
      const colBar = pal.bar;
      const colRms = pal.rms;
      const colSignal = pal.signal;
      const colHair = pal.hair;
      const colSpec = pal.spec;

      const v = view.current;
      const viewLen = v.end - v.start;
      const isZoomed = viewLen < d - 1e-6;
      const fs = engine.sampleRate;

      const topY = isZoomed ? OVERVIEW_H + 2 : 0;
      const waveH = h - RULER_H - topY;
      const midY = topY + waveH / 2;
      const rulerY = h - RULER_H;
      const secToX = (sec: number) => ((sec - v.start) / viewLen) * w;

      // What the export keeps.
      const [k0, k1] = keptRange({ trimStartSec: st.trimStartSec, trimEndSec: st.trimEndSec, songLengthSec: d });
      const cutHead = k0 > 0;
      const cutTail = k1 < d - 1e-9;

      // Where the pointer is: the overview, the plate or the ruler.
      const hoverZone = !hv ? null
        : isZoomed && hv.y <= OVERVIEW_H + 1 ? 'overview'
        : hv.y >= rulerY ? 'ruler'
        : 'wave';

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = colWell;
      ctx.fillRect(0, 0, w, h);

      const playX = secToX(st.playheadSec);
      const specMode = st.waveView === 'spec' && specCanvas.current;

      if (specMode) {
        // Spectrogram image, cropped to the current view window.
        const sc = specCanvas.current!;
        const srcX = (v.start / d) * sc.width;
        const srcW = Math.max(1, (viewLen / d) * sc.width);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(sc, srcX, 0, srcW, sc.height, 0, topY, w, waveH);
        // Frequency gridlines at 100 Hz / 1 kHz / 10 kHz (log 20..20k).
        ctx.font = `9px 'IBM Plex Mono', monospace`;
        ctx.textBaseline = 'bottom';
        for (const [f, label] of [[100, '100'], [1000, '1K'], [10000, '10K']] as [number, string][]) {
          const y = topY + waveH * (1 - Math.log(f / 20) / Math.log(1000));
          ctx.fillStyle = 'rgba(255,255,255,0.16)';
          ctx.fillRect(0, y, w, 1);
          ctx.fillStyle = 'rgba(255,255,255,0.55)';
          ctx.fillText(label, 3, y - 1);
        }
      } else {
        // SPLIT compare: source lane above, processed master lane below.
        const split = st.processedView && st.outSplit && !!engine.processedPreview;
        const srcMid = split ? topY + waveH * 0.26 : midY;
        const srcAmp = split ? waveH * 0.225 : waveH * 0.46;

        // centre rule
        ctx.strokeStyle = colHair;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, srcMid + 0.5);
        ctx.lineTo(w, srcMid + 0.5);
        ctx.stroke();

        if (split) {
          const yDiv = topY + waveH * 0.52;
          ctx.fillStyle = colHair;
          ctx.fillRect(0, yDiv, w, 1);
          ctx.font = `8px 'IBM Plex Mono', monospace`;
          ctx.textBaseline = 'top';
          ctx.fillStyle = colSpec;
          ctx.fillText('SRC', 3, yDiv - 11);
          ctx.fillStyle = colSignal;
          ctx.fillText('OUT', 3, yDiv + 4);
        }

        // pick the pyramid level for this zoom
        const spp = (viewLen * fs) / w; // samples per pixel
        let level = wf.levels[0];
        for (const lv of wf.levels) {
          if (lv.spb <= spp * 1.0001) level = lv;
          else break;
        }
        const { spb, mins, maxs, rms } = level;
        const buckets = mins.length;
        const startBucket = (v.start * fs) / spb;
        const bucketsPerPx = spp / spb;

        for (let x = 0; x < w; x++) {
          const b0 = Math.max(0, Math.floor(startBucket + x * bucketsPerPx));
          const b1 = Math.min(buckets, Math.max(b0 + 1, Math.ceil(startBucket + (x + 1) * bucketsPerPx)));
          if (b0 >= buckets) break;
          let mn = 1, mx = -1, rm = 0, cnt = 0;
          for (let b = b0; b < b1; b++) {
            if (mins[b] < mn) mn = mins[b];
            if (maxs[b] > mx) mx = maxs[b];
            rm += rms[b] * rms[b];
            cnt++;
          }
          if (cnt === 0) continue;
          // A float source (or a drift repair) can peak past full scale:
          // the lane shows full scale and nothing spills into its neighbours.
          rm = Math.min(1, Math.sqrt(rm / cnt));
          const played = x <= playX;
          ctx.fillStyle = played ? 'rgba(255,77,0,0.42)' : colBar;
          const y0 = srcMid - Math.min(1, mx) * srcAmp;
          const y1 = srcMid - Math.max(-1, mn) * srcAmp;
          ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
          ctx.fillStyle = played ? colSignal : colRms;
          ctx.fillRect(x, srcMid - rm * srcAmp, 1, Math.max(1, rm * 2 * srcAmp));
        }
      }

      // bar/beat grid: a drifting track's comes from its tracked beats, a
      // steady track's is one fixed grid anchored to the first bar
      const tp = st.tempo;
      if (st.gridEnabled && tp && tp.bpm > 0 && tp.drift && tp.beats.length > 1) {
        const beats = tp.beats;
        const barPx = ((240 / tp.bpm) / viewLen) * w;
        if (barPx > 7) {
          ctx.font = `8px 'IBM Plex Mono', monospace`;
          ctx.textBaseline = 'top';
          for (let i = Math.max(0, lowerBound(beats, v.start) - 1); i < beats.length; i++) {
            const sec = beats[i];
            if (sec > v.end) break;
            const x = secToX(sec);
            if (x < -1) continue;
            const pos = (((i - tp.downbeat) % 4) + 4) % 4;
            if (pos === 0) {
              ctx.fillStyle = specMode ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.14)';
              ctx.fillRect(x, topY, 1, waveH);
              const bar = Math.floor((i - tp.downbeat) / 4) + 1;
              if (barPx > 44 && bar >= 1) {
                ctx.fillStyle = specMode ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.5)';
                ctx.fillText(`${bar}`, x + 3, topY + waveH - 10);
              }
            } else if (barPx > 72) {
              ctx.fillStyle = specMode ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.07)';
              ctx.fillRect(x, topY, 1, waveH);
            }
          }
        }
      } else if (st.gridEnabled && tp && tp.bpm > 0) {
        const beatSec = 60 / tp.bpm;
        const barSec = beatSec * 4;
        const anchor = tp.firstBarSec ?? tp.firstBeatSec;
        const barPx = (barSec / viewLen) * w;
        if (barPx > 7) {
          const firstVisibleBar = Math.max(0, Math.floor((v.start - anchor) / barSec));
          ctx.font = `8px 'IBM Plex Mono', monospace`;
          ctx.textBaseline = 'top';
          for (let bar = firstVisibleBar; ; bar++) {
            const sec = anchor + bar * barSec;
            if (sec > v.end) break;
            const x = secToX(sec);
            if (x < -1) continue;
            ctx.fillStyle = specMode ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.14)';
            ctx.fillRect(x, topY, 1, waveH);
            if (barPx > 44) {
              ctx.fillStyle = specMode ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.5)';
              ctx.fillText(`${bar + 1}`, x + 3, topY + waveH - 10);
            }
            // beat ticks inside the bar when there's room
            if (barPx > 72) {
              ctx.fillStyle = specMode ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.07)';
              for (let bt = 1; bt < 4; bt++) {
                const bx = secToX(sec + bt * beatSec);
                if (bx >= 0 && bx <= w) ctx.fillRect(bx, topY, 1, waveH);
              }
            }
          }
        }
      }

      // section boundaries + labels
      if (st.tempo && st.tempo.sections.length > 1) {
        ctx.font = `8px 'IBM Plex Mono', monospace`;
        ctx.textBaseline = 'top';
        for (const sect of st.tempo.sections) {
          const x = secToX(sect.startSec);
          if (x < -80 || x > w + 4) continue;
          if (sect.startSec > 0.5) {
            ctx.fillStyle = colSignal;
            ctx.globalAlpha = 0.55;
            ctx.fillRect(x, topY, 1, waveH);
            ctx.globalAlpha = 1;
          }
          const sectW = ((sect.endSec - sect.startSec) / viewLen) * w;
          if (sectW > 46) {
            ctx.fillStyle = sect.label === 'PEAK' ? colSignal : colSpec;
            ctx.fillText(sect.label, Math.max(2, x) + 4, topY + 13);
          }
        }
      }

      // short-term loudness lane along the bottom of the wave area
      const lane = engine.loudnessLane;
      if (st.loudnessLane && lane && lane.values.length > 1) {
        const laneH = Math.min(30, waveH * 0.22);
        const laneY = topY + waveH - laneH;
        ctx.fillStyle = 'rgba(0,0,0,0.30)';
        ctx.fillRect(0, laneY, w, laneH);
        const lufsToY = (lv: number) =>
          laneY + laneH - Math.max(0, Math.min(1, (lv + 36) / 36)) * laneH;
        // target marker
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(0, lufsToY(st.targetLufs), w, 1);
        // filled area + line
        ctx.beginPath();
        let started = false;
        for (let x = 0; x <= w; x += 2) {
          const sec = v.start + (x / w) * viewLen;
          const idx = Math.max(0, Math.min(lane.values.length - 1, Math.round(sec / lane.stepSec)));
          const y = lufsToY(lane.values[idx]);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = colSignal;
        ctx.lineWidth = 1.2;
        ctx.globalAlpha = 0.9;
        ctx.stroke();
        ctx.globalAlpha = 1;
        // processed master's loudness line over the source's (the master
        // is rendered over the whole track: a trimmed end is silence in it)
        const ppLane = st.processedView ? engine.processedPreview?.lane : null;
        if (ppLane && ppLane.values.length > 1) {
          ctx.beginPath();
          let begun = false;
          for (let x = 0; x <= w; x += 2) {
            const sec = v.start + (x / w) * viewLen;
            const idx = Math.max(0, Math.min(ppLane.values.length - 1, Math.round(sec / ppLane.stepSec)));
            const y = lufsToY(ppLane.values[idx]);
            if (!begun) { ctx.moveTo(x, y); begun = true; }
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = '#FBFAF7';
          ctx.lineWidth = 1;
          ctx.globalAlpha = 0.85;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = colSpec;
        ctx.font = `8px 'IBM Plex Mono', monospace`;
        ctx.textBaseline = 'top';
        ctx.fillText(ppLane ? 'ST LUFS · SRC ▬ OUT —' : 'ST LUFS · SRC', 3, laneY + 2);
      }

      // tempo lane: where the tempo drifts, against the tempo it set out at
      const dr = tp?.drift;
      if (st.tempoLane && tp && dr && tp.curve) {
        const cv = tp.curve;
        const laneH = Math.min(40, waveH * 0.28);
        const lufsH = st.loudnessLane && engine.loudnessLane ? Math.min(30, waveH * 0.22) + 1 : 0;
        const laneY = topY + waveH - lufsH - laneH;
        ctx.fillStyle = 'rgba(0,0,0,0.30)';
        ctx.fillRect(0, laneY, w, laneH);
        const vals = cv.bpm.filter(Number.isFinite);
        const lo = Math.min(dr.refBpm, ...vals);
        const hi = Math.max(dr.refBpm, ...vals);
        const span = Math.max(0.5, hi - lo);
        const bpmToY = (b: number) => laneY + 12 + (1 - (b - lo) / span) * (laneH - 16);
        const laneLabel = `BPM · ${dr.refBpm.toFixed(1)} → ${dr.endBpm.toFixed(1)}`;
        ctx.font = `8px 'IBM Plex Mono', monospace`;
        ctx.textBaseline = 'top';
        const labelEnd = 3 + ctx.measureText(laneLabel).width;
        // drift regions: an amber wash, tagged where each begins
        for (const r of dr.regions) {
          const x0 = Math.max(0, secToX(r.startSec));
          const x1 = Math.min(w, secToX(r.endSec));
          if (x1 <= 0 || x0 >= w) continue;
          ctx.fillStyle = pal.warn;
          ctx.globalAlpha = 0.16;
          ctx.fillRect(x0, laneY, x1 - x0, laneH);
          ctx.globalAlpha = 0.9;
          if (secToX(r.startSec) >= 0) ctx.fillRect(x0, laneY, 1, laneH);
          const delta = r.peakBpm - dr.refBpm;
          const tag = `DRIFT ${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)} BPM`;
          const tx = Math.max(x0 + 4, labelEnd + 10);
          if (x1 - tx > ctx.measureText(tag).width + 4) ctx.fillText(tag, tx, laneY + 2);
          ctx.globalAlpha = 1;
        }
        // the tempo the track set out at
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(0, Math.round(bpmToY(dr.refBpm)), w, 1);
        // the curve: grey where steady, amber inside the drift
        const trace = () => {
          ctx.beginPath();
          for (let x = 0; x <= w; x += 2) {
            const y = bpmToY(curveAt(cv, v.start + (x / w) * viewLen));
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        };
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = colSpec;
        trace();
        ctx.save();
        ctx.beginPath();
        for (const r of dr.regions) ctx.rect(secToX(r.startSec), laneY, secToX(r.endSec) - secToX(r.startSec), laneH);
        ctx.clip();
        ctx.strokeStyle = pal.warn;
        ctx.lineWidth = 1.6;
        trace();
        ctx.restore();
        ctx.fillStyle = colSpec;
        ctx.fillText(laneLabel, 3, laneY + 2);
      }

      // processed-master lane (OUT): ghosted over the source, or in its own
      // lane below it when SPLIT is on. Its peaks cover the whole track, so
      // it sits exactly under the source at every zoom.
      const pp = engine.processedPreview;
      if (st.processedView && pp && !specMode) {
        const split = st.outSplit;
        const outMid = split ? topY + waveH * 0.78 : midY;
        const outAmp = split ? waveH * 0.225 : waveH * 0.46;
        if (split) {
          ctx.strokeStyle = colHair;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, outMid + 0.5);
          ctx.lineTo(w, outMid + 0.5);
          ctx.stroke();
        }
        const startBucketP = (v.start * fs) / pp.spb;
        const bucketsPerPxP = (viewLen * fs) / w / pp.spb;
        ctx.fillStyle = colSignal;
        for (let x = 0; x < w; x++) {
          const b0 = Math.max(0, Math.floor(startBucketP + x * bucketsPerPxP));
          const b1 = Math.min(pp.mins.length, Math.max(b0 + 1, Math.ceil(startBucketP + (x + 1) * bucketsPerPxP)));
          if (b0 >= pp.mins.length) break;
          let mn = 1, mx = -1;
          for (let b = b0; b < b1; b++) {
            if (pp.mins[b] < mn) mn = pp.mins[b];
            if (pp.maxs[b] > mx) mx = pp.maxs[b];
          }
          ctx.globalAlpha = split ? (x <= playX ? 0.85 : 0.5) : 0.34;
          const y0 = outMid - mx * outAmp;
          const y1 = outMid - mn * outAmp;
          ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
        }
        ctx.globalAlpha = 1;
      }

      // top & tail: what the export leaves out goes dark and hatched
      const hatch = (xa: number, xb: number, label: string, labelAtEnd: boolean) => {
        const x0 = Math.max(0, xa), x1 = Math.min(w, xb);
        if (x1 <= x0) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, topY, x1 - x0, waveH);
        ctx.clip();
        ctx.fillStyle = 'rgba(10,11,13,0.68)';
        ctx.fillRect(x0, topY, x1 - x0, waveH);
        ctx.strokeStyle = 'rgba(255,255,255,0.085)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        // Anchored to the plate, so the hatch holds still while the audio pans under it.
        for (let x = Math.floor((x0 - waveH) / 7) * 7; x < x1; x += 7) {
          ctx.moveTo(x, topY + waveH);
          ctx.lineTo(x + waveH, topY);
        }
        ctx.stroke();
        ctx.font = `8px 'IBM Plex Mono', monospace`;
        ctx.textBaseline = 'top';
        const tw = ctx.measureText(label).width;
        if (x1 - x0 > tw + 26) {
          ctx.fillStyle = colSpec;
          ctx.fillText(label, labelAtEnd ? x1 - tw - 6 : x0 + 12, topY + 24);
        }
        ctx.restore();
      };
      if (cutHead) hatch(secToX(0), secToX(k0), `CUT ${spanText(k0)}`, true);
      if (cutTail) hatch(secToX(k1), secToX(d), `CUT ${spanText(d - k1)}`, false);

      // fades run from the trim points, over what is kept
      const fi = st.fadeInSec;
      const fo = st.fadeOutSec;
      const keptLen = k1 - k0;
      const gainY = (sec: number) => {
        const g = fadeGainAt(sec - k0, fi, fo, st.fadeInCurve, st.fadeOutCurve, keptLen);
        return topY + waveH * (1 - g * 0.94) - waveH * 0.015;
      };
      const drawCurve = (fromSec: number, toSec: number) => {
        const x0 = Math.max(0, secToX(fromSec));
        const x1 = Math.min(w, secToX(toSec));
        if (x1 <= x0) return;
        ctx.strokeStyle = colSignal;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let x = x0; x < x1; x += 2) {
          const y = gainY(v.start + (x / w) * viewLen);
          if (x === x0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.lineTo(x1, gainY(v.start + (x1 / w) * viewLen));
        ctx.stroke();
      };
      const shade = (fromSec: number, toSec: number) => {
        const x0 = Math.max(0, secToX(fromSec));
        const x1 = Math.min(w, secToX(toSec));
        if (x1 <= x0) return;
        ctx.fillStyle = 'rgba(13,14,16,0.55)';
        ctx.fillRect(x0, topY, x1 - x0, waveH);
      };
      if (fi > 0) {
        shade(k0, k0 + fi);
        drawCurve(k0, k0 + fi);
      }
      if (fo > 0) {
        shade(k1 - fo, k1);
        drawCurve(k1 - fo, k1);
      }
      // fade handles
      const handleY = topY + 2;
      const drawHandle = (sec: number, active: boolean) => {
        const x = secToX(sec);
        if (x < -HANDLE || x > w + HANDLE) return;
        ctx.fillStyle = active ? colSignal : colSpec;
        ctx.fillRect(x - HANDLE / 2, handleY, HANDLE, HANDLE);
        ctx.strokeStyle = active ? colSignal : colSpec;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, handleY + HANDLE);
        ctx.lineTo(x + 0.5, topY + waveH);
        ctx.stroke();
      };
      drawHandle(k0 + fi, fi > 0);
      drawHandle(k1 - fo, fo > 0);

      // trim rules: a hairline the height of the plate at each cut, lit
      // while its bracket is being moved or has the keyboard
      const trimRule = (sec: number, side: TrimEnd, cut: boolean) => {
        const hot = trimHot.current === side;
        if (!cut && !hot) return;
        const x = Math.round(secToX(sec));
        if (x < -1 || x > w + 1) return;
        ctx.fillStyle = hot ? colSignal : pal.text;
        ctx.globalAlpha = hot ? 1 : 0.85;
        ctx.fillRect(side === 'start' ? Math.min(w - 1, x) : Math.max(0, x - 1), topY, 1, waveH);
        ctx.globalAlpha = 1;
      };
      trimRule(k0, 'start', cutHead);
      trimRule(k1, 'end', cutTail);

      // the brackets themselves are elements over the canvas (they take
      // focus and the keyboard): put them where their rules are
      {
        const gh = Math.max(14, Math.min(32, waveH * 0.36));
        // Clear of the fade handles at the top when there is the height for it.
        const centred = topY + waveH / 2 - gh / 2;
        const gy = centred >= topY + 28 ? centred : Math.max(topY + 2, Math.min(topY + 28, topY + waveH - gh - 2));
        placeGrip(gripStartRef.current, secToX(k0), 'start', gy, gh);
        placeGrip(gripEndRef.current, secToX(k1), 'end', gy, gh);
      }

      // loop region: a wash on the plate, boundary rules, a band on the
      // ruler with a tab at each edge to take hold of
      if (st.loopStartSec !== null && st.loopEndSec !== null) {
        const lx0 = secToX(st.loopStartSec);
        const lx1 = secToX(st.loopEndSec);
        const a = Math.max(0, lx0), b = Math.min(w, lx1);
        ctx.fillStyle = colSignal;
        if (b > a) {
          ctx.globalAlpha = 0.06;
          ctx.fillRect(a, topY, b - a, waveH);
          ctx.globalAlpha = 0.2;
          ctx.fillRect(a, rulerY + 1, b - a, RULER_H - 1);
        }
        ctx.globalAlpha = 0.8;
        if (lx0 >= 0 && lx0 <= w) ctx.fillRect(lx0, topY, 1, waveH);
        if (lx1 >= 0 && lx1 <= w) ctx.fillRect(lx1 - 1, topY, 1, waveH);
        ctx.globalAlpha = 1;
        if (lx0 >= -3 && lx0 <= w) ctx.fillRect(lx0, rulerY + 1, 3, RULER_H - 1);
        if (lx1 >= 0 && lx1 <= w + 3) ctx.fillRect(lx1 - 3, rulerY + 1, 3, RULER_H - 1);
        if (lx0 < w && lx1 > 0) {
          let text = 'LOOP';
          // While it is being dragged out the label says what it holds.
          if (isLoopDrag(dragMode.current)) {
            const len = st.loopEndSec - st.loopStartSec;
            text = `LOOP ${timecode(st.loopStartSec, 1)} – ${timecode(st.loopEndSec, 1)} · ${spanText(len)}`;
            if (tp && tp.bpm > 0 && !tp.drift) {
              const bars = len / (240 / tp.bpm);
              const whole = Math.round(bars);
              if (whole >= 1 && Math.abs(bars - whole) < 0.03) text += ` · ${whole} BAR${whole > 1 ? 'S' : ''}`;
            }
          }
          ctx.font = `8px 'IBM Plex Mono', monospace`;
          ctx.textBaseline = 'top';
          const tw = ctx.measureText(text).width;
          const tx = Math.max(2, Math.min(w - tw - 6, Math.max(2, lx0) + 4));
          if (text !== 'LOOP') {
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(tx - 3, topY + 22, tw + 6, 12);
            ctx.fillStyle = colSignal;
          }
          ctx.fillText(text, tx, topY + 24);
        }
      }

      // hover readout: the time, the bar and beat on a tempo grid, then
      // short-term LUFS (or, over the spectrogram, the frequency)
      if (hv && dragMode.current === null && (hoverZone === 'wave' || hoverZone === 'ruler')) {
        const sec = v.start + (Math.max(0, Math.min(w, hv.x)) / w) * viewLen;
        let text = timecode(sec, 1);
        if (tp && tp.bpm > 0) {
          const at = barBeatAt(sec, tp);
          if (at) text += ` · BAR ${at.bar}.${at.beat}`;
        }
        if (hoverZone === 'ruler') {
          const inLoop = st.loopStartSec !== null && st.loopEndSec !== null && sec >= st.loopStartSec && sec <= st.loopEndSec;
          text += inLoop ? ' · DRAG TO MOVE THE LOOP' : ' · DRAG TO LOOP';
        } else if (specMode) {
          text += ` · ${freqText(specFreqAt(1 - (hv.y - topY) / waveH))}`;
        } else {
          const hLane = engine.loudnessLane;
          if (hLane && hLane.values.length > 1) {
            const idx = Math.max(0, Math.min(hLane.values.length - 1, Math.round(sec / hLane.stepSec)));
            const lv = hLane.values[idx];
            if (lv > -60) text += ` · ${lv.toFixed(1)} LUFS`;
          }
        }
        if (hoverZone === 'wave' && st.tempo?.drift && st.tempo.curve) {
          text += ` · ${curveAt(st.tempo.curve, sec).toFixed(1)} BPM`;
        }
        ctx.font = `9px 'IBM Plex Mono', monospace`;
        ctx.textBaseline = 'top';
        const tw = ctx.measureText(text).width;
        const tx = Math.max(3, hv.x + 6 + tw > w ? hv.x - tw - 6 : hv.x + 6);
        ctx.fillStyle = specMode ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.55)';
        ctx.fillRect(tx - 3, topY + 2, tw + 6, 13);
        ctx.fillStyle = '#FBFAF7';
        ctx.fillText(text, tx, topY + 4);
      }

      // playhead (paper-white over the spectrogram so it stays visible)
      if (playX >= 0 && playX <= w) {
        ctx.fillStyle = specMode ? '#FBFAF7' : colSignal;
        ctx.fillRect(playX - 0.5, topY, 1, waveH);
        ctx.fillRect(playX - 3.5, topY, 7, 7);
      }

      // hover crosshair
      if (hv && dragMode.current === null && hoverZone !== 'overview') {
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(hv.x) + 0.5, topY);
        ctx.lineTo(Math.round(hv.x) + 0.5, topY + waveH);
        ctx.stroke();
      }

      // overview strip when zoomed
      if (isZoomed) {
        ctx.fillStyle = '#000';
        ctx.globalAlpha = 0.35;
        ctx.fillRect(0, 0, w, OVERVIEW_H);
        ctx.globalAlpha = 1;
        const coarse = wf.levels[wf.levels.length - 1];
        const oAmp = OVERVIEW_H * 0.42;
        const oMid = OVERVIEW_H / 2;
        ctx.fillStyle = colRms;
        const per = coarse.mins.length / w;
        for (let x = 0; x < w; x += 2) {
          const b = Math.min(coarse.mins.length - 1, Math.floor(x * per));
          const a = Math.min(1, Math.max(Math.abs(coarse.maxs[b]), Math.abs(coarse.mins[b]))) * oAmp;
          ctx.fillRect(x, oMid - a, 2, Math.max(1, a * 2));
        }
        // what is cut reads as cut here too, and the loop as a line
        ctx.fillStyle = 'rgba(10,11,13,0.7)';
        if (cutHead) ctx.fillRect(0, 0, (k0 / d) * w, OVERVIEW_H);
        if (cutTail) ctx.fillRect((k1 / d) * w, 0, w - (k1 / d) * w, OVERVIEW_H);
        if (st.loopStartSec !== null && st.loopEndSec !== null) {
          ctx.fillStyle = colSignal;
          ctx.fillRect((st.loopStartSec / d) * w, OVERVIEW_H - 2, Math.max(1, ((st.loopEndSec - st.loopStartSec) / d) * w), 2);
        }
        const wx0 = (v.start / d) * w;
        const wx1 = (v.end / d) * w;
        ctx.fillStyle = 'rgba(255,77,0,0.18)';
        ctx.fillRect(wx0, 0, wx1 - wx0, OVERVIEW_H);
        ctx.strokeStyle = colSignal;
        ctx.lineWidth = 1;
        ctx.strokeRect(wx0 + 0.5, 0.5, wx1 - wx0 - 1, OVERVIEW_H - 1);
        // the playhead, so a view that has wandered shows how far
        const opx = (st.playheadSec / d) * w;
        ctx.fillStyle = pal.text;
        ctx.fillRect(opx - 0.5, 0, 1, OVERVIEW_H);
        ctx.fillStyle = colHair;
        ctx.fillRect(0, OVERVIEW_H + 1, w, 1);
      }

      // time ruler over the current view, banded amber where the tempo drifts
      if (st.tempo?.drift) {
        ctx.fillStyle = pal.warn;
        ctx.globalAlpha = 0.22;
        for (const r of st.tempo.drift.regions) {
          const x0 = Math.max(0, secToX(r.startSec));
          const x1 = Math.min(w, secToX(r.endSec));
          if (x1 > x0) ctx.fillRect(x0, rulerY + 1, x1 - x0, RULER_H - 1);
        }
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = colHair;
      ctx.fillRect(0, rulerY, w, 1);
      ctx.fillStyle = colSpec;
      ctx.font = `9px 'IBM Plex Mono', monospace`;
      ctx.textBaseline = 'middle';
      // As many labels as the width can carry, each a whole multiple of the step.
      const stepSec = rulerStep(viewLen, Math.max(4, Math.floor(w / 90)));
      for (const t of rulerTicks(v.start, v.end, stepSec)) {
        const x = secToX(t);
        ctx.fillRect(x, rulerY, 1, 4);
        const label = rulerLabel(t, stepSec);
        const lw = ctx.measureText(label).width;
        ctx.fillText(label, Math.min(x + 4, w - lw - 3), rulerY + RULER_H / 2 + 1);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [source]);

  // ── interactions ────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || !source) return;

    const st = () => useStore.getState();
    const rect = () => wrap.getBoundingClientRect();
    const isZoomed = () => {
      const d = st().source?.durationSec ?? 1;
      return view.current.end - view.current.start < d - 1e-6;
    };
    const secAt = secAtClient;
    const xOf = (sec: number) => {
      const r = rect();
      const v = view.current;
      return ((sec - v.start) / (v.end - v.start)) * r.width;
    };
    const zoneAt = (clientY: number): 'overview' | 'wave' | 'ruler' => {
      const r = rect();
      const y = clientY - r.top;
      if (isZoomed() && y <= OVERVIEW_H + 1) return 'overview';
      return y >= r.height - RULER_H ? 'ruler' : 'wave';
    };

    const hitHandle = (clientX: number, clientY: number): 'fadeIn' | 'fadeOut' | null => {
      const r = rect();
      const y = clientY - r.top;
      const topY = isZoomed() ? OVERVIEW_H + 2 : 0;
      if (y < topY || y > topY + 26) return null;
      const x = clientX - r.left;
      const s = st();
      const [k0, k1] = kept();
      if (Math.abs(x - xOf(k0 + s.fadeInSec)) < 10) return 'fadeIn';
      if (Math.abs(x - xOf(k1 - s.fadeOutSec)) < 10) return 'fadeOut';
      return null;
    };

    /** The loop edge under the pointer (the nearer, when both are in reach). */
    const hitLoopEdge = (clientX: number, zone: 'wave' | 'ruler'): 'loopStart' | 'loopEnd' | null => {
      const s = st();
      if (s.loopStartSec === null || s.loopEndSec === null) return null;
      const x = clientX - rect().left;
      const tol = zone === 'ruler' ? RULER_EDGE_PX : EDGE_PX;
      const d0 = Math.abs(x - xOf(s.loopStartSec));
      const d1 = Math.abs(x - xOf(s.loopEndSec));
      if (d0 > tol && d1 > tol) return null;
      return d0 <= d1 ? 'loopStart' : 'loopEnd';
    };
    const insideLoop = (sec: number): boolean => {
      const s = st();
      return s.loopStartSec !== null && s.loopEndSec !== null && sec >= s.loopStartSec && sec <= s.loopEndSec;
    };

    /** A loop edge settles on a beat, a section line, a trim point or an end of the track (Alt: wherever it is put). */
    const snap = (sec: number, free: boolean): number => {
      if (free) return sec;
      const s = st();
      const d = s.source?.durationSec ?? 1;
      const v = view.current;
      const tol = ((v.end - v.start) / Math.max(1, rect().width)) * SNAP_PX;
      const [k0, k1] = kept();
      const cands: (number | null)[] = [0, d, k0, k1];
      const tp = s.tempo;
      if (tp) {
        if (s.gridEnabled && tp.bpm > 0) cands.push(nearestBeat(sec, tp));
        if (tp.sections.length > 1) for (const sect of tp.sections) cands.push(sect.startSec);
      }
      return snapTo(sec, cands, tol);
    };

    const panViewTo = (clientX: number) => {
      const r = rect();
      const d = st().source?.durationSec ?? 1;
      const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      const len = view.current.end - view.current.start;
      const center = frac * d;
      clampView(center - len / 2, center + len / 2);
    };

    // A press that may become a loop gesture: it is one only once it has
    // travelled; released where it began, it was a click, and seeks.
    let pending: { kind: LoopDrag; x0: number; sec0: number; loop: [number, number] | null } | null = null;
    /** Loop edge drags: the edge that stays put. Moving the loop: where in it the pointer holds. */
    let anchorSec = 0;
    let grabSec = 0;
    let loopLen = 0;

    const endDrag = (pointerId?: number) => {
      pending = null;
      dragMode.current = null;
      canvas.style.cursor = '';
      if (pointerId !== undefined && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    };

    const setHover = (e: PointerEvent) => {
      const r = rect();
      hover.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onDown = (e: PointerEvent) => {
      // The primary button only: a right or middle click is not a seek.
      if (e.button !== 0) return;
      // A second finger or button mid-drag changes nothing.
      if (dragMode.current !== null || pending) return;
      canvas.setPointerCapture(e.pointerId);
      setHover(e);
      const zone = zoneAt(e.clientY);
      if (zone === 'overview') {
        dragMode.current = 'view';
        canvas.style.cursor = 'grabbing';
        movedByHand();
        panViewTo(e.clientX);
        return;
      }
      const handle = zone === 'wave' ? hitHandle(e.clientX, e.clientY) : null;
      if (handle) {
        dragMode.current = handle;
        return;
      }
      const s = st();
      const sec = secAt(e.clientX);
      const loop: [number, number] | null =
        s.loopStartSec !== null && s.loopEndSec !== null ? [s.loopStartSec, s.loopEndSec] : null;
      const edge = hitLoopEdge(e.clientX, zone);
      if (edge) {
        pending = { kind: edge, x0: e.clientX, sec0: sec, loop };
      } else if (zone === 'ruler' && insideLoop(sec)) {
        pending = { kind: 'loopMove', x0: e.clientX, sec0: sec, loop };
      } else if (zone === 'ruler' || e.shiftKey) {
        pending = { kind: 'loopNew', x0: e.clientX, sec0: sec, loop };
      } else {
        dragMode.current = 'seek';
        s.seekSec(sec);
      }
    };

    const onMove = (e: PointerEvent) => {
      setHover(e);
      // The release happened somewhere it could not be seen: the drag is over.
      if ((dragMode.current !== null || pending) && e.buttons === 0) {
        endDrag(e.pointerId);
      }
      if (pending && dragMode.current === null) {
        if (Math.abs(e.clientX - pending.x0) < DRAG_PX) return;
        dragMode.current = pending.kind;
        if (pending.kind === 'loopNew') anchorSec = snap(pending.sec0, e.altKey);
        else if (pending.loop) {
          anchorSec = pending.kind === 'loopStart' ? pending.loop[1] : pending.loop[0];
          grabSec = pending.sec0 - pending.loop[0];
          loopLen = pending.loop[1] - pending.loop[0];
        }
        canvas.style.cursor = pending.kind === 'loopMove' ? 'grabbing' : 'ew-resize';
      }
      const s = st();
      const mode = dragMode.current;
      if (mode === 'seek') {
        s.seekSec(secAt(e.clientX));
      } else if (mode === 'fadeIn') {
        s.setFade('in', secAt(e.clientX) - kept()[0]);
      } else if (mode === 'fadeOut') {
        s.setFade('out', kept()[1] - secAt(e.clientX));
      } else if (mode === 'view') {
        panViewTo(e.clientX);
      } else if (mode === 'loopNew' || mode === 'loopStart' || mode === 'loopEnd') {
        s.setLoopRange(anchorSec, snap(secAt(e.clientX), e.altKey));
      } else if (mode === 'loopMove') {
        const d = s.source?.durationSec ?? 0;
        const start = Math.max(0, Math.min(d - loopLen, snap(secAt(e.clientX) - grabSec, e.altKey)));
        s.setLoopRange(start, start + loopLen);
      } else if (mode === null) {
        const zone = zoneAt(e.clientY);
        const sec = secAt(e.clientX);
        canvas.style.cursor =
          zone === 'overview' ? 'grab'
          : zone === 'wave' && hitHandle(e.clientX, e.clientY) ? 'ew-resize'
          : hitLoopEdge(e.clientX, zone) ? 'ew-resize'
          : zone === 'ruler' && insideLoop(sec) ? 'grab'
          : 'crosshair';
      }
    };

    const onUp = (e: PointerEvent) => {
      const s = st();
      const mode = dragMode.current;
      if (pending && mode === null) {
        // It never travelled: a click, which seeks like any other.
        s.seekSec(pending.sec0);
      } else if (isLoopDrag(mode) && s.loopStartSec !== null && s.loopEndSec !== null) {
        // A loop the playhead is outside of would never be heard: playback
        // (and, for a new loop, the parked playhead) goes to its start.
        const outside = s.playheadSec < s.loopStartSec || s.playheadSec >= s.loopEndSec;
        if (outside && (mode === 'loopNew' || s.playing)) s.seekSec(s.loopStartSec);
      }
      endDrag(e.pointerId);
    };
    // Taken away mid-drag (a system gesture, the window losing the pointer):
    // the drag ends where it was, and nothing is clicked.
    const onCancel = (e: PointerEvent) => { endDrag(e.pointerId); };
    const onLostCapture = () => { endDrag(); };
    const onLeave = () => { hover.current = null; };
    const onDbl = (e: MouseEvent) => {
      if (e.button !== 0 || zoneAt(e.clientY) === 'overview') return;
      const sec = secAt(e.clientX);
      // Inside a loop: that loop comes off. Elsewhere: the section there loops.
      if (insideLoop(sec)) st().clearLoop();
      else st().toggleLoop(sec);
    };

    /** The page itself has somewhere to scroll to (short or narrow windows). */
    const pageScrolls = (): boolean => {
      for (let el = wrap.parentElement; el; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight + 1) {
          const oy = getComputedStyle(el).overflowY;
          if (oy === 'auto' || oy === 'scroll') return true;
        }
      }
      return false;
    };

    const onWheel = (e: WheelEvent) => {
      // Shift+wheel arrives as horizontal movement on Windows, and trackpads
      // swipe sideways: whichever axis moved more is the gesture.
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1;
      const dlt = (sideways ? e.deltaX : e.deltaY) * unit;
      if (dlt === 0) return;
      const pan = sideways || e.shiftKey;
      const zoomKey = e.ctrlKey || e.metaKey;
      // Where the page scrolls, a plain wheel is the page's: zooming the
      // plate there takes Ctrl (a trackpad pinch arrives as exactly that).
      if (!pan && !zoomKey && pageScrolls()) return;
      const before = view.current;
      const r = rect();
      // A wheel notch is ~100 px of delta; a trackpad sends many small ones,
      // so both pan and zoom scale with the delta (one notch = one step).
      const notch = Math.max(-1, Math.min(1, dlt / 100));
      if (pan) {
        const len = before.end - before.start;
        const shift = notch * len * 0.12;
        clampView(before.start + shift, before.end + shift);
      } else {
        const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        zoomBy(Math.pow(1.3, notch), frac);
      }
      const moved = view.current.start !== before.start || view.current.end !== before.end;
      if (moved) movedByHand();
      // Only a wheel that did something is kept from the page; Ctrl+wheel
      // is always the plate's (left alone, Chromium would zoom the window).
      if (moved || zoomKey) e.preventDefault();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('lostpointercapture', onLostCapture);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('dblclick', onDbl);
    // On the frame, so the wheel works over a trim bracket as well.
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('lostpointercapture', onLostCapture);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('dblclick', onDbl);
      wrap.removeEventListener('wheel', onWheel);
      endDrag();
    };
  }, [source]);

  if (!source) return null;

  // ── top & tail brackets ─────────────────────────────────────────────
  const d = source.durationSec;
  const [keepStart, keepEnd] = keptRange({ trimStartSec, trimEndSec, songLengthSec: d });
  const cutHead = keepStart > 0;
  const cutTail = keepEnd < d - 1e-9;

  const endTrimDrag = () => {
    if (!trimDrag.current) return;
    trimDrag.current = null;
    if (dragMode.current === 'trimStart' || dragMode.current === 'trimEnd') dragMode.current = null;
    setTrimActive(null);
  };
  const gripProps = (which: TrimEnd) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || trimDrag.current) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const [k0, k1] = kept();
      // Held where it was taken: the bracket does not jump to the pointer.
      trimDrag.current = { which, offset: secAtClient(e.clientX) - (which === 'start' ? k0 : k1) };
      dragMode.current = which === 'start' ? 'trimStart' : 'trimEnd';
      trimHot.current = which;
      setTrimActive(which);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = trimDrag.current;
      if (!drag) return;
      if (e.buttons === 0) { endTrimDrag(); return; }
      useStore.getState().setTrim(drag.which, secAtClient(e.clientX) - drag.offset);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      endTrimDrag();
      if (!e.currentTarget.matches(':focus-visible')) trimHot.current = null;
    },
    onPointerCancel: () => { endTrimDrag(); trimHot.current = null; },
    onLostPointerCapture: () => { endTrimDrag(); },
    onDoubleClick: () => { useStore.getState().setTrim(which, which === 'start' ? 0 : dur()); },
    onFocus: (e: ReactFocusEvent<HTMLDivElement>) => {
      if (e.currentTarget.matches(':focus-visible')) trimHot.current = which;
    },
    onBlur: () => { if (!trimDrag.current && trimHot.current === which) trimHot.current = null; },
    onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const [k0, k1] = kept();
      const cur = which === 'start' ? k0 : k1;
      const step = e.shiftKey ? 1 : 0.1;
      let next: number;
      switch (e.key) {
        case 'ArrowLeft': case 'ArrowDown': next = cur - step; break;
        case 'ArrowRight': case 'ArrowUp': next = cur + step; break;
        case 'PageDown': next = cur - 10; break;
        case 'PageUp': next = cur + 10; break;
        // Home and End run to the limits; for each bracket one of them is "no cut".
        case 'Home': next = which === 'start' ? 0 : k0 + 1; break;
        case 'End': next = which === 'start' ? k1 - 1 : dur(); break;
        case 'Delete': case 'Backspace': next = which === 'start' ? 0 : dur(); break;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
      trimHot.current = which;
      useStore.getState().setTrim(which, +next.toFixed(3));
      // Followed with the view, so the bracket being moved stays on screen
      // (and the playhead does not pull the view straight back).
      const after = kept();
      const before = view.current;
      reveal(which === 'start' ? after[0] : after[1]);
      if (view.current !== before) movedByHand();
    },
  });

  const onFollow = () => {
    const s = useStore.getState();
    // On, but holding off because the view was moved away: pressing it
    // again goes back to the playhead and carries on following.
    if (s.followPlayhead && followHold.current) {
      followHold.current = false;
      reveal(s.playheadSec);
      return;
    }
    setFollowPlayhead(!s.followPlayhead);
    if (!s.followPlayhead) {
      followHold.current = false;
      reveal(s.playheadSec);
    }
  };

  const layout = source.channels === 1 ? 'MONO'
    : source.channels === 2 ? 'STEREO'
    : `${SURROUND[source.channels] ?? `${source.channels} CH`} → STEREO`;
  const specLine = `SOURCE · ${(source.originalSampleRate / 1000).toFixed(1)} KHZ${
    source.originalBitDepth ? ` · ${source.originalBitDepth} BIT` : ''
  } · ${layout} · ${lufsText(source.lufs)} IN${
    cutHead || cutTail ? ` · KEEPS ${timecode(keepEnd - keepStart, 1)} OF ${timecode(d, 1)}` : ''
  }`;
  const busyLine = specComputing ? 'ANALYSING SPECTRUM…'
    : processedView && previewPending ? 'RENDERING MASTER PREVIEW…'
    : null;

  // The controls live in a header row above the canvas, never on it: over
  // the canvas they hid the fade-out handle and collided with the labels.
  return (
    <section className="wavesection">
      <div className="wavehead">
        <span className={`spec wavehead-status ${busyLine ? 'busy' : ''}`}>{busyLine ?? specLine}</span>
        <div className="wave-controls" role="toolbar" aria-label="Waveform view">
          <span className="wseg">
            <button className={waveView === 'wave' ? 'on' : ''} aria-pressed={waveView === 'wave'} title="Waveform view"
              onClick={() => setWaveView('wave')}>WAVE</button>
            <button className={waveView === 'spec' ? 'on' : ''} aria-pressed={waveView === 'spec'} title="Spectrogram of the source"
              onClick={() => setWaveView('spec')}>SPEC</button>
          </span>
          <span className="wseg">
            <button className={gridEnabled && hasTempo ? 'on' : ''} aria-pressed={gridEnabled && hasTempo} disabled={!hasTempo}
              title="Bar and beat grid from the detected tempo"
              onClick={() => setGridEnabled(!gridEnabled)}>GRID</button>
            <button className={loudnessLane ? 'on' : ''} aria-pressed={loudnessLane}
              title="Short-term loudness lane"
              onClick={() => setLoudnessLane(!loudnessLane)}>LUFS</button>
            {drifting && (
              <button className={tempoLane ? 'on' : ''} aria-pressed={tempoLane}
                title="Tempo lane: where the tempo drifts from the tempo the track set out at"
                onClick={() => setTempoLane(!tempoLane)}>BPM</button>
            )}
          </span>
          <span className="wseg">
            <button className={processedView ? 'on' : ''} aria-pressed={processedView}
              title="Show the processed master's waveform and loudness (re-renders as you adjust)"
              onClick={() => setProcessedView(!processedView)}>OUT</button>
            {processedView && (
              <button className={outSplit ? 'on' : ''} aria-pressed={outSplit}
                title="Split compare: source above, master below"
                onClick={() => setOutSplit(!outSplit)}>SPLIT</button>
            )}
          </span>
          <span className="wseg">
            <button className={loopOn ? 'on' : ''} aria-pressed={loopOn}
              title="Loop the section under the playhead · L · or double-click the waveform. Any stretch: Shift+drag the waveform, or drag along the ruler"
              onClick={() => toggleLoop()}>LOOP</button>
            {(cutHead || cutTail) && (
              <button key="trim" className="on" aria-pressed={true}
                title={`Top and tail: the export keeps ${timecode(keepStart, 1)} to ${timecode(keepEnd, 1)}. Press to restore the whole track`}
                onClick={() => clearTrim()}>TRIM</button>
            )}
          </span>
          <span className="wseg">
            <button className={`${followPlayhead ? 'on' : ''}${followPlayhead && followHeld ? ' held' : ''}`}
              aria-pressed={followPlayhead}
              title={followPlayhead && followHeld
                ? 'Following is holding off while you look elsewhere · press to go back to the playhead'
                : 'Keep the playhead in view while playing'}
              onClick={onFollow}>FOLLOW</button>
            <button title="Zoom out · mouse wheel, or Ctrl+wheel where the page scrolls" aria-label="Zoom out"
              onClick={() => { zoomBy(1.6); movedByHand(); }}>−</button>
            <button title="Zoom in · mouse wheel, or Ctrl+wheel where the page scrolls" aria-label="Zoom in"
              onClick={() => { zoomBy(1 / 1.6); movedByHand(); }}>+</button>
            <button title="Fit the whole track" onClick={() => clampView(0, dur())} disabled={!zoomed}>FIT</button>
          </span>
        </div>
      </div>
      <div className="waveframe frame" ref={wrapRef}>
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>
        <canvas ref={canvasRef} />
        <div
          ref={gripStartRef}
          className={`wtrim wtrim-start${cutHead ? ' set' : ''}${trimActive === 'start' ? ' active' : ''}`}
          role="slider" tabIndex={0} aria-orientation="horizontal"
          aria-label="Trim the start"
          aria-valuemin={0} aria-valuemax={+Math.max(0, keepEnd - 1).toFixed(3)} aria-valuenow={+keepStart.toFixed(3)}
          aria-valuetext={cutHead ? `${timecode(keepStart, 1)}, ${spanText(keepStart).toLowerCase()} cut from the start` : 'Start of the track, nothing cut'}
          title="Top: drag to cut the start of the track · arrow keys 0.1 s, Shift 1 s · double-click to restore"
          {...gripProps('start')}
        >
          <span className="wtrim-bar" />
          <span className="wtrim-label">IN {timecode(keepStart, 2)}</span>
        </div>
        <div
          ref={gripEndRef}
          className={`wtrim wtrim-end${cutTail ? ' set' : ''}${trimActive === 'end' ? ' active' : ''}`}
          role="slider" tabIndex={0} aria-orientation="horizontal"
          aria-label="Trim the end"
          aria-valuemin={+Math.min(d, keepStart + 1).toFixed(3)} aria-valuemax={+d.toFixed(3)} aria-valuenow={+keepEnd.toFixed(3)}
          aria-valuetext={cutTail ? `${timecode(keepEnd, 1)}, ${spanText(d - keepEnd).toLowerCase()} cut from the end` : 'End of the track, nothing cut'}
          title="Tail: drag to cut the end of the track · arrow keys 0.1 s, Shift 1 s · double-click to restore"
          {...gripProps('end')}
        >
          <span className="wtrim-bar" />
          <span className="wtrim-label">OUT {timecode(keepEnd, 2)}</span>
        </div>
        {loading && (
          <div className="wave-loading" role="status">
            <span className="spec" title={loadingName ?? undefined}
              style={{ maxWidth: '80%', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--well-text)' }}>
              LOADING {(loadingName ?? '').toUpperCase()}
            </span>
            <div className="loadbar"><span /></div>
            <span className="spec" style={{ color: 'var(--text-accent)' }}>{loadPhase ?? ''}</span>
          </div>
        )}
      </div>
    </section>
  );
}
