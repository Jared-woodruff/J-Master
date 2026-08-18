// TRACK DIAGNOSIS — the source check sheet. Runs at load; flags SUNO
// pathologies (bass in sides, unstable width, image lean, harsh highs) with
// measured values and one-click fixes, plus the dynamics report (PLR/LRA)
// and the per-platform delivery table. Nothing is ever applied silently
// unless the user has armed AUTO-FIX.
import { useStore } from '../state/store';
import { PLATFORMS } from '../audio/dsp/params';

export function DiagDialog() {
  const open = useStore((s) => s.diagOpen);
  const source = useStore((s) => s.source);
  const issues = useStore((s) => s.diagIssues);
  const checks = useStore((s) => s.diagChecks);
  const autoFix = useStore((s) => s.autoFix);
  const openDiag = useStore((s) => s.openDiag);
  const toggleDiagIssue = useStore((s) => s.toggleDiagIssue);
  const setAutoFix = useStore((s) => s.setAutoFix);
  const applyDiagFixes = useStore((s) => s.applyDiagFixes);
  const targetLufs = useStore((s) => s.targetLufs);

  if (!open || !source) return null;

  const plr = source.truePeakDb - source.lufs;

  const anyChecked = issues.some((i) => i.checked);

  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) openDiag(false); }}>
      <div className="dialog frame" role="dialog" aria-label="Track diagnosis" style={{ width: 520 }}>
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>

        <div>
          <div className="display dtitle">Track diagnosis</div>
          <div className="spec" style={{ marginTop: 4 }}>
            SOURCE CHECKS · {issues.length === 0 ? 'ALL CLEAR' : `${issues.length} FOUND`} · {source.name.toUpperCase()}
          </div>
        </div>

        <div className="statgrid">
          {checks.map((c) => (
            <div className="row" key={c.label} style={{ alignItems: 'center', gap: 8 }}>
              <span className={`lamp ${c.pass ? 'run' : 'fault'}`} />
              <span className="spec" style={!c.pass ? { color: 'var(--text-body)' } : undefined}>{c.label}</span>
              <span className="leader" />
              <span className="spec-value" style={{ fontSize: 11 }}>{c.spec}</span>
            </div>
          ))}
        </div>

        {issues.length > 0 && (
          <>
            <div className="boxlabel" style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 10 }}>
              <span className="spec" style={{ color: 'var(--text-body)' }}>APPLY FIXES FOR</span>
              <span className="spec">UNCHECK TO SKIP</span>
            </div>
            <div className="statgrid">
              {issues.map((i) => (
                <label className="row" key={i.id} style={{ alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={i.checked}
                    onChange={() => toggleDiagIssue(i.id)}
                    style={{ accentColor: 'var(--signal-500)', width: 13, height: 13 }}
                  />
                  <span className="spec" style={{ color: 'var(--text-body)' }}>{i.label}</span>
                  <span className="leader" />
                  <span className="spec-value" style={{ fontSize: 11, color: 'var(--text-accent)' }}>{i.fixLabel}</span>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="boxlabel" style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 10 }}>
          <span className="spec" style={{ color: 'var(--text-body)' }}>SOURCE DYNAMICS</span>
          <span className="spec">EBU R128</span>
        </div>
        <div className="statgrid">
          <div className="row">
            <span className="spec">INTEGRATED / TRUE PEAK</span>
            <span className="leader" />
            <span className="spec-value">{source.lufs.toFixed(1)} LUFS · {source.truePeakDb.toFixed(1)} dBTP</span>
          </div>
          <div className="row">
            <span className="spec">PLR (PEAK − LOUDNESS)</span>
            <span className="leader" />
            <span className="spec-value">{plr.toFixed(1)} dB {plr < 8 ? '· ALREADY CRUSHED' : plr > 14 ? '· VERY DYNAMIC' : ''}</span>
          </div>
          <div className="row">
            <span className="spec">LOUDNESS RANGE (LRA)</span>
            <span className="leader" />
            <span className="spec-value">{source.lra.toFixed(1)} LU {source.lra < 4 ? '· FLAT' : source.lra > 12 ? '· WIDE DYNAMICS' : ''}</span>
          </div>
        </div>

        <div className="boxlabel" style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 10 }}>
          <span className="spec" style={{ color: 'var(--text-body)' }}>DELIVERY AT {targetLufs.toFixed(1)} LUFS</span>
          <span className="spec">NORMALIZATION</span>
        </div>
        <div className="statgrid">
          {PLATFORMS.filter((p) => ['spotify', 'apple', 'youtube', 'tidal'].includes(p.id)).map((p) => {
            const delta = targetLufs - p.targetLufs;
            return (
              <div className="row" key={p.id}>
                <span className="spec">{p.name}</span>
                <span className="leader" />
                <span className="spec-value" style={delta > 2 ? { color: 'var(--warn-500)' } : undefined}>
                  {delta > 0.2 ? `TURNED DOWN ${delta.toFixed(1)} dB`
                    : delta < -0.2 ? `PLAYED ${Math.abs(delta).toFixed(1)} dB UNDER — NOT BOOSTED`
                    : 'PLAYS AS MASTERED'}
                </span>
              </div>
            );
          })}
        </div>

        <div className="drow" style={{ justifyContent: 'space-between' }}>
          <button
            className={`btn btn-sm btn-toggle ${autoFix ? 'on' : ''}`}
            onClick={() => setAutoFix(!autoFix)}
            title="Apply detected fixes automatically whenever a track loads"
          >
            <span className={`lamp ${autoFix ? 'signal' : ''}`} />
            AUTO-FIX ON LOAD
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => openDiag(false)}>
              {issues.length === 0 ? 'DONE' : 'SKIP'}
            </button>
            {issues.length > 0 && (
              <button className="btn btn-accent" disabled={!anyChecked} onClick={applyDiagFixes}>
                APPLY SELECTED →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
