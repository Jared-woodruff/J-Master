import { useState } from 'react';
import { useStore } from '../state/store';
import { pickAndLoadFile, loadDroppedFile } from '../lib/filepick';
import { Logo } from './Logo';

export function EmptyState() {
  const loading = useStore((s) => s.loading);
  const recent = useStore((s) => s.recentFiles);
  const [over, setOver] = useState(false);

  const bridge = (window as any).jmaster;
  const canRecent = !!bridge?.readFileByPath && recent.length > 0;

  const openRecent = async (r: { name: string; path: string }) => {
    try {
      const bytes: ArrayBuffer = await bridge.readFileByPath(r.path);
      await useStore.getState().loadFile(bytes, r.name, r.path);
    } catch {
      useStore.getState().pushToast(`NOT FOUND · ${r.name.toUpperCase()}`, 'fault');
      useStore.getState().pruneRecentFile(r.path);
    }
  };

  return (
    <div className="empty">
      <div
        className={`dropzone frame ${over ? 'dragover' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void loadDroppedFile(f);
        }}
      >
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>

        <Logo size={56} />
        <div className="display headline">
          Master the track<span className="accentdot">.</span>
        </div>
        <div className="spec">
          DROP A WAV · 24 BIT / 48 KHZ OUT · LOUDNESS SOLVED FOR STREAMING
        </div>
        <button className="btn btn-accent btn-lg" disabled={loading} onClick={() => void pickAndLoadFile()}>
          {loading ? 'ANALYSING…' : 'OPEN FILE'}
        </button>
        <div className="spec" style={{ opacity: 0.7 }}>
          ANY GENERATOR, ANY DAW, ANY WAV · EVERYTHING PROCESSED ON THIS MACHINE
        </div>
        {canRecent && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, marginTop: 8 }}>
            <span className="spec" style={{ opacity: 0.55 }}>RECENT</span>
            {recent.map((r) => (
              <button
                key={r.path}
                className="btn btn-sm"
                disabled={loading}
                style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={r.path}
                onClick={() => void openRecent(r)}
              >{r.name}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
