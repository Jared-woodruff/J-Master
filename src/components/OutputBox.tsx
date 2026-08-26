import { useStore } from '../state/store';
import { PLATFORMS } from '../audio/dsp/params';

export function OutputBox() {
  const platformId = useStore((s) => s.platformId);
  const targetLufs = useStore((s) => s.targetLufs);
  const ceilingDb = useStore((s) => s.ceilingDb);
  const applyPlatform = useStore((s) => s.applyPlatform);
  const nudgeTarget = useStore((s) => s.nudgeTarget);
  const nudgeCeiling = useStore((s) => s.nudgeCeiling);
  const openExport = useStore((s) => s.openExport);
  const loaded = useStore((s) => s.loaded);
  const balanceDb = useStore((s) => s.balanceDb);
  const setBalance = useStore((s) => s.setBalance);
  const autoCenter = useStore((s) => s.autoCenter);
  const balanceOffset = useStore((s) => s.source?.balanceOffsetDb ?? 0);

  return (
    <div className="outputbox">
      <div className="boxlabel">
        <span className="spec" style={{ color: 'var(--text-body)' }}>OUTPUT</span>
        <span className="spec">LOUDNESS TARGET</span>
      </div>
      <div className="platgrid" role="group" aria-label="Streaming platform targets">
        {PLATFORMS.map((p) => (
          <button
            key={p.id}
            className={platformId === p.id ? 'on' : ''}
            onClick={() => applyPlatform(p.id)}
            title={p.spec}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div className="target-row">
        <div>
          <div className="spec">TARGET</div>
          <div className="big">{targetLufs.toFixed(1)} <span className="spec">LUFS</span></div>
        </div>
        <div className="stepper">
          <button onClick={() => nudgeTarget(-0.5)} aria-label="Lower target">−</button>
          <button onClick={() => nudgeTarget(0.5)} aria-label="Raise target">+</button>
        </div>
        <div>
          <div className="spec">CEILING</div>
          <div className="big">{ceilingDb.toFixed(1)} <span className="spec">dBTP</span></div>
        </div>
        <div className="stepper">
          <button onClick={() => nudgeCeiling(-0.1)} aria-label="Lower ceiling">−</button>
          <button onClick={() => nudgeCeiling(0.1)} aria-label="Raise ceiling">+</button>
        </div>
      </div>
      <div className="target-row">
        <div>
          <div className="spec">BALANCE</div>
          <div className="big" style={{ fontSize: 14 }}>
            {balanceDb === 0 ? 'CENTER' : `${balanceDb < 0 ? 'L' : 'R'} ${Math.abs(balanceDb).toFixed(1)}`}
            {' '}<span className="spec">dB</span>
          </div>
        </div>
        <div className="stepper">
          <button onClick={() => setBalance(balanceDb - 0.1)} aria-label="Shift left">−</button>
          <button onClick={() => setBalance(balanceDb + 0.1)} aria-label="Shift right">+</button>
        </div>
        <button
          className="btn btn-sm btn-secondary"
          disabled={!loaded || Math.abs(balanceOffset) < 0.05}
          title={`Source image leans ${balanceOffset >= 0 ? 'right' : 'left'} by ${Math.abs(balanceOffset).toFixed(1)} dB — correct it`}
          onClick={autoCenter}
        >
          AUTO-CENTER
        </button>
      </div>
      <button className="btn btn-accent btn-lg" disabled={!loaded} onClick={() => openExport(true)}>
        EXPORT MASTER →
      </button>
    </div>
  );
}
