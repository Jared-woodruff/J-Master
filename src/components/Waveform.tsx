// The waveform plate: multi-resolution peak rendering with wheel zoom around
// the cursor, pan, an overview strip when zoomed, playhead follow, click/scrub
// seeking, and draggable fade handles with live curve overlays.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { engine } from '../audio/engine';
import { fadeGainAt } from '../audio/dsp/fades';

const RULER_H = 20;
const OVERVIEW_H = 11;
const HANDLE = 9;

type DragMode = 'seek' | 'fadeIn' | 'fadeOut' | 'view' | null;

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
  const dragMode = useRef<DragMode>(null);
  const hoverX = useRef<number | null>(null);
  const view = useRef({ start: 0, end: 1 });
  const specCanvas = useRef<HTMLCanvasElement | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [specComputing, setSpecComputing] = useState(false);
  const source = useStore((s) => s.source);
  const waveView = useStore((s) => s.waveView);
  const setWaveView = useStore((s) => s.setWaveView);
  const gridEnabled = useStore((s) => s.gridEnabled);
  const setGridEnabled = useStore((s) => s.setGridEnabled);
  const hasTempo = useStore((s) => s.tempo !== null);
  const loudnessLane = useStore((s) => s.loudnessLane);
  const setLoudnessLane = useStore((s) => s.setLoudnessLane);
  const processedView = useStore((s) => s.processedView);
  const setProcessedView = useStore((s) => s.setProcessedView);
  const outSplit = useStore((s) => s.outSplit);
  const setOutSplit = useStore((s) => s.setOutSplit);
  const loopOn = useStore((s) => s.loopStartSec !== null);
  const toggleLoop = useStore((s) => s.toggleLoop);

  // Compute the spectrogram lazily the first time SPEC is selected.
  useEffect(() => {
    if (waveView !== 'spec' || !source) return;
    if (specCanvas.current) return;
    setSpecComputing(true);
    void engine.requestSpectrogram().then((sg) => {
      if (sg) specCanvas.current = buildSpecCanvas(sg);
      setSpecComputing(false);
    });
  }, [waveView, source]);

  // New track invalidates the cached image.
  useEffect(() => { specCanvas.current = null; }, [source]);

  // Reset the view whenever a new track lands.
  useEffect(() => {
    if (source) {
      view.current = { start: 0, end: source.durationSec };
      setZoomed(false);
    }
  }, [source]);

  const dur = () => useStore.getState().source?.durationSec ?? 1;

  const clampView = (start: number, end: number) => {
    const d = dur();
    const w = wrapRef.current?.clientWidth ?? 1200;
    const minLen = Math.min(d, (w * 128) / engine.sampleRate);
    let len = Math.max(minLen, Math.min(d, end - start));
    let s = Math.max(0, Math.min(d - len, start));
    view.current = { start: s, end: s + len };
    setZoomed(len < d - 1e-6);
  };

  const zoomBy = (factor: number, anchorFrac = 0.5) => {
    const v = view.current;
    const len = v.end - v.start;
    const newLen = len * factor;
    const anchorSec = v.start + len * anchorFrac;
    clampView(anchorSec - newLen * anchorFrac, anchorSec + newLen * (1 - anchorFrac));
  };

  // ── drawing ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || !source) return;

    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let w = 0, h = 0, dpr = 1;

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      w = wrap.clientWidth;
      h = wrap.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const css = () => getComputedStyle(document.documentElement);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const st = useStore.getState();
      const wf = engine.waveform;
      if (!wf || w === 0) return;
      const s = css();
      const colWell = s.getPropertyValue('--surface-well').trim() || '#0A0B0D';
      const colBar = s.getPropertyValue('--wave-bar').trim() || '#3D4248';
      const colRms = s.getPropertyValue('--wave-rms').trim() || '#565B61';
      const colSignal = s.getPropertyValue('--signal-500').trim() || '#FF4D00';
      const colHair = s.getPropertyValue('--border-hairline').trim() || '#26292E';
      const colSpec = s.getPropertyValue('--graphite-400').trim() || '#878D93';

      const d = st.source?.durationSec ?? 1;
      const v = view.current;
      const viewLen = v.end - v.start;
      const isZoomed = viewLen < d - 1e-6;
      const fs = engine.sampleRate;

      // Playhead follow while playing.
      if (st.playing) {
        if (st.playheadSec > v.end - viewLen * 0.02 && v.end < d - 1e-6) {
          clampView(st.playheadSec - viewLen * 0.1, st.playheadSec + viewLen * 0.9);
        } else if (st.playheadSec < v.start) {
          clampView(st.playheadSec - viewLen * 0.1, st.playheadSec + viewLen * 0.9);
        }
      }

      const topY = isZoomed ? OVERVIEW_H + 2 : 0;
      const waveH = h - RULER_H - topY;
      const midY = topY + waveH / 2;
      const secToX = (sec: number) => ((sec - v.start) / viewLen) * w;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.font = `8px 'IBM Plex Mono', monospace`;
        ctx.textBaseline = 'bottom';
        for (const [f, label] of [[100, '100'], [1000, '1K'], [10000, '10K']] as [number, string][]) {
          const y = topY + waveH * (1 - Math.log(f / 20) / Math.log(1000));
          ctx.fillRect(0, y, w, 1);
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
          rm = Math.sqrt(rm / cnt);
          const played = x <= playX;
          ctx.fillStyle = played ? 'rgba(255,77,0,0.42)' : colBar;
          const y0 = srcMid - mx * srcAmp;
          const y1 = srcMid - mn * srcAmp;
          ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
          ctx.fillStyle = played ? colSignal : colRms;
          ctx.fillRect(x, srcMid - rm * srcAmp, 1, Math.max(1, rm * 2 * srcAmp));
        }
      }

      // bar/beat grid from the detected tempo, anchored to the first bar
      if (st.gridEnabled && st.tempo && st.tempo.bpm > 0) {
        const beatSec = 60 / st.tempo.bpm;
        const barSec = beatSec * 4;
        const anchor = st.tempo.firstBarSec ?? st.tempo.firstBeatSec;
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
              ctx.fillStyle = specMode ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.3)';
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
        // processed master's loudness line over the source's
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
        ctx.font = `7px 'IBM Plex Mono', monospace`;
        ctx.textBaseline = 'top';
        ctx.fillText(ppLane ? 'ST LUFS · SRC ▬ OUT —' : 'ST LUFS · SRC', 3, laneY + 2);
      }

      // processed-master lane (OUT): ghosted over the source, or in its own
      // lane below it when SPLIT is on.
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

      // fades
      const fi = st.fadeInSec;
      const fo = st.fadeOutSec;
      const drawCurve = (fromSec: number, toSec: number) => {
        const x0 = Math.max(0, secToX(fromSec));
        const x1 = Math.min(w, secToX(toSec));
        if (x1 <= x0) return;
        ctx.strokeStyle = colSignal;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let x = x0; x <= x1; x += 2) {
          const sec = v.start + (x / w) * viewLen;
          const g = fadeGainAt(sec, fi, fo, st.fadeInCurve, st.fadeOutCurve, d);
          const y = topY + waveH * (1 - g * 0.94) - waveH * 0.015;
          if (x === x0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };
      if (fi > 0) {
        const fx = secToX(fi);
        if (fx > 0) {
          ctx.fillStyle = 'rgba(13,14,16,0.55)';
          ctx.fillRect(0, topY, Math.min(fx, w), waveH);
        }
        drawCurve(0, fi);
      }
      if (fo > 0) {
        const fx = secToX(d - fo);
        if (fx < w) {
          ctx.fillStyle = 'rgba(13,14,16,0.55)';
          ctx.fillRect(Math.max(0, fx), topY, w - Math.max(0, fx), waveH);
        }
        drawCurve(d - fo, d);
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
      drawHandle(fi, fi > 0);
      drawHandle(d - fo, fo > 0);

      // loop region: boundary rules + a band on the ruler
      if (st.loopStartSec !== null && st.loopEndSec !== null) {
        const lx0 = secToX(st.loopStartSec);
        const lx1 = secToX(st.loopEndSec);
        ctx.fillStyle = colSignal;
        ctx.globalAlpha = 0.8;
        if (lx0 >= 0 && lx0 <= w) ctx.fillRect(lx0, topY, 1, waveH);
        if (lx1 >= 0 && lx1 <= w) ctx.fillRect(lx1 - 1, topY, 1, waveH);
        ctx.globalAlpha = 0.16;
        ctx.fillRect(Math.max(0, lx0), h - RULER_H + 1, Math.min(w, lx1) - Math.max(0, lx0), RULER_H - 1);
        ctx.globalAlpha = 1;
        if (lx0 < w && lx1 > 0) {
          ctx.font = `8px 'IBM Plex Mono', monospace`;
          ctx.textBaseline = 'top';
          ctx.fillText('LOOP', Math.max(2, lx0) + 4, topY + 2);
        }
      }

      // hover readout: time (+ short-term LUFS when the lane is computed)
      if (hoverX.current !== null && dragMode.current === null && !specMode) {
        const sec = v.start + (hoverX.current / w) * viewLen;
        const mm = Math.floor(sec / 60);
        const ss = (sec % 60).toFixed(1).padStart(4, '0');
        let text = `${mm}:${ss}`;
        const hLane = engine.loudnessLane;
        if (hLane && hLane.values.length > 1) {
          const idx = Math.max(0, Math.min(hLane.values.length - 1, Math.round(sec / hLane.stepSec)));
          const lv = hLane.values[idx];
          if (lv > -60) text += ` · ${lv.toFixed(1)} LUFS`;
        }
        ctx.font = `9px 'IBM Plex Mono', monospace`;
        ctx.textBaseline = 'top';
        const tw = ctx.measureText(text).width;
        const tx = hoverX.current + 6 + tw > w ? hoverX.current - tw - 6 : hoverX.current + 6;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
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
      if (hoverX.current !== null && dragMode.current === null) {
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath();
        ctx.moveTo(hoverX.current + 0.5, topY);
        ctx.lineTo(hoverX.current + 0.5, topY + waveH);
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
          const a = Math.max(Math.abs(coarse.maxs[b]), Math.abs(coarse.mins[b])) * oAmp;
          ctx.fillRect(x, oMid - a, 2, Math.max(1, a * 2));
        }
        const wx0 = (v.start / d) * w;
        const wx1 = (v.end / d) * w;
        ctx.fillStyle = 'rgba(255,77,0,0.18)';
        ctx.fillRect(wx0, 0, wx1 - wx0, OVERVIEW_H);
        ctx.strokeStyle = colSignal;
        ctx.lineWidth = 1;
        ctx.strokeRect(wx0 + 0.5, 0.5, wx1 - wx0 - 1, OVERVIEW_H - 1);
        ctx.fillStyle = colHair;
        ctx.fillRect(0, OVERVIEW_H + 1, w, 1);
      }

      // time ruler over the current view
      const rulerY = h - RULER_H;
      ctx.fillStyle = colHair;
      ctx.fillRect(0, rulerY, w, 1);
      ctx.fillStyle = colSpec;
      ctx.font = `9px 'IBM Plex Mono', monospace`;
      ctx.textBaseline = 'middle';
      const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
      const stepSec = steps.find((sv) => viewLen / sv <= 12) ?? 600;
      const first = Math.ceil(v.start / stepSec) * stepSec;
      for (let t = first; t <= v.end; t += stepSec) {
        const x = secToX(t);
        ctx.fillRect(x, rulerY, 1, 4);
        const mm = Math.floor(t / 60);
        const ss = (t % 60).toFixed(stepSec < 1 ? 1 : 0).padStart(2, '0');
        ctx.fillText(`${mm}:${ss}`, Math.min(x + 4, w - 34), rulerY + RULER_H / 2 + 1);
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
    const secAt = (clientX: number) => {
      const r = rect();
      const x = Math.max(0, Math.min(r.width, clientX - r.left));
      const v = view.current;
      return v.start + (x / r.width) * (v.end - v.start);
    };
    const xOf = (sec: number) => {
      const r = rect();
      const v = view.current;
      return ((sec - v.start) / (v.end - v.start)) * r.width;
    };

    const hitHandle = (clientX: number, clientY: number): 'fadeIn' | 'fadeOut' | null => {
      const r = rect();
      const y = clientY - r.top;
      const topY = isZoomed() ? OVERVIEW_H + 2 : 0;
      if (y < topY || y > topY + 26) return null;
      const x = clientX - r.left;
      const s = st();
      const d = s.source?.durationSec ?? 1;
      if (Math.abs(x - xOf(s.fadeInSec)) < 10) return 'fadeIn';
      if (Math.abs(x - xOf(d - s.fadeOutSec)) < 10) return 'fadeOut';
      return null;
    };

    const panViewTo = (clientX: number) => {
      const r = rect();
      const d = st().source?.durationSec ?? 1;
      const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      const len = view.current.end - view.current.start;
      const center = frac * d;
      clampView(center - len / 2, center + len / 2);
    };

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      const y = e.clientY - rect().top;
      if (isZoomed() && y <= OVERVIEW_H + 1) {
        dragMode.current = 'view';
        panViewTo(e.clientX);
        return;
      }
      const handle = hitHandle(e.clientX, e.clientY);
      if (handle) {
        dragMode.current = handle;
      } else {
        dragMode.current = 'seek';
        st().seekSec(secAt(e.clientX));
      }
    };
    const onMove = (e: PointerEvent) => {
      const r = rect();
      hoverX.current = e.clientX - r.left;
      const s = st();
      if (dragMode.current === 'seek') {
        s.seekSec(secAt(e.clientX));
      } else if (dragMode.current === 'fadeIn') {
        s.setFade('in', secAt(e.clientX));
      } else if (dragMode.current === 'fadeOut') {
        const d = s.source?.durationSec ?? 0;
        s.setFade('out', d - secAt(e.clientX));
      } else if (dragMode.current === 'view') {
        panViewTo(e.clientX);
      } else {
        const y = e.clientY - r.top;
        canvas.style.cursor =
          isZoomed() && y <= OVERVIEW_H + 1 ? 'grab'
          : hitHandle(e.clientX, e.clientY) ? 'ew-resize'
          : 'crosshair';
      }
    };
    const onUp = () => { dragMode.current = null; };
    const onLeave = () => { hoverX.current = null; };
    const onDbl = (e: MouseEvent) => {
      const y = e.clientY - rect().top;
      if (isZoomed() && y <= OVERVIEW_H + 1) return;
      st().toggleLoop(secAt(e.clientX));
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = rect();
      if (e.shiftKey) {
        const len = view.current.end - view.current.start;
        const shift = (e.deltaY > 0 ? 1 : -1) * len * 0.12;
        clampView(view.current.start + shift, view.current.end + shift);
      } else {
        const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        zoomBy(e.deltaY > 0 ? 1.3 : 1 / 1.3, frac);
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('dblclick', onDbl);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [source]);

  if (!source) return null;

  const specLine = `SOURCE · ${(source.originalSampleRate / 1000).toFixed(1)} KHZ${
    source.originalBitDepth ? ` · ${source.originalBitDepth} BIT` : ''
  } · ${source.channels === 2 ? 'STEREO' : 'MONO'} · ${source.lufs.toFixed(1)} LUFS IN`;

  return (
    <section className="wavesection">
      <div className="waveframe frame" ref={wrapRef}>
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>
        <span className="spec wave-spec-tl" style={zoomed ? { top: OVERVIEW_H + 6 } : undefined}>
          {specComputing ? 'ANALYSING SPECTRUM…'
            : processedView && engine.previewPending ? 'RENDERING MASTER PREVIEW…'
            : specLine}
        </span>
        <div className="wave-controls" style={zoomed ? { top: OVERVIEW_H + 4 } : undefined}>
          <button className={waveView === 'wave' ? 'on' : ''} title="Waveform view"
            onClick={() => setWaveView('wave')}>WAVE</button>
          <button className={waveView === 'spec' ? 'on' : ''} title="Spectrogram view (source)"
            onClick={() => setWaveView('spec')}>SPEC</button>
          <button className={gridEnabled && hasTempo ? 'on' : ''} disabled={!hasTempo}
            title="Bar/beat grid from detected tempo"
            onClick={() => setGridEnabled(!gridEnabled)}>GRID</button>
          <button className={loudnessLane ? 'on' : ''}
            title="Short-term loudness lane (source)"
            onClick={() => setLoudnessLane(!loudnessLane)}>LUFS</button>
          <button className={processedView ? 'on' : ''}
            title="Show the processed master's waveform + loudness (recomputes as you adjust)"
            onClick={() => setProcessedView(!processedView)}>OUT</button>
          {processedView && (
            <button className={outSplit ? 'on' : ''}
              title="Split compare: source above, master below"
              onClick={() => setOutSplit(!outSplit)}>SPLIT</button>
          )}
          <button className={loopOn ? 'on' : ''}
            title="Loop the section under the playhead (L) · double-click the wave to loop a section"
            onClick={() => toggleLoop()}>LOOP</button>
          <button title="Zoom out (wheel)" onClick={() => zoomBy(1.6)}>−</button>
          <button title="Zoom in (wheel)" onClick={() => zoomBy(1 / 1.6)}>+</button>
          <button title="Fit whole track" onClick={() => clampView(0, dur())} disabled={!zoomed}>FIT</button>
        </div>
        <canvas ref={canvasRef} />
      </div>
    </section>
  );
}
