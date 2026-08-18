import { useState } from 'react';
import { useStore } from '../state/store';
import { pickAndLoadFile, loadDroppedFile } from '../lib/filepick';
import { Logo } from './Logo';

export function EmptyState() {
  const loading = useStore((s) => s.loading);
  const [over, setOver] = useState(false);

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
      </div>
    </div>
  );
}
