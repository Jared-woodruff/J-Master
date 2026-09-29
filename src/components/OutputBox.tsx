import { useStore } from '../state/store';
import { PLATFORMS } from '../audio/dsp/params';

export function OutputBox() {
  const platformId = useStore((s) => s.platformId);
  const targetLufs = useStore((s) => s.targetLufs);
  const ceilingDb = useStore((s) => s.ceilingDb);
  const applyPlatform = useStore((s) => s.applyPlatform);
  const nudgeTarget = useStore((s) => s.nudgeTarget);
  const nudgeCeiling = useStore((s) => s.nudgeCeiling);
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
            className={platformId === p.id ? 'on' : ''} aria-pressed={platformId === p.id}
            onClick={() => applyPlatform(p.id)}
            title={p.spec}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div className="target-row">
        <div className="tgroup">
          <div className="spec">TARGET · LUFS</div>
          <div className="tval">
            <span className="big">{targetLufs.toFixed(1)}</span>
            <div className="stepper">
              <button onClick={() => nudgeTarget(-0.5)} aria-label="Lower target">−</button>
              <button onClick={() => nudgeTarget(0.5)} aria-label="Raise target">+</button>
            </div>
          </div>
        </div>
        <div className="tgroup">
          <div className="spec">CEILING · dBTP</div>
          <div className="tval">
            <span className="big">{ceilingDb.toFixed(1)}</span>
            <div className="stepper">
              <button onClick={() => nudgeCeiling(-0.1)} aria-label="Lower ceiling">−</button>
              <button onClick={() => nudgeCeiling(0.1)} aria-label="Raise ceiling">+</button>
            </div>
          </div>
        </div>
      </div>
      <div className="target-row">
        <div className="tgroup">
          <div className="spec">BALANCE · dB</div>
          <div className="tval">
            <span className="big" style={{ fontSize: 14 }}>
              {balanceDb === 0 ? 'CENTER' : `${balanceDb < 0 ? 'L' : 'R'} ${Math.abs(balanceDb).toFixed(1)}`}
            </span>
            <div className="stepper">
              <button onClick={() => setBalance(balanceDb - 0.1)} aria-label="Shift left">−</button>
              <button onClick={() => setBalance(balanceDb + 0.1)} aria-label="Shift right">+</button>
            </div>
          </div>
        </div>
        <button
          className="btn btn-sm btn-secondary"
          disabled={!loaded || Math.abs(balanceOffset) < 0.05}
          title={`Source image leans ${balanceOffset >= 0 ? 'right' : 'left'} by ${Math.abs(balanceOffset).toFixed(1)} dB · correct it`}
          onClick={autoCenter}
        >
          AUTO-CENTER
        </button>
      </div>
    </div>
  );
}
