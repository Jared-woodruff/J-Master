// The AUTO-MASTER decision sheet: what was measured, what was chosen, why.
import { useStore } from '../state/store';

export function MasterItReport() {
  const report = useStore((s) => s.masterItReport);
  const close = useStore((s) => s.closeMasterItReport);
  const undo = useStore((s) => s.undo);

  if (!report) return null;

  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog frame" role="dialog" aria-label="Auto-master report" style={{ width: 480 }}>
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>

        <div>
          <div className="display dtitle">Mastered<span style={{ color: 'var(--signal-500)' }}>.</span></div>
          <div className="spec" style={{ marginTop: 4 }}>
            {report.presetName} · EVERY DECISION SHOWN · ADJUST ANYTHING
          </div>
        </div>

        <div className="statgrid">
          {report.reasons.map((r, i) => (
            <div className="row" key={i} style={{ alignItems: 'center', gap: 8 }}>
              <span className="lamp run" />
              <span className="spec" style={{ color: 'var(--text-body)', letterSpacing: '0.08em' }}>{r}</span>
            </div>
          ))}
        </div>

        <div className="drow" style={{ justifyContent: 'space-between' }}>
          <button className="btn btn-secondary" onClick={() => { undo(); close(); }}>
            UNDO ALL OF IT
          </button>
          <button className="btn btn-accent" onClick={close}>SOUNDS GOOD →</button>
        </div>
      </div>
    </div>
  );
}
