import { useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { PRESETS } from '../audio/dsp/params';

export function PresetRack() {
  const presetId = useStore((s) => s.presetId);
  const applyPreset = useStore((s) => s.applyPreset);
  const [filter, setFilter] = useState('');

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return PRESETS;
    return PRESETS.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.spec.toLowerCase().includes(q) ||
        (p.genre ?? '').toLowerCase().includes(q),
    );
  }, [filter]);

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="title">Presets</span>
        <span className="spec">{PRESETS.length} GENRES</span>
      </div>
      <div className="preset-filter">
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
      </div>
      <div className="presetlist">
        {visible.length === 0 && (
          <div className="spec" style={{ padding: '12px 10px' }}>NO MATCH.</div>
        )}
        {visible.map((p) => (
          <button
            key={p.id}
            className={`preset ${presetId === p.id ? 'on' : ''}`}
            onClick={() => applyPreset(p.id)}
            title={`${p.name} · ${p.spec} · ${p.targetLufs} LUFS`}
          >
            <span className="prow">
              <span className="pname">{p.name}</span>
              <span className="plufs">{p.targetLufs}</span>
            </span>
            <span className="spec pspec">{p.spec}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
