import { useEffect, useRef, useState } from 'react';
import { useStore, findPreset, consoleMatchesPreset, summarizeMacros } from '../state/store';
import { PRESETS } from '../audio/dsp/params';

interface RowPreset {
  id: string;
  name: string;
  spec: string;
  targetLufs: number;
  genre?: string;
  user?: boolean;
  pinned?: boolean;
}

export function PresetRack() {
  const presetId = useStore((s) => s.presetId);
  const lastPresetId = useStore((s) => s.lastPresetId);
  const presetAmount = useStore((s) => s.presetAmount);
  const userPresets = useStore((s) => s.userPresets);
  const favourites = useStore((s) => s.favourites);
  const macros = useStore((s) => s.macros);
  const targetLufs = useStore((s) => s.targetLufs);
  const ceilingDb = useStore((s) => s.ceilingDb);
  const applyPreset = useStore((s) => s.applyPreset);
  const setPresetAmount = useStore((s) => s.setPresetAmount);
  const saveUserPreset = useStore((s) => s.saveUserPreset);
  const deleteUserPreset = useStore((s) => s.deleteUserPreset);
  const toggleFavourite = useStore((s) => s.toggleFavourite);
  const revertPreset = useStore((s) => s.revertPreset);
  const [filter, setFilter] = useState('');
  const [naming, setNaming] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const confirmTimer = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  // The preset the console came from, and whether it has drifted since.
  const base = findPreset({ userPresets }, presetId ?? lastPresetId);
  const modified = !!base && !consoleMatchesPreset({ macros, targetLufs, ceilingDb, presetAmount }, base);

  const q = filter.trim().toLowerCase();
  const match = (p: { name: string; spec: string; genre?: string }) =>
    !q || p.name.toLowerCase().includes(q) || p.spec.toLowerCase().includes(q) || (p.genre ?? '').toLowerCase().includes(q);
  const all: RowPreset[] = [
    ...userPresets.map((u) => ({
      id: u.id, name: u.name, spec: summarizeMacros(u.macros), targetLufs: u.targetLufs, genre: u.genre,
      user: true, pinned: !!u.favourite,
    })),
    ...PRESETS.map((p) => ({ ...p, pinned: favourites.includes(p.id) })),
  ].filter(match);
  // A pinned preset shows once, at the top.
  const pinned = all.filter((p) => p.pinned);
  const mine = all.filter((p) => p.user && !p.pinned);
  const genres = all.filter((p) => !p.user && !p.pinned);

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

  // Up and down walk the rack: each preset is heard as it is reached.
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button.preset') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next = rows[at + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.click();
  };

  const row = (p: RowPreset) => {
    const on = base?.id === p.id;
    const isModified = on && modified;
    return (
      <div key={p.id} className={`presetrow ${isModified ? 'modified' : ''}`}>
        <button
          className={`preset ${on ? 'on' : ''}`} aria-pressed={on}
          onClick={() => applyPreset(p.id)}
          title={`${p.name} · ${isModified ? 'modified, click to go back to it' : p.spec} · ${p.targetLufs} LUFS`}
        >
          <span className="prow">
            <span className="pname">{p.name}</span>
            <span className="plufs">{p.targetLufs}</span>
          </span>
          <span className={`spec pspec ${isModified ? 'mod' : ''}`}>{isModified ? 'MODIFIED' : p.spec}</span>
        </button>
        {/* Each kind of row action keeps its own key: a button that turned
            from REVERT into DELETE under the pointer took the second click. */}
        {isModified ? (
          <button key="revert" className="prowact" onClick={revertPreset} title={`Back to ${p.name} as saved`}>REVERT</button>
        ) : p.user ? (
          <button
            key="delete"
            className={`prowact del ${confirmDel === p.id ? 'confirm' : ''}`}
            onClick={() => askDelete(p.id)}
            aria-label={`Delete preset ${p.name}`}
            title={confirmDel === p.id ? 'Click again to delete' : 'Delete this preset'}
          >{confirmDel === p.id ? 'DELETE?' : '×'}</button>
        ) : null}
        <button
          key="pin"
          className={`prowact pin ${p.pinned ? 'on' : ''}`}
          aria-pressed={!!p.pinned}
          aria-label={`${p.pinned ? 'Unpin' : 'Pin'} ${p.name}`}
          title={p.pinned ? 'Pinned to the top · click to let it go' : 'Pin to the top of the rack'}
          onClick={() => toggleFavourite(p.id)}
        ><span className="pinmark" /></button>
      </div>
    );
  };

  const amountPct = Math.round(presetAmount * 100);

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
              else if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); }
            }}
          />
          <button className="psave" onClick={commitNaming} disabled={!naming.trim()} title="Save · Enter">SAVE</button>
          <button onClick={() => setNaming(null)} title="Cancel · Esc" aria-label="Cancel">×</button>
        </div>
      )}
      <div className="preset-amount" title="How much of the preset is dialled in: every knob moves between neutral and where the preset puts it (and a little past) · the loudness target stays · double-click for 100%">
        <span className="spec">AMOUNT</span>
        <input
          type="range" min={0} max={150} step={5}
          value={amountPct}
          disabled={!base}
          aria-label="Preset amount"
          aria-valuetext={`${amountPct}%`}
          style={{ ['--fill' as string]: `${(amountPct / 150) * 100}%` }}
          onChange={(e) => setPresetAmount(Number(e.target.value) / 100)}
          onDoubleClick={() => setPresetAmount(1)}
        />
        <span className={`spec-value ${amountPct !== 100 ? 'off' : ''}`}>{amountPct}%</span>
      </div>
      <div className="presetlist" ref={listRef} onKeyDown={onListKey}>
        {all.length === 0 && (
          <div className="spec" style={{ padding: '12px 10px' }}>NO MATCH.</div>
        )}
        {pinned.length > 0 && <div className="spec presetgroup">PINNED</div>}
        {pinned.map(row)}
        {mine.length > 0 && <div className="spec presetgroup">YOURS</div>}
        {mine.map(row)}
        {genres.length > 0 && (pinned.length > 0 || mine.length > 0) && <div className="spec presetgroup">GENRES</div>}
        {genres.map(row)}
      </div>
    </div>
  );
}
