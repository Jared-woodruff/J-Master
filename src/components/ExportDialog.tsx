import { useEffect, useState } from 'react';
import { useStore, masterFileName, encodeOptionsFrom, withFormatExt } from '../state/store';
import { effectiveBitDepth, effectiveRate, type ExportFormat } from '../audio/encode';
import type { ExportStats } from '../audio/engine';
import { MetaFields } from './MetaFields';
import { FormatPicker } from './FormatPicker';
import { dbtpText, lufsText } from '../lib/level-text';
import { useSheetFocus } from '../lib/use-sheet-focus';

const ALL_FORMATS: ExportFormat[] = ['wav', 'flac', 'mp3', 'opus'];

const megabytes = (bytes: number) =>
  (Number.isFinite(bytes) && bytes > 0 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : '');

/** What was written, as a spec line: "FLAC · 44.1 kHz · 16 bit · SHAPED DITHER". */
function formatLine(s: ExportStats): string {
  const rate = `${+(s.sampleRate / 1000).toFixed(1)} kHz`;
  if (s.format === 'mp3') return `MP3 ${s.mp3Kbps ?? 320} kbps · ${rate}`;
  if (s.format === 'opus') return `OGG OPUS ${s.opusKbps ?? 192} kbps · ${rate}`;
  const depth = s.bitDepth === 32 ? '32-bit float' : `${s.bitDepth} bit`;
  return `${s.format.toUpperCase()} · ${rate} · ${depth}${s.bitDepth === 16 ? ` · ${s.dither === 'shaped' ? 'SHAPED' : 'TPDF'} DITHER` : ''}`;
}

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
  const saveReport = useStore((s) => s.saveReport);
  const hasReport = useStore((s) => s.lastExport !== null);
  const format = useStore((s) => s.exportFormat);
  const bitDepth = useStore((s) => s.exportBitDepth);
  const rate = useStore((s) => s.exportRate);
  const dither = useStore((s) => s.exportDither);
  const mp3Kbps = useStore((s) => s.exportMp3Kbps);
  const opusKbps = useStore((s) => s.exportOpusKbps);
  const history = useStore((s) => s.exportHistory);
  const audition = useStore((s) => s.audition);
  const startAudition = useStore((s) => s.startAudition);
  const setAuditionMode = useStore((s) => s.setAuditionMode);
  const stopAudition = useStore((s) => s.stopAudition);
  const estimate = useStore((s) => s.masterEstimate);
  const solving = useStore((s) => s.previewPending);
  const repairing = useStore((s) => s.repairing !== null);
  const kept = useStore((s) => (s.trimStartSec > 0 || s.trimEndSec > 0) && s.source
    ? (s.trimEndSec > 0 ? s.trimEndSec : s.source.durationSec) - s.trimStartSec : 0);

  const exportExtras = useStore((s) => s.exportExtras);
  const extrasSaved = useStore((s) => s.exportExtrasSaved);
  const toggleExportExtra = useStore((s) => s.toggleExportExtra);

  const [fileName, setFileName] = useState('');
  // A name the user typed survives format changes (only its extension follows).
  const [nameTyped, setNameTyped] = useState(false);
  const [title, setTitle] = useState('');

  const extras = exportExtras.filter((f) => f !== format);
  const options = encodeOptionsFrom(useStore.getState());
  const depthNow = effectiveBitDepth(options);
  const rateNow = effectiveRate(options);
  const fmtLabel = (f: ExportFormat) => {
    const o = { ...options, format: f };
    return f === 'mp3' ? `MP3 ${mp3Kbps}` : f === 'opus' ? `OPUS ${opusKbps}`
      : `${f.toUpperCase()} ${effectiveBitDepth(o) === 32 ? '32F' : effectiveBitDepth(o)}`;
  };

  // A new track, or the sheet opening again: the name starts over. (Both in
  // one step: clearing "typed" on its own left the last track's name in the
  // field, because the rename below still saw the old flag.)
  useEffect(() => {
    if (!open || !source) return;
    setNameTyped(false);
    setFileName(masterFileName(source.name, encodeOptionsFrom(useStore.getState())));
    setTitle(source.name.replace(/\.[^.]+$/, ''));
  }, [open, source]);

  useEffect(() => {
    if (!open || !source) return;
    setFileName((n) => (nameTyped
      ? (n.trim() ? withFormatExt(n, format) : n)
      : masterFileName(source.name, encodeOptionsFrom(useStore.getState()))));
    // `nameTyped` is read, not watched: typing must not rename.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, bitDepth, rate, mp3Kbps, opusKbps]);

  const sheetRef = useSheetFocus<HTMLDivElement>(open);

  if (!open || !source) return null;

  const busy = exporting !== null;
  const rateText = `${+(rateNow / 1000).toFixed(1)} KHZ`;
  const specLine = `${rateText} · ${
    format === 'mp3' ? `MP3 ${mp3Kbps} KBPS CBR`
      : format === 'opus' ? `OGG OPUS ${opusKbps} KBPS`
      : `${depthNow === 32 ? '32-BIT FLOAT' : `${depthNow} BIT`} ${format.toUpperCase()}`
  } · ${targetLufs.toFixed(1)} LUFS · ${ceilingDb.toFixed(1)} dBTP`;
  const bridge = (window as any).jmaster;

  const close = () => {
    if (busy) return;
    if (audition.active) stopAudition();
    openExport(false);
  };

  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog frame" role="dialog" aria-modal="true" tabIndex={-1} ref={sheetRef} aria-label="Export master" style={{ width: 580 }}>
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>

        <div>
          <div className="display dtitle">Export master</div>
          <div className="spec" style={{ marginTop: 4 }}>{specLine}</div>
        </div>

        {!stats && (
          <>
            <div className="formrow">
              <span className="spec flabel">FILE</span>
              <input
                type="text"
                value={fileName}
                disabled={busy}
                aria-label="File name"
                onChange={(e) => { setFileName(e.target.value); setNameTyped(true); }}
                spellCheck={false}
              />
            </div>
            <div className="formrow">
              <span className="spec flabel">TITLE</span>
              <input
                type="text"
                value={title}
                disabled={busy}
                aria-label="Title tag"
                onChange={(e) => setTitle(e.target.value)}
                spellCheck={false}
              />
            </div>

            <div className="boxlabel" style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 10 }}>
              <span className="spec" style={{ color: 'var(--text-body)' }}>RELEASE</span>
              <span className="spec">WRITTEN TO FILE TAGS</span>
            </div>
            <MetaFields disabled={busy} />

            <div className="boxlabel" style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 10 }}>
              <span className="spec" style={{ color: 'var(--text-body)' }}>FORMAT</span>
              <span className="spec">
                {format === 'wav' ? (depthNow === 32 ? 'IEEE FLOAT · NO DITHER' : depthNow === 16 ? `PCM · ${dither === 'shaped' ? 'NOISE-SHAPED' : 'TPDF'} DITHER` : 'PCM')
                  : format === 'flac' ? `LOSSLESS · RFC 9639 · MD5 SIGNED`
                  : format === 'mp3' ? 'CBR · ID3V2.3'
                  : 'OGG OPUS · RFC 7845'}
              </span>
            </div>
            <div className="formrow fmtrow">
              <FormatPicker disabled={busy} />
            </div>
            <div className="formrow">
              <span className="spec flabel">ALSO SAVE</span>
              <div className="chips" role="group" aria-label="Also save these formats">
                {ALL_FORMATS.filter((f) => f !== format).map((f) => {
                  const on = extras.includes(f);
                  return (
                    <button key={f} className={`chip ${on ? 'on' : ''}`} disabled={busy} aria-pressed={on}
                      title={`Also save ${fmtLabel(f)} beside the master · rendered once, same loudness`}
                      onClick={() => toggleExportExtra(f)}>
                      {on ? '✓' : '+'} {fmtLabel(f)}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* What the render will measure, known before it starts. */}
            {!busy && (
              <div className={`landing ${estimate && !solving && (!estimate.reached || !estimate.measured) ? 'warn' : ''}`} role="status">
                <span className="spec">WILL LAND AT</span>
                <span className="leader" />
                <span className="spec-value">
                  {repairing ? 'WAITING FOR THE DRIFT REPAIR'
                    : !estimate || solving ? 'SOLVING…'
                    : !estimate.measured ? 'TOO QUIET TO MEASURE · UNITY GAIN'
                    : !estimate.reached
                      ? `${estimate.lufs.toFixed(1)} LUFS · ${(targetLufs - estimate.lufs).toFixed(1)} LU SHORT OF TARGET UNDER ${ceilingDb.toFixed(1)} dBTP`
                      : `${estimate.lufs.toFixed(1)} LUFS · ${estimate.truePeakDb.toFixed(1)} dBTP · LIMITER ${estimate.limiterMaxGrDb.toFixed(1)} dB`}
                  {kept > 0 ? ` · ${Math.floor(kept / 60)}:${String(Math.floor(kept % 60)).padStart(2, '0')} KEPT` : ''}
                </span>
              </div>
            )}
          </>
        )}

        {busy && exporting && (
          <div>
            <div className="drow" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="spec">{exporting.phase}</span>
              <span className="spec-value">{Math.round(exporting.pct * 100)}%</span>
            </div>
            <div className="progress-track" role="progressbar" aria-label="Render progress"
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(exporting.pct * 100)}>
              <div className="progress-fill" style={{ width: `${exporting.pct * 100}%` }} />
            </div>
          </div>
        )}

        {stats && (
          <div className="statgrid">
            <StatRow label="INTEGRATED" value={lufsText(stats.integratedLufs, 2)}
              warn={stats.targetReached === false || stats.loudnessMeasured === false}
              note={stats.loudnessMeasured === false ? 'TOO QUIET TO MEASURE · UNITY GAIN'
                : stats.targetReached === false ? `SHORT OF ${(stats.targetLufs ?? targetLufs).toFixed(1)} UNDER THIS CEILING` : undefined} />
            <StatRow label="TRUE PEAK" value={dbtpText(stats.truePeakDb, 2)} />
            {stats.codecPeakDb !== undefined && (
              <StatRow label={`${stats.format.toUpperCase()} DECODED PEAK`} value={dbtpText(stats.codecPeakDb, 2)}
                warn={stats.codecPeakDb > (stats.ceilingDb ?? ceilingDb) + 0.2}
                note={stats.codecPeakDb > (stats.ceilingDb ?? ceilingDb) + 0.2 ? 'THE CODEC OVERSHOOTS · LOWER THE CEILING' : 'THE CODEC STAYS UNDER'} />
            )}
            {stats.lra !== undefined && (
              <StatRow label="RANGE · PEAK TO LOUDNESS"
                value={`LRA ${stats.lra.toFixed(1)} LU · PLR ${(stats.plr ?? stats.truePeakDb - stats.integratedLufs).toFixed(1)} dB`} />
            )}
            <StatRow label="LIMITER GR MAX"
              value={`${stats.limiterMaxGrDb.toFixed(1)} dB${(stats.clipMaxGrDb ?? 0) > 0.05 ? ` · CLIP ${(stats.clipMaxGrDb ?? 0).toFixed(1)} dB` : ''}`} />
            <StatRow label="GAIN SOLVED" value={`${stats.appliedGainDb >= 0 ? '+' : ''}${stats.appliedGainDb.toFixed(2)} dB`} />
            <StatRow label="FORMAT" value={formatLine(stats)} />
            <StatRow label="SIZE" value={megabytes(stats.bytes)} />
            {savedTo && <StatRow label="SAVED" value={savedTo} path />}
            {extrasSaved.map((p, i) => (
              <StatRow key={p} label={i === 0 ? 'ALSO SAVED' : ''} value={p.split(/[\\/]/).pop() ?? p} />
            ))}
          </div>
        )}

        {!stats && !busy && (format === 'mp3' || format === 'opus') && (
          <div className="formrow">
            <span className="spec flabel">AUDITION</span>
            {!audition.active ? (
              <>
                <button className="btn btn-sm btn-secondary" disabled={audition.busy}
                  title="Hear what the codec does to the loudest part of the track, switching against the lossless master"
                  onClick={() => void startAudition()}>
                  {audition.busy ? 'RENDERING…' : '▸ HEAR THE CODEC'}
                </button>
                <span className="leader" />
                <span className="spec" style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
                  LOUDEST-SECTION A/B
                </span>
              </>
            ) : (
              <>
                <div className="seg">
                  <button className={audition.mode === 'codec' ? 'on' : ''} aria-pressed={audition.mode === 'codec'}
                    onClick={() => setAuditionMode('codec')}>
                    {format.toUpperCase()} {format === 'mp3' ? mp3Kbps : opusKbps}
                  </button>
                  <button className={audition.mode === 'master' ? 'on' : ''} aria-pressed={audition.mode === 'master'}
                    onClick={() => setAuditionMode('master')}>MASTER</button>
                </div>
                <button className="btn btn-sm btn-ghost" onClick={stopAudition}>■ STOP</button>
                <span className="leader" />
                <span className="lamp signal" aria-label="Audition playing" role="img" />
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
                  <span className="spec" title={h.name}
                    style={{ color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240, letterSpacing: 0 }}>
                    {h.name}
                  </span>
                  <span className="leader" />
                  <span className="spec-value" style={{ fontSize: 10.5 }}>
                    {[h.format.toUpperCase(), lufsText(h.lufs), megabytes(h.bytes)].filter(Boolean).join(' · ')}
                  </span>
                  {h.path && bridge?.showInFolder && (
                    <button className="btn btn-sm btn-ghost" style={{ height: 20, padding: '0 6px', fontSize: 10 }}
                      title={h.path}
                      onClick={() => bridge.showInFolder(h.path)}>
                      SHOW
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
              <button className="btn btn-secondary" disabled={busy} onClick={close}>CANCEL</button>
              <button className="btn btn-accent" disabled={busy || repairing || !fileName.trim()}
                onClick={() => startExport(fileName.trim(), title.trim())}>
                {busy ? 'RENDERING…' : extras.length > 0 ? `RENDER + SAVE ${extras.length + 1} FILES` : 'RENDER + SAVE'}
              </button>
            </>
          )}
          {stats && (
            <>
              {savedTo && bridge?.showInFolder && /[\\/]/.test(savedTo) && (
                <button className="btn btn-secondary" onClick={() => bridge.showInFolder(savedTo)}
                  title="Open the folder with the master selected">SHOW IN FOLDER</button>
              )}
              {hasReport && (
                <button className="btn btn-secondary" onClick={() => void saveReport()}
                  title="Save a one-page spec sheet beside the master and open it: what was measured, what the console did, how each platform will play it">
                  REPORT →
                </button>
              )}
              <button className="btn btn-primary" onClick={close}>DONE</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatRow({ label, value, path = false, warn = false, note }: {
  label: string; value: string; path?: boolean; warn?: boolean; note?: string;
}) {
  return (
    <div className="row">
      <span className="spec">{label}</span>
      <span className="leader" />
      {path ? (
        // A long path keeps its end, the file name, in view.
        <span className="spec-value path-tail" title={value} style={{ maxWidth: 320 }}><bdi>{value}</bdi></span>
      ) : (
        <span className="spec-value" title={note ? `${value} · ${note}` : value}
          style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', color: warn ? 'var(--text-warn)' : undefined }}>
          {value}{note ? ` · ${note}` : ''}
        </span>
      )}
    </div>
  );
}
