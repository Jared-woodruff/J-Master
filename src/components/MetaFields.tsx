// Shared release-metadata inputs (artist / album / year / genre / cat. no),
// written into WAV INFO, FLAC Vorbis comments and MP3 ID3v2.3 on export —
// plus front-cover art, embedded per format.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';

export function MetaFields({ disabled }: { disabled: boolean }) {
  const meta = useStore((s) => s.meta);
  const setMeta = useStore((s) => s.setMeta);
  const coverArt = useStore((s) => s.coverArt);
  const setCoverFromFile = useStore((s) => s.setCoverFromFile);
  const clearCover = useStore((s) => s.clearCover);
  const fileRef = useRef<HTMLInputElement>(null);

  // Effect-owned object URL: each cover gets a fresh URL whose revoke is
  // paired with its own effect cleanup (StrictMode-safe).
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!coverArt) { setCoverUrl(null); return; }
    const url = URL.createObjectURL(new Blob([coverArt.data.slice()], { type: coverArt.mime }));
    setCoverUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [coverArt]);

  return (
    <>
      <div className="formrow">
        <span className="spec flabel">ARTIST</span>
        <input type="text" value={meta.artist} disabled={disabled} spellCheck={false}
          placeholder="artist" onChange={(e) => setMeta('artist', e.target.value)} />
        <span className="spec flabel r">ALBUM</span>
        <input type="text" value={meta.album} disabled={disabled} spellCheck={false}
          placeholder="album / EP" onChange={(e) => setMeta('album', e.target.value)} />
      </div>
      <div className="formrow">
        <span className="spec flabel">YEAR</span>
        <input type="text" value={meta.year} disabled={disabled} spellCheck={false}
          style={{ width: 72, flex: 'none' }} onChange={(e) => setMeta('year', e.target.value)} />
        <span className="spec flabel r">GENRE</span>
        <input type="text" value={meta.genre} disabled={disabled} spellCheck={false}
          placeholder="genre" style={{ minWidth: 90 }} onChange={(e) => setMeta('genre', e.target.value)} />
        <span className="spec flabel r">CAT. NO</span>
        <input type="text" value={meta.catalog} disabled={disabled} spellCheck={false}
          placeholder="JW-001" style={{ width: 96, flex: 'none' }}
          onChange={(e) => setMeta('catalog', e.target.value)} />
      </div>
      <div className="formrow">
        <span className="spec flabel">COVER</span>
        <button
          className={`cover-tile ${coverArt ? 'has' : ''}`}
          disabled={disabled}
          title={coverArt
            ? `${coverArt.name} · click to replace`
            : 'Add front-cover art (embedded in the exported file’s tags)'}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const f = e.dataTransfer.files?.[0];
            if (f && !disabled) void setCoverFromFile(f);
          }}
        >
          {coverUrl ? <img src={coverUrl} alt="Cover art" /> : <span className="spec">+ ART</span>}
        </button>
        <div className="cover-info">
          <span className="line1">
            {coverArt
              ? `${coverArt.width} × ${coverArt.height} JPEG · ${Math.max(1, Math.round(coverArt.data.length / 1024))} KB`
              : 'ADD FRONT-COVER ART'}
          </span>
          <span className="spec line2">
            {coverArt
              ? 'EMBEDDED IN EVERY EXPORT FORMAT'
              : 'CLICK OR DROP AN IMAGE · SCALED TO 1000 PX JPEG'}
          </span>
        </div>
        {coverArt && (
          <button className="btn btn-sm btn-ghost" disabled={disabled} onClick={clearCover}>CLEAR</button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void setCoverFromFile(f);
            e.target.value = '';
          }}
        />
      </div>
    </>
  );
}
