// Shared release-metadata inputs (artist / album / year / genre / cat. no),
// written into WAV INFO, FLAC Vorbis comments and MP3 ID3v2.3 on export.
import { useStore } from '../state/store';

export function MetaFields({ disabled }: { disabled: boolean }) {
  const meta = useStore((s) => s.meta);
  const setMeta = useStore((s) => s.setMeta);

  return (
    <>
      <div className="drow">
        <span className="spec" style={{ width: 64 }}>ARTIST</span>
        <input type="text" value={meta.artist} disabled={disabled} spellCheck={false}
          placeholder="artist" onChange={(e) => setMeta('artist', e.target.value)} />
        <span className="spec" style={{ width: 52, textAlign: 'right' }}>ALBUM</span>
        <input type="text" value={meta.album} disabled={disabled} spellCheck={false}
          placeholder="album / EP" onChange={(e) => setMeta('album', e.target.value)} />
      </div>
      <div className="drow">
        <span className="spec" style={{ width: 64 }}>YEAR</span>
        <input type="text" value={meta.year} disabled={disabled} spellCheck={false}
          style={{ maxWidth: 72, flex: 'none' }} onChange={(e) => setMeta('year', e.target.value)} />
        <span className="spec" style={{ width: 46, textAlign: 'right' }}>GENRE</span>
        <input type="text" value={meta.genre} disabled={disabled} spellCheck={false}
          placeholder="genre" onChange={(e) => setMeta('genre', e.target.value)} />
        <span className="spec" style={{ width: 52, textAlign: 'right' }}>CAT. NO</span>
        <input type="text" value={meta.catalog} disabled={disabled} spellCheck={false}
          placeholder="JW-001" style={{ maxWidth: 110, flex: 'none' }}
          onChange={(e) => setMeta('catalog', e.target.value)} />
      </div>
    </>
  );
}
