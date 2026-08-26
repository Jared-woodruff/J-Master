// Batch album processing: queue tracks, apply the current console settings to
// every one, render sequentially, save into a chosen folder.
import { useStore, encodeOptionsFrom } from '../state/store';
import { MetaFields } from './MetaFields';
import { PRESETS } from '../audio/dsp/params';

export function BatchDialog() {
  const open = useStore((s) => s.batchOpen);
  const items = useStore((s) => s.batchItems);
  const running = useStore((s) => s.batchRunning);
  const dir = useStore((s) => s.batchDir);
  const targetLufs = useStore((s) => s.targetLufs);
  const presetId = useStore((s) => s.presetId);
  const openBatch = useStore((s) => s.openBatch);
  const addBatchFiles = useStore((s) => s.addBatchFiles);
  const clearBatch = useStore((s) => s.clearBatch);
  const chooseBatchDir = useStore((s) => s.chooseBatchDir);
  const startBatch = useStore((s) => s.startBatch);
  const cancelBatch = useStore((s) => s.cancelBatch);
  const format = useStore((s) => s.exportFormat);
  const bitDepth = useStore((s) => s.exportBitDepth);
  const mp3Kbps = useStore((s) => s.exportMp3Kbps);
  const opusKbps = useStore((s) => s.exportOpusKbps);
  const setExportFormat = useStore((s) => s.setExportFormat);
  const setExportBitDepth = useStore((s) => s.setExportBitDepth);
  const setExportMp3Kbps = useStore((s) => s.setExportMp3Kbps);
  const setExportOpusKbps = useStore((s) => s.setExportOpusKbps);
  const toggleItemFixes = useStore((s) => s.toggleItemFixes);

  if (!open) return null;

  const hasBridge = Boolean((window as any).jmaster?.chooseDirectory);
  const encode = encodeOptionsFrom(useStore.getState());
  const fmtLabel = encode.format === 'mp3' ? `MP3 ${encode.mp3Kbps}` : `${encode.format.toUpperCase()} 48K/${encode.bitDepth}`;
  const done = items.filter((i) => i.status === 'done').length;

  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget && !running) openBatch(false); }}>
      <div
        className="dialog frame"
        role="dialog"
        aria-label="Batch master"
        style={{ width: 620 }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length) useStore.getState().addBatchDroppedFiles(files);
        }}
      >
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>

        <div>
          <div className="display dtitle">Batch master</div>
          <div className="spec" style={{ marginTop: 4 }}>
            APPLIES CURRENT CONSOLE · {presetId ? presetId.toUpperCase() : 'CUSTOM'} · {targetLufs.toFixed(1)} LUFS · {fmtLabel}
          </div>
        </div>

        <div className="drow">
          <button className="btn btn-sm btn-secondary" disabled={running} onClick={() => void addBatchFiles()}>ADD TRACKS</button>
          <button className="btn btn-sm btn-ghost" disabled={running || items.length === 0} onClick={clearBatch}>CLEAR</button>
          <span className="grow" style={{ flex: 1 }} />
          <div className="seg">
            <button className={format === 'wav' ? 'on' : ''} disabled={running} onClick={() => setExportFormat('wav')}>WAV</button>
            <button className={format === 'flac' ? 'on' : ''} disabled={running} onClick={() => setExportFormat('flac')}>FLAC</button>
            <button className={format === 'mp3' ? 'on' : ''} disabled={running} onClick={() => setExportFormat('mp3')}>MP3</button>
            <button className={format === 'opus' ? 'on' : ''} disabled={running} onClick={() => setExportFormat('opus')}>OPUS</button>
          </div>
          {format === 'wav' || format === 'flac' ? (
            <div className="seg">
              <button className={bitDepth === 24 ? 'on' : ''} disabled={running} onClick={() => setExportBitDepth(24)}>24</button>
              <button className={bitDepth === 16 ? 'on' : ''} disabled={running} onClick={() => setExportBitDepth(16)}>16</button>
            </div>
          ) : format === 'mp3' ? (
            <div className="seg">
              <button className={mp3Kbps === 320 ? 'on' : ''} disabled={running} onClick={() => setExportMp3Kbps(320)}>320</button>
              <button className={mp3Kbps === 256 ? 'on' : ''} disabled={running} onClick={() => setExportMp3Kbps(256)}>256</button>
              <button className={mp3Kbps === 192 ? 'on' : ''} disabled={running} onClick={() => setExportMp3Kbps(192)}>192</button>
            </div>
          ) : (
            <div className="seg">
              <button className={opusKbps === 256 ? 'on' : ''} disabled={running} onClick={() => setExportOpusKbps(256)}>256</button>
              <button className={opusKbps === 192 ? 'on' : ''} disabled={running} onClick={() => setExportOpusKbps(192)}>192</button>
              <button className={opusKbps === 128 ? 'on' : ''} disabled={running} onClick={() => setExportOpusKbps(128)}>128</button>
            </div>
          )}
        </div>

        <MetaFields disabled={running} />

        {hasBridge && (
          <div className="drow">
            <span className="spec" style={{ width: 64 }}>OUTPUT</span>
            <span className="spec-value" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {dir ?? '— choose a folder —'}
            </span>
            <button className="btn btn-sm btn-secondary" disabled={running} onClick={() => void chooseBatchDir()}>CHOOSE</button>
          </div>
        )}

        <div className="batchlist">
          {items.length === 0 && (
            <div className="spec" style={{ padding: 'var(--space-4)', textAlign: 'center' }}>
              DROP TRACKS HERE OR ADD TRACKS · WHOLE ALBUMS WELCOME
            </div>
          )}
          {items.map((it, idx) => (
            <div key={it.id} className="batchrow">
              <span className="border" style={{ display: 'inline-flex', flexDirection: 'column', gap: 1 }}>
                <button className="breorder" disabled={running || idx === 0}
                  onClick={() => useStore.getState().moveBatchItem(it.id, -1)} title="Move up">▲</button>
                <button className="breorder" disabled={running || idx === items.length - 1}
                  onClick={() => useStore.getState().moveBatchItem(it.id, 1)} title="Move down">▼</button>
              </span>
              <span className="spec" style={{ width: 22 }}>{(idx + 1).toString().padStart(2, '0')}</span>
              <span
                className={`lamp ${
                  it.status === 'done' ? 'run' : it.status === 'failed' ? 'fault' : it.status === 'working' ? 'signal' : ''
                }`}
              />
              <span className="bname">{it.name}</span>
              <select
                className="bselect"
                value={it.presetId ?? ''}
                disabled={running}
                title="Sound for this track: current console or a preset"
                onChange={(e) => useStore.getState().setBatchItemPreset(it.id, e.target.value || null)}
              >
                <option value="">CONSOLE</option>
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {it.scanned && it.fixes && it.fixes.length > 0 && it.status === 'pending' && (
                <button
                  className={`bfix ${it.fixesEnabled ? 'on' : ''}`}
                  disabled={running}
                  title={`Diagnosed: ${it.fixes.map((f) => f.fixLabel).join(' · ')} — click to ${it.fixesEnabled ? 'skip' : 'apply'}`}
                  onClick={() => toggleItemFixes(it.id)}
                >
                  <span className={`lamp ${it.fixesEnabled ? 'warn' : ''}`} style={{ width: 6, height: 6 }} />
                  FIX {it.fixes.length}
                </button>
              )}
              <span className="spec bphase">
                {it.status === 'done' && it.outLufs !== undefined
                  ? `${it.outLufs.toFixed(1)} LUFS`
                  : it.status === 'failed'
                    ? 'FAILED'
                    : it.phase}
              </span>
              <div className="meter-track" style={{ width: 90, flex: 'none' }}>
                <div
                  className={`meter-fill ${it.status === 'failed' ? 'warn' : 'accent'}`}
                  style={{ width: `${Math.round(it.pct * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="drow" style={{ justifyContent: 'space-between' }}>
          <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="spec">{items.length} TRACKS · {done} DONE</span>
            <button className="btn btn-sm btn-secondary" disabled={running || items.length === 0}
              onClick={() => { useStore.getState().openBatch(false); useStore.getState().openAlbum(true); }}
              title="Assemble this queue into a CD image + CUE sheet">
              ALBUM / CD…
            </button>
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            {!running && <button className="btn btn-secondary" onClick={() => openBatch(false)}>CLOSE</button>}
            {running ? (
              <button className="btn btn-secondary" onClick={cancelBatch}>STOP AFTER CURRENT</button>
            ) : (
              <button
                className="btn btn-accent"
                disabled={items.length === 0 || (hasBridge && !dir)}
                onClick={() => void startBatch()}
              >
                MASTER ALL →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
