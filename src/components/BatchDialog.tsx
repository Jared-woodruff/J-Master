// Batch album processing: queue tracks, apply the current console settings to
// every one, render sequentially, save into a chosen folder.
import { useStore, encodeOptionsFrom, findPreset, consoleMatchesPreset } from '../state/store';
import { MetaFields } from './MetaFields';
import { FormatPicker } from './FormatPicker';
import { effectiveBitDepth, effectiveRate } from '../audio/encode';
import { PRESETS } from '../audio/dsp/params';
import { lufsText } from '../lib/level-text';
import { useSheetFocus } from '../lib/use-sheet-focus';

export function BatchDialog() {
  const open = useStore((s) => s.batchOpen);
  const items = useStore((s) => s.batchItems);
  const running = useStore((s) => s.batchRunning);
  const dir = useStore((s) => s.batchDir);
  const targetLufs = useStore((s) => s.targetLufs);
  const userPresets = useStore((s) => s.userPresets);
  const consoleName = useStore((s) => {
    const base = findPreset(s, s.presetId ?? s.lastPresetId);
    if (!base) return 'CUSTOM';
    return consoleMatchesPreset(s, base) ? base.name : `${base.name} (MODIFIED)`;
  });
  const openBatch = useStore((s) => s.openBatch);
  const addBatchFiles = useStore((s) => s.addBatchFiles);
  const clearBatch = useStore((s) => s.clearBatch);
  const chooseBatchDir = useStore((s) => s.chooseBatchDir);
  const startBatch = useStore((s) => s.startBatch);
  const cancelBatch = useStore((s) => s.cancelBatch);
  // Re-render when the delivery format changes (the subtitle names it).
  useStore((s) => `${s.exportFormat}:${s.exportBitDepth}:${s.exportRate}:${s.exportMp3Kbps}:${s.exportOpusKbps}`);
  const removeBatchItem = useStore((s) => s.removeBatchItem);
  const assembling = useStore((s) => s.albumAssembling !== null);
  const toggleItemFixes = useStore((s) => s.toggleItemFixes);
  const dragging = useStore((s) => s.fileDrag !== null && s.fileDrag.images < s.fileDrag.count) && !running;

  const sheetRef = useSheetFocus<HTMLDivElement>(open);

  if (!open) return null;

  const hasBridge = Boolean((window as any).jmaster?.chooseDirectory);
  const encode = encodeOptionsFrom(useStore.getState());
  const fmtLabel = encode.format === 'mp3' ? `MP3 ${encode.mp3Kbps}`
    : encode.format === 'opus' ? `OPUS ${encode.opusKbps}`
    : `${encode.format.toUpperCase()} ${effectiveRate(encode) === 44100 ? '44.1K' : '48K'}/${effectiveBitDepth(encode) === 32 ? '32F' : effectiveBitDepth(encode)}`;
  const subtitle = `APPLIES CURRENT CONSOLE · ${consoleName} · ${targetLufs.toFixed(1)} LUFS · ${fmtLabel}`;
  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'failed').length;
  // The whole run as one figure: finished tracks plus the one in hand.
  const overall = items.length > 0
    ? items.reduce((a, i) => a + (i.status === 'done' || i.status === 'failed' ? 1 : i.status === 'working' ? i.pct : 0), 0) / items.length
    : 0;
  const statusWord = (st: string) => (st === 'done' ? 'Mastered' : st === 'failed' ? 'Failed' : st === 'working' ? 'Rendering' : 'Waiting');

  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget && !running) openBatch(false); }}>
      <div className="dialog frame" role="dialog" aria-modal="true" tabIndex={-1} ref={sheetRef} aria-label="Batch master" style={{ width: 620 }}>
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>

        <div>
          <div className="display dtitle">Batch master</div>
          <div className="spec dsub" title={subtitle}>
            {subtitle}
          </div>
        </div>

        <div className="drow">
          <button className="btn btn-sm btn-secondary" disabled={running} onClick={() => void addBatchFiles()}>ADD TRACKS</button>
          <button className="btn btn-sm btn-ghost" disabled={running || items.length === 0} onClick={clearBatch}>CLEAR</button>
          <span className="grow" style={{ flex: 1 }} />
          {running && (
            <span className="spec" role="status">{Math.round(overall * 100)}% OF THE RUN</span>
          )}
        </div>
        <div className="drow fmtrow">
          <FormatPicker disabled={running} compact />
        </div>

        <MetaFields disabled={running} />

        {hasBridge && (
          <div className="drow">
            <span className="spec" style={{ width: 64 }}>OUTPUT</span>
            <span className="spec-value path-tail" style={{ flex: 1 }} title={dir ?? undefined}>
              <bdi>{dir ?? 'CHOOSE A FOLDER'}</bdi>
            </span>
            <button className="btn btn-sm btn-secondary" disabled={running} onClick={() => void chooseBatchDir()}>CHOOSE</button>
          </div>
        )}

        <div className={`batchlist ${dragging ? 'dragover' : ''}`}>
          {(items.length === 0 || dragging) && (
            <div className="spec" style={{ padding: 'var(--space-4)', textAlign: 'center', color: dragging ? 'var(--text-accent)' : undefined }}>
              {dragging ? 'DROP TO QUEUE · AUDIO FILES ONLY' : 'DROP TRACKS ANYWHERE ON THIS DIALOG · OR ADD TRACKS'}
            </div>
          )}
          {items.map((it, idx) => (
            <div key={it.id} className="batchrow">
              <span className="border" style={{ display: 'inline-flex', flexDirection: 'column', gap: 1 }}>
                <button className="breorder" disabled={running || idx === 0} aria-label={`Move ${it.name} up`}
                  onClick={() => useStore.getState().moveBatchItem(it.id, -1)} title="Move up">▲</button>
                <button className="breorder" disabled={running || idx === items.length - 1} aria-label={`Move ${it.name} down`}
                  onClick={() => useStore.getState().moveBatchItem(it.id, 1)} title="Move down">▼</button>
              </span>
              <span className="spec" style={{ width: 22 }}>{(idx + 1).toString().padStart(2, '0')}</span>
              <span
                role="img" aria-label={statusWord(it.status)}
                className={`lamp ${
                  it.status === 'done' ? 'run' : it.status === 'failed' ? 'fault' : it.status === 'working' ? 'signal' : ''
                }`}
              />
              <span className="bname" title={it.name}>{it.name}</span>
              <select
                className="bselect"
                // A preset that no longer exists reads as what it now is: the console.
                value={findPreset({ userPresets }, it.presetId) ? it.presetId ?? '' : ''}
                disabled={running}
                title="Sound for this track: the current console, one of your presets, or a genre"
                onChange={(e) => useStore.getState().setBatchItemPreset(it.id, e.target.value || null)}
              >
                <option value="">CONSOLE</option>
                {userPresets.length > 0 && (
                  <optgroup label="YOURS">
                    {userPresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </optgroup>
                )}
                <optgroup label="GENRES">
                  {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </optgroup>
              </select>
              {it.scanned && it.fixes && it.fixes.length > 0 && it.status === 'pending' && (
                <button
                  className={`bfix ${it.fixesEnabled ? 'on' : ''}`} aria-pressed={it.fixesEnabled}
                  disabled={running}
                  title={`Diagnosed: ${it.fixes.map((f) => f.fixLabel).join(' · ')} · click to ${it.fixesEnabled ? 'skip' : 'apply'}`}
                  onClick={() => toggleItemFixes(it.id)}
                >
                  <span className={`lamp ${it.fixesEnabled ? 'warn' : ''}`} style={{ width: 6, height: 6 }} />
                  FIX {it.fixes.length}
                </button>
              )}
              <span className="spec bphase" title={it.error ?? it.outPath}
                style={it.error ? { color: 'var(--fault-500)' } : it.phase.includes('SHORT') ? { color: 'var(--text-warn)' } : undefined}>
                {it.status === 'done' && it.outLufs !== undefined
                  ? lufsText(it.outLufs)
                  : it.error
                    ? it.error
                    : it.phase}
              </span>
              <div className="meter-track" style={{ width: 90, flex: 'none' }}>
                <div
                  className={`meter-fill ${it.status === 'failed' ? 'warn' : 'accent'}`}
                  style={{ width: `${Math.round(it.pct * 100)}%` }}
                />
              </div>
              <button className="bremove" disabled={running || assembling} aria-label={`Remove ${it.name} from the queue`}
                title="Take this track out of the queue" onClick={() => removeBatchItem(it.id)}>×</button>
            </div>
          ))}
        </div>

        <div className="drow" style={{ justifyContent: 'space-between' }}>
          <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="spec">{items.length} TRACKS · {done} DONE{failed ? ` · ${failed} FAILED` : ''}</span>
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
