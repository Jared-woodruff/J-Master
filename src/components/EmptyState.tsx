import { useStore } from '../state/store';
import { pickAndLoadFile } from '../lib/filepick';
import { Logo } from './Logo';

// Drops are routed by FileDrop; this screen only reflects the drag state.
export function EmptyState() {
  const loading = useStore((s) => s.loading);
  const loadingName = useStore((s) => s.loadingName);
  const loadPhase = useStore((s) => s.loadPhase);
  const drag = useStore((s) => s.fileDrag);
  const recent = useStore((s) => s.recentFiles);

  const bridge = (window as any).jmaster;
  const canRecent = !!bridge?.readFileByPath && recent.length > 0;
  const over = drag !== null && !loading;
  const imagesOnly = !!drag && drag.images > 0 && drag.images === drag.count;
  const many = !!drag && drag.count - drag.images > 1;

  // A missing file is reported and pruned by the store's loader.
  const openRecent = (r: { name: string; path: string }) =>
    useStore.getState().loadFile(bridge.readFileByPath(r.path), r.name, r.path);

  return (
    <div className="empty">
      <div className={`dropzone frame ${over ? (imagesOnly ? 'dragover reject' : 'dragover') : ''}`}>
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>

        <Logo size={56} />
        {loading ? (
          <>
            <div className="display headline">Reading the track<span className="accentdot">.</span></div>
            <div className="spec" title={loadingName ?? undefined}
              style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {(loadingName ?? '').toUpperCase()}
            </div>
            <div className="loadbar" role="progressbar" aria-label="Loading"><span /></div>
            <div className="spec" style={{ color: 'var(--text-accent)' }}>{loadPhase ?? 'LOADING'}</div>
          </>
        ) : over ? (
          <>
            <div className="display headline">
              {imagesOnly ? 'That’s an image' : many ? `Drop ${drag!.count - drag!.images} tracks` : 'Drop to master'}
              <span className="accentdot">.</span>
            </div>
            <div className="spec">
              {imagesOnly
                ? 'LOAD A TRACK FIRST · COVER ART GOES ON THE COVER TILE IN EXPORT'
                : many
                  ? 'THE FIRST OPENS IN THE CONSOLE · ALL OF THEM QUEUE IN BATCH'
                  : 'WAV · FLAC · MP3 · OGG · M4A · .JMASTER PROJECTS'}
            </div>
          </>
        ) : (
          <>
            <div className="display headline">
              Master the track<span className="accentdot">.</span>
            </div>
            <div className="spec">
              DROP A WAV · 24 BIT / 48 KHZ OUT · LOUDNESS SOLVED FOR STREAMING
            </div>
            <button className="btn btn-accent btn-lg" onClick={() => void pickAndLoadFile()}
              title="Open audio or a .jmaster project · Ctrl+O">
              OPEN FILE
            </button>
            <div className="spec" style={{ opacity: 0.7 }}>
              ANY GENERATOR, ANY DAW, ANY WAV · EVERYTHING PROCESSED ON THIS MACHINE
            </div>
            {canRecent && (
              <div className="recent">
                <span className="spec" style={{ opacity: 0.55 }}>RECENT</span>
                {recent.map((r) => (
                  <button
                    key={r.path}
                    className="btn btn-sm"
                    style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={r.path}
                    onClick={() => void openRecent(r)}
                  >{r.name}</button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
