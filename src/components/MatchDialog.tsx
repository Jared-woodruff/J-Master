// REFERENCE MATCH — load a track you want to sound like; J-Master measures
// its spectral balance, loudness and width against the source and derives a
// capped ±6 dB correction curve plus target/width suggestions.
import { useEffect, useRef } from 'react';
import { useStore } from '../state/store';
import { MATCH_EQ_CENTERS } from '../audio/dsp/params';
import { lufsText } from '../lib/level-text';
import { palette } from '../lib/palette';
import { useSheetFocus } from '../lib/use-sheet-focus';

export function MatchDialog() {
  const open = useStore((s) => s.matchOpen);
  const source = useStore((s) => s.source);
  const matchRef = useStore((s) => s.matchRef);
  const loading = useStore((s) => s.matchLoading);
  const active = useStore((s) => s.matchEqGains.length > 0);
  const openMatch = useStore((s) => s.openMatch);
  const loadReference = useStore((s) => s.loadReference);
  const applyMatch = useStore((s) => s.applyMatch);
  const clearMatch = useStore((s) => s.clearMatch);
  const dragging = useStore((s) => s.fileDrag !== null && s.fileDrag.images < s.fileDrag.count) && !loading;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Correction-curve plot. The canvas mounts afresh each time the sheet
  // opens, so the plot redraws on open as well as on a new reference.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!open || !canvas || !matchRef) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pal = palette();
    ctx.fillStyle = pal.well;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = pal.hair;
    ctx.fillRect(0, h / 2, w, 1);
    for (const db of [-6, -3, 3, 6]) {
      ctx.globalAlpha = 0.4;
      ctx.fillRect(0, h / 2 - (db / 8) * (h / 2), w, 1);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = pal.signal;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    matchRef.deltaGains.forEach((g, i) => {
      const x = ((i + 0.5) / matchRef.deltaGains.length) * w;
      const y = h / 2 - (g / 8) * (h / 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = pal.spec;
    ctx.font = `8px 'IBM Plex Mono', monospace`;
    ctx.textBaseline = 'bottom';
    MATCH_EQ_CENTERS.forEach((f, i) => {
      const x = ((i + 0.5) / MATCH_EQ_CENTERS.length) * w;
      ctx.fillText(f >= 1000 ? `${f / 1000}K` : `${f}`, x - 8, h - 2);
    });
  }, [matchRef, open]);

  const sheetRef = useSheetFocus<HTMLDivElement>(open);

  if (!open || !source) return null;

  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget && !loading) openMatch(false); }}>
      <div className="dialog frame" role="dialog" aria-modal="true" tabIndex={-1} ref={sheetRef} aria-label="Reference match" style={{ width: 520 }}>
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>

        <div>
          <div className="display dtitle">Reference match</div>
          <div className="spec" style={{ marginTop: 4 }}>
            SHAPE THIS MASTER TOWARD A TRACK YOU TRUST · ±6 DB CAP
          </div>
        </div>

        {dragging ? (
          <div className="dropband">
            <span className="spec" style={{ color: 'var(--text-accent)' }}>DROP TO USE AS THE REFERENCE</span>
          </div>
        ) : !matchRef && (
          <div className="spec" style={{ padding: '8px 0', whiteSpace: 'normal' }}>
            LOAD OR DROP A REFERENCE TRACK. ITS TONAL BALANCE, LOUDNESS AND WIDTH ARE
            MEASURED AGAINST {source.name.toUpperCase()}.
          </div>
        )}

        {matchRef && (
          <>
            <div className="statgrid">
              <div className="row">
                <span className="spec">REFERENCE</span>
                <span className="leader" />
                <span className="spec-value" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>{matchRef.name}</span>
              </div>
              <div className="row">
                <span className="spec">LOUDNESS</span>
                <span className="leader" />
                <span className="spec-value">REF {lufsText(matchRef.lufs)} · SRC {lufsText(source.lufs)}</span>
              </div>
              <div className="row">
                <span className="spec">WIDTH SUGGESTION</span>
                <span className="leader" />
                <span className="spec-value">{Math.round(matchRef.suggestedWidth * 100)}%</span>
              </div>
            </div>
            <div>
              <div className="boxlabel" style={{ marginBottom: 4 }}>
                <span className="spec">CORRECTION CURVE</span>
                <span className="spec">±6 DB</span>
              </div>
              <canvas ref={canvasRef} style={{ width: '100%', height: 110, display: 'block', border: '1px solid var(--border-hairline)' }} />
            </div>
          </>
        )}

        <div className="drow" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" disabled={loading} onClick={() => void loadReference()}>
              {loading ? 'ANALYSING…' : matchRef ? 'CHANGE REFERENCE' : 'LOAD REFERENCE'}
            </button>
            {active && (
              <button className="btn btn-ghost" onClick={clearMatch}>CLEAR MATCH</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" disabled={loading} onClick={() => openMatch(false)}>CLOSE</button>
            {matchRef && (
              <button className="btn btn-accent" disabled={loading} onClick={applyMatch}>APPLY MATCH →</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
