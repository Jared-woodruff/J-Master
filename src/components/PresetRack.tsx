import { useEffect, useRef, useState } from 'react';
import { useStore, findPreset, consoleMatchesPreset, summarizeMacros } from '../state/store';
import { PRESETS } from '../audio/dsp/params';

interface RowPreset {
  id: string;
  name: string;
  spec: string;
  targetLufs: number;
  user?: boolean;
}

export function PresetRack() {
  const presetId = useStore((s) => s.presetId);
  const lastPresetId = useStore((s) => s.lastPresetId);
  const userPresets = useStore((s) => s.userPresets);
  const macros = useStore((s) => s.macros);
  const targetLufs = useStore((s) => s.targetLufs);
  const ceilingDb = useStore((s) => s.ceilingDb);
  const applyPreset = useStore((s) => s.applyPreset);
  const saveUserPreset = useStore((s) => s.saveUserPreset);
  const deleteUserPreset = useStore((s) => s.deleteUserPreset);
  const revertPreset = useStore((s) => s.revertPreset);
  const [filter, setFilter] = useState('');
  const [naming, setNaming] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const confirmTimer = useRef(0);

  // The preset the console came from, and whether it has drifted since.
  const base = findPreset({ userPresets }, presetId ?? lastPresetId);
  const modified = !!base && !consoleMatchesPreset({ macros, targetLufs, ceilingDb }, base);

  const q = filter.trim().toLowerCase();
  const match = (p: { name: string; spec: string; genre?: string }) =>
    !q || p.name.toLowerCase().includes(q) || p.spec.toLowerCase().includes(q) || (p.genre ?? '').toLowerCase().includes(q);
  const mine: RowPreset[] = userPresets
    .map((u) => ({ id: u.id, name: u.name, spec: summarizeMacros(u.macros), targetLufs: u.targetLufs, genre: u.genre, user: true }))
    .filter(match);
  const genres: RowPreset[] = PRESETS.filter(match);

  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

  const startNaming = () => {
    // Tweaked one of yours: default to its name, so saving updates it.
    const name = base?.user ? base.name : base && base.id !== 'flat' ? `MY ${base.name}` : 'MY PRESET';
    setNaming(name);
  };
  const commitNaming = () => {
    if (naming && naming.trim()) saveUserPreset(naming);
    setNaming(null);
  };
  const askDelete = (id: string) => {
    if (confirmDel === id) {
      window.clearTimeout(confirmTimer.current);
      setConfirmDel(null);
      deleteUserPreset(id);
      return;
    }
    setConfirmDel(id);
    window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => setConfirmDel(null), 3000);
  };

  const row = (p: RowPreset) => {
    const on = base?.id === p.id;
    const isModified = on && modified;
    return (
      <div key={p.id} className={`presetrow ${isModified ? 'modified' : ''}`}>
        <button
          className={`preset ${on ? 'on' : ''}`}
          onClick={() => applyPreset(p.id)}
          title={`${p.name} · ${isModified ? 'modified, click to go back to it' : p.spec} · ${p.targetLufs} LUFS`}
        >
          <span className="prow">
            <span className="pname">{p.name}</span>
            <span className="plufs">{p.targetLufs}</span>
          </span>
          <span className={`spec pspec ${isModified ? 'mod' : ''}`}>{isModified ? 'MODIFIED' : p.spec}</span>
        </button>
        {isModified ? (
          <button className="prowact" onClick={revertPreset} title={`Back to ${p.name} as saved`}>REVERT</button>
        ) : p.user ? (
          <button
            className={`prowact del ${confirmDel === p.id ? 'confirm' : ''}`}
            onClick={() => askDelete(p.id)}
            aria-label={`Delete preset ${p.name}`}
            title={confirmDel === p.id ? 'Click again to delete' : 'Delete this preset'}
          >{confirmDel === p.id ? 'DELETE?' : '×'}</button>
        ) : null}
      </div>
    );
  };

  return (
    <div className="panel panel-presets">
      <div className="panel-head">
        <span className="title">Presets</span>
        <span className="spec" title={userPresets.length > 0 ? `${userPresets.length} of yours · ${PRESETS.length} genres` : undefined}>
          {userPresets.length > 0 ? `${userPresets.length} + ${PRESETS.length}` : `${PRESETS.length} GENRES`}
        </span>
      </div>
      {/* Distinct keys: reusing the filter row's nodes left focus on a
          recycled button instead of the fresh name field. */}
      {naming === null ? (
        <div className="preset-filter" key="filter">
          <input
            type="text"
            value={filter}
            placeholder="FILTER…"
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter presets"
          />
          {filter && (
            <button onClick={() => setFilter('')} title="Clear filter" aria-label="Clear filter">×</button>
          )}
          <button className="psave" onClick={startNaming}
            title="Save this console as your own preset">+ SAVE</button>
        </div>
      ) : (
        <div className="preset-filter naming" key="naming">
          <input
            type="text"
            autoFocus
            value={naming}
            maxLength={28}
            placeholder="NAME THIS PRESET"
            spellCheck={false}
            aria-label="Preset name"
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitNaming();
              else if (e.key === 'Escape') setNaming(null);
            }}
          />
          <button className="psave" onClick={commitNaming} disabled={!naming.trim()} title="Save · Enter">SAVE</button>
          <button onClick={() => setNaming(null)} title="Cancel · Esc" aria-label="Cancel">×</button>
        </div>
      )}
      <div className="presetlist">
        {mine.length === 0 && genres.length === 0 && (
          <div className="spec" style={{ padding: '12px 10px' }}>NO MATCH.</div>
        )}
        {mine.length > 0 && <div className="spec presetgroup">YOURS</div>}
        {mine.map(row)}
        {mine.length > 0 && genres.length > 0 && <div className="spec presetgroup">GENRES</div>}
        {genres.map(row)}
      </div>
    </div>
  );
}
