// ALBUM / CD — assemble the batch queue into a replication-ready package:
// one 44.1 kHz / 16-bit image WAV with frame-aligned tracks, a CUE sheet
// carrying CD-TEXT / ISRC / UPC, and a manifest. (Reorder tracks in BATCH.)
import { useStore } from '../state/store';

export function AlbumDialog() {
  const open = useStore((s) => s.albumOpen);
  const items = useStore((s) => s.batchItems);
  const upc = useStore((s) => s.albumUpc);
  const gap = useStore((s) => s.albumGapSec);
  const assembling = useStore((s) => s.albumAssembling);
  const result = useStore((s) => s.albumResult);
  const dir = useStore((s) => s.batchDir);
  const meta = useStore((s) => s.meta);
  const openAlbum = useStore((s) => s.openAlbum);
  const setAlbumUpc = useStore((s) => s.setAlbumUpc);
  const setAlbumGap = useStore((s) => s.setAlbumGap);
  const setItemIsrc = useStore((s) => s.setItemIsrc);
  const chooseBatchDir = useStore((s) => s.chooseBatchDir);
  const assembleAlbum = useStore((s) => s.assembleAlbum);

  if (!open) return null;

  const busy = assembling !== null;
  const hasBridge = Boolean((window as any).jmaster?.appendFile);

  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget && !busy) openAlbum(false); }}>
      <div className="dialog frame" role="dialog" aria-label="Album assembly" style={{ width: 560 }}>
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>

        <div>
          <div className="display dtitle">Album / CD</div>
          <div className="spec" style={{ marginTop: 4 }}>
            {meta.album ? meta.album.toUpperCase() : 'SET ALBUM NAME IN METADATA'} ·
            {' '}{items.length} TRACKS · 44.1 KHZ / 16-BIT IMAGE + CUE
          </div>
        </div>

        {!hasBridge && (
          <div className="spec" style={{ color: 'var(--fault-500)' }}>
            ALBUM ASSEMBLY REQUIRES THE DESKTOP APP.
          </div>
        )}

        <div className="drow">
          <span className="spec" style={{ width: 64 }}>UPC/EAN</span>
          <input type="text" value={upc} disabled={busy} placeholder="13 digits"
            style={{ maxWidth: 140, flex: 'none' }} spellCheck={false}
            onChange={(e) => setAlbumUpc(e.target.value)} />
          <span className="spec" style={{ width: 46, textAlign: 'right' }}>GAP</span>
          <div className="stepper">
            <button disabled={busy} onClick={() => setAlbumGap(gap - 0.5)}>−</button>
            <span className="val">{gap.toFixed(1)}s</span>
            <button disabled={busy} onClick={() => setAlbumGap(gap + 0.5)}>+</button>
          </div>
          <span className="spec">BETWEEN TRACKS</span>
        </div>

        <div className="batchlist" style={{ maxHeight: 220 }}>
          {items.length === 0 && (
            <div className="spec" style={{ padding: 'var(--space-4)', textAlign: 'center' }}>
              QUEUE TRACKS IN BATCH FIRST · ORDER THERE = ALBUM ORDER
            </div>
          )}
          {items.map((it, idx) => (
            <div key={it.id} className="batchrow">
              <span className="spec" style={{ width: 22 }}>{String(idx + 1).padStart(2, '0')}</span>
              <span className="bname">{it.name.replace(/\.[^.]+$/, '')}</span>
              <span className="spec">ISRC</span>
              <input
                type="text" value={it.isrc ?? ''} disabled={busy}
                placeholder="AUJMW2600001" spellCheck={false}
                style={{ width: 128, flex: 'none', height: 22, fontSize: 10, padding: '0 6px' }}
                onChange={(e) => setItemIsrc(it.id, e.target.value)}
              />
            </div>
          ))}
        </div>

        {hasBridge && (
          <div className="drow">
            <span className="spec" style={{ width: 64 }}>OUTPUT</span>
            <span className="spec-value" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {dir ?? '— choose a folder —'}
            </span>
            <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void chooseBatchDir()}>CHOOSE</button>
          </div>
        )}

        {busy && assembling && (
          <div>
            <div className="drow" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="spec">{assembling.phase}</span>
              <span className="spec-value">{Math.round(assembling.pct * 100)}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${assembling.pct * 100}%` }} />
            </div>
          </div>
        )}

        {result && (
          <div className="statgrid">
            <div className="row">
              <span className="spec">IMAGE</span><span className="leader" />
              <span className="spec-value" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>{result.imagePath}</span>
            </div>
            <div className="row">
              <span className="spec">RUNTIME</span><span className="leader" />
              <span className="spec-value">{result.totalMin.toFixed(1)} MIN {result.totalMin > 79.5 ? '· OVER CD-80 LIMIT' : ''}</span>
            </div>
          </div>
        )}

        <div className="drow" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-secondary" disabled={busy} onClick={() => openAlbum(false)}>
            {result ? 'DONE' : 'CLOSE'}
          </button>
          {!result && (
            <button className="btn btn-accent" disabled={busy || items.length === 0 || !hasBridge}
              onClick={() => void assembleAlbum()}>
              {busy ? 'ASSEMBLING…' : 'ASSEMBLE CD IMAGE →'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
