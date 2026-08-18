import { useEffect, useState } from 'react';
import { useStore, masterFileName, encodeOptionsFrom } from '../state/store';
import { MetaFields } from './MetaFields';

export function ExportDialog() {
  const open = useStore((s) => s.exportOpen);
  const source = useStore((s) => s.source);
  const targetLufs = useStore((s) => s.targetLufs);
  const ceilingDb = useStore((s) => s.ceilingDb);
  const exporting = useStore((s) => s.exporting);
  const stats = useStore((s) => s.exportStats);
  const savedTo = useStore((s) => s.exportSavedTo);
  const openExport = useStore((s) => s.openExport);
  const startExport = useStore((s) => s.startExport);
  const format = useStore((s) => s.exportFormat);
  const bitDepth = useStore((s) => s.exportBitDepth);
  const mp3Kbps = useStore((s) => s.exportMp3Kbps);
  const opusKbps = useStore((s) => s.exportOpusKbps);
  const history = useStore((s) => s.exportHistory);
  const setExportFormat = useStore((s) => s.setExportFormat);
  const setExportBitDepth = useStore((s) => s.setExportBitDepth);
  const setExportMp3Kbps = useStore((s) => s.setExportMp3Kbps);
  const setExportOpusKbps = useStore((s) => s.setExportOpusKbps);
  const audition = useStore((s) => s.audition);
  const startAudition = useStore((s) => s.startAudition);
  const setAuditionMode = useStore((s) => s.setAuditionMode);
  const stopAudition = useStore((s) => s.stopAudition);

  const [fileName, setFileName] = useState('');
  const [title, setTitle] = useState('');

  useEffect(() => {
    if (open && source) {
      setFileName(masterFileName(source.name, encodeOptionsFrom(useStore.getState())));
    }
  }, [open, source, format, bitDepth, mp3Kbps, opusKbps]);

  useEffect(() => {
    if (open && source) setTitle(source.name.replace(/\.[^.]+$/, ''));
  }, [open, source]);

  if (!open || !source) return null;

  const busy = exporting !== null;
  const specLine =
    format === 'mp3'
      ? `48.0 KHZ · MP3 ${mp3Kbps} KBPS CBR · ${targetLufs.toFixed(1)} LUFS · ${ceilingDb.toFixed(1)} dBTP`
      : format === 'opus'
        ? `48.0 KHZ · OGG OPUS ${opusKbps} KBPS · ${targetLufs.toFixed(1)} LUFS · ${ceilingDb.toFixed(1)} dBTP`
        : `48.0 KHZ · ${bitDepth} BIT ${format.toUpperCase()} · ${targetLufs.toFixed(1)} LUFS · ${ceilingDb.toFixed(1)} dBTP`;

  return (
    <div className="scrim" onPointerDown={(e) => {
      if (e.target === e.currentTarget && !busy) {
        if (audition.active) stopAudition();
        openExport(false);
      }
    }}>
      <div className="dialog frame" role="dialog" aria-label="Export master">
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>

        <div>
          <div className="display dtitle">Export master</div>
          <div className="spec" style={{ marginTop: 4 }}>{specLine}</div>
        </div>

        {!stats && (
          <>
            <div className="drow">
              <span className="spec" style={{ width: 64 }}>FILE</span>
              <input
                type="text"
                value={fileName}
                disabled={busy}
                onChange={(e) => setFileName(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="drow">
              <span className="spec" style={{ width: 64 }}>TITLE</span>
              <input
                type="text"
                value={title}
                disabled={busy}
                onChange={(e) => setTitle(e.target.value)}
                spellCheck={false}
              />
            </div>
            <MetaFields disabled={busy} />
            <div className="drow">
              <span className="spec" style={{ width: 64 }}>FORMAT</span>
              <div className="seg">
                <button className={format === 'wav' ? 'on' : ''} disabled={busy} onClick={() => setExportFormat('wav')}>WAV</button>
                <button className={format === 'flac' ? 'on' : ''} disabled={busy} onClick={() => setExportFormat('flac')}>FLAC</button>
                <button className={format === 'mp3' ? 'on' : ''} disabled={busy} onClick={() => setExportFormat('mp3')}>MP3</button>
                <button className={format === 'opus' ? 'on' : ''} disabled={busy} onClick={() => setExportFormat('opus')}>OPUS</button>
              </div>
              {format === 'wav' || format === 'flac' ? (
                <>
                  <div className="seg">
                    <button className={bitDepth === 24 ? 'on' : ''} disabled={busy} onClick={() => setExportBitDepth(24)}>24 BIT</button>
                    <button className={bitDepth === 16 ? 'on' : ''} disabled={busy} onClick={() => setExportBitDepth(16)}>16 BIT</button>
                  </div>
                  <span className="spec">{format === 'flac' ? 'LOSSLESS' : 'TPDF DITHER'}</span>
                </>
              ) : format === 'mp3' ? (
                <div className="seg">
                  <button className={mp3Kbps === 320 ? 'on' : ''} disabled={busy} onClick={() => setExportMp3Kbps(320)}>320</button>
                  <button className={mp3Kbps === 256 ? 'on' : ''} disabled={busy} onClick={() => setExportMp3Kbps(256)}>256</button>
                  <button className={mp3Kbps === 192 ? 'on' : ''} disabled={busy} onClick={() => setExportMp3Kbps(192)}>192</button>
                </div>
              ) : (
                <div className="seg">
                  <button className={opusKbps === 256 ? 'on' : ''} disabled={busy} onClick={() => setExportOpusKbps(256)}>256</button>
                  <button className={opusKbps === 192 ? 'on' : ''} disabled={busy} onClick={() => setExportOpusKbps(192)}>192</button>
                  <button className={opusKbps === 128 ? 'on' : ''} disabled={busy} onClick={() => setExportOpusKbps(128)}>128</button>
                </div>
              )}
            </div>
          </>
        )}

        {busy && exporting && (
          <div>
            <div className="drow" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="spec">{exporting.phase}</span>
              <span className="spec-value">{Math.round(exporting.pct * 100)}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${exporting.pct * 100}%` }} />
            </div>
          </div>
        )}

        {stats && (
          <div className="statgrid">
            <StatRow label="INTEGRATED" value={`${stats.integratedLufs.toFixed(2)} LUFS`} />
            <StatRow label="TRUE PEAK" value={`${stats.truePeakDb.toFixed(2)} dBTP`} />
            <StatRow label="LIMITER GR MAX" value={`${stats.limiterMaxGrDb.toFixed(1)} dB`} />
            <StatRow label="GAIN SOLVED" value={`${stats.appliedGainDb >= 0 ? '+' : ''}${stats.appliedGainDb.toFixed(2)} dB`} />
            <StatRow
              label="FORMAT"
              value={
                stats.format === 'mp3'
                  ? `MP3 ${stats.mp3Kbps} kbps · 48 kHz`
                  : `${stats.format.toUpperCase()} · ${(stats.sampleRate / 1000).toFixed(1)} kHz · ${stats.bitDepth} bit`
              }
            />
            <StatRow label="SIZE" value={`${(stats.bytes / (1024 * 1024)).toFixed(1)} MB`} />
            {savedTo && <StatRow label="SAVED" value={savedTo} />}
          </div>
        )}

        {!stats && !busy && (format === 'mp3' || format === 'opus') && (
          <div className="drow">
            <span className="spec" style={{ width: 64 }}>AUDITION</span>
            {!audition.active ? (
              <>
                <button className="btn btn-sm btn-secondary" disabled={audition.busy}
                  onClick={() => void startAudition()}>
                  {audition.busy ? 'RENDERING…' : '▸ HEAR THE CODEC'}
                </button>
                <span className="spec" style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
                  LOUDEST-SECTION A/B
                </span>
              </>
            ) : (
              <>
                <div className="seg">
                  <button className={audition.mode === 'codec' ? 'on' : ''}
                    onClick={() => setAuditionMode('codec')}>
                    {format.toUpperCase()} {format === 'mp3' ? mp3Kbps : opusKbps}
                  </button>
                  <button className={audition.mode === 'master' ? 'on' : ''}
                    onClick={() => setAuditionMode('master')}>MASTER</button>
                </div>
                <button className="btn btn-sm btn-ghost" onClick={stopAudition}>■ STOP</button>
                <span className="lamp signal" />
              </>
            )}
          </div>
        )}

        {!stats && !busy && history.length > 0 && (
          <>
            <div className="boxlabel" style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 10 }}>
              <span className="spec">RECENT MASTERS</span>
              <span className="spec">{history.length} ON FILE</span>
            </div>
            <div className="statgrid" style={{ maxHeight: 120, overflowY: 'auto' }}>
              {history.slice(0, 6).map((h, i) => (
                <div className="row" key={`${h.when}-${i}`} style={{ alignItems: 'center', gap: 8 }}>
                  <span className="spec" style={{ color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 210, letterSpacing: 0 }}>
                    {h.name}
                  </span>
                  <span className="leader" />
                  <span className="spec-value" style={{ fontSize: 10.5 }}>
                    {h.format.toUpperCase()} · {h.lufs.toFixed(1)} LUFS · {(h.bytes / (1024 * 1024)).toFixed(1)} MB
                  </span>
                  {h.path && (window as any).jmaster?.showInFolder && (
                    <button className="btn btn-sm btn-ghost" style={{ height: 20, padding: '0 6px', fontSize: 10 }}
                      title={h.path}
                      onClick={() => (window as any).jmaster.showInFolder(h.path)}>
                      OPEN
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <div className="drow" style={{ justifyContent: 'flex-end', gap: 8 }}>
          {!stats && (
            <>
              <button className="btn btn-secondary" disabled={busy} onClick={() => openExport(false)}>CANCEL</button>
              <button className="btn btn-accent" disabled={busy || !fileName.trim()}
                onClick={() => startExport(fileName.trim(), title.trim())}>
                {busy ? 'RENDERING…' : 'RENDER + SAVE'}
              </button>
            </>
          )}
          {stats && (
            <button className="btn btn-primary" onClick={() => openExport(false)}>DONE</button>
          )}
        </div>
      </div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <span className="spec">{label}</span>
      <span className="leader" />
      <span className="spec-value" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
    </div>
  );
}
