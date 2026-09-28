// TRACK DIAGNOSIS — the source check sheet. Runs at load; flags common
// AI-music pathologies (bass in sides, unstable width, image lean, harsh
// highs, tempo drift) with measured values and one-click fixes where a fix
// exists, plus the dynamics report (PLR/LRA) and the per-platform delivery
// table. Nothing is ever applied silently unless the user has armed
// AUTO-FIX.
import { useStore, TEMPO_CHECK } from '../state/store';
import type { DiagIssue } from '../state/store';
import type { TempoInfo, TempoDrift } from '../audio/engine';
import { PLATFORMS } from '../audio/dsp/params';
import { driftDelta, mmss, slipText } from '../lib/tempo-text';

/** The tempo curve at a glance: the reference, the curve, the drift. */
function DriftChart({ tempo, drift, durSec }: { tempo: TempoInfo; drift: TempoDrift; durSec: number }) {
  const curve = tempo.curve;
  if (!curve) return null;
  const W = 480, H = 64, padT = 6, padB = 12;
  const vals = curve.bpm.filter(Number.isFinite);
  const lo = Math.min(drift.refBpm, ...vals) - 0.4;
  const hi = Math.max(drift.refBpm, ...vals) + 0.4;
  const x = (sec: number) => (sec / durSec) * W;
  const y = (bpm: number) => padT + (1 - (bpm - lo) / (hi - lo)) * (H - padT - padB);
  const pts = curve.bpm
    .map((v, i) => (Number.isFinite(v) ? `${x(curve.startSec + i * curve.stepSec).toFixed(1)},${y(v).toFixed(1)}` : ''))
    .filter(Boolean)
    .join(' ');
  return (
    <svg className="driftchart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Tempo curve from ${drift.refBpm.toFixed(1)} to ${drift.endBpm.toFixed(1)} BPM`}>
      <defs>
        <clipPath id="drift-regions">
          {drift.regions.map((r, i) => (
            <rect key={i} x={x(r.startSec)} y={0} width={Math.max(1, x(r.endSec) - x(r.startSec))} height={H} />
          ))}
        </clipPath>
      </defs>
      {drift.regions.map((r, i) => (
        <rect key={i} x={x(r.startSec)} y={padT} width={Math.max(1, x(r.endSec) - x(r.startSec))}
          height={H - padT - padB} className="drift-zone" />
      ))}
      <line x1={0} x2={W} y1={y(drift.refBpm)} y2={y(drift.refBpm)} className="drift-ref" />
      <polyline points={pts} className="drift-curve" />
      <polyline points={pts} className="drift-curve hot" clipPath="url(#drift-regions)" />
      <text x={2} y={y(drift.refBpm) - 3} className="drift-label">{drift.refBpm.toFixed(1)}</text>
      <text x={W - 2} y={y(drift.endBpm) - 3} className="drift-label" textAnchor="end">{drift.endBpm.toFixed(1)}</text>
      <text x={2} y={H - 1} className="drift-label">0:00</text>
      <text x={W - 2} y={H - 1} className="drift-label" textAnchor="end">{mmss(durSec)}</text>
    </svg>
  );
}

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
  const macros = useStore((s) => s.macros);
  const bassMono = useStore((s) => s.bassMono);
  const balanceDb = useStore((s) => s.balanceDb);
  const tempo = useStore((s) => s.tempo);

  if (!open || !source) return null;
  const drift = tempo?.drift ?? null;
  const flagged = checks.filter((c) => !c.pass).length;

  const showDrift = () => {
    if (!drift) return;
    const st = useStore.getState();
    st.setTempoLane(true);
    const first = drift.regions[0];
    const span = first ? first.endSec - first.startSec : source.durationSec;
    if (first && span < source.durationSec * 0.8) {
      const pad = Math.max(4, span * 0.08);
      st.focusWave(Math.max(0, first.startSec - pad), Math.min(source.durationSec, first.endSec + pad));
    } else {
      st.focusWave(0, source.durationSec);
    }
    openDiag(false);
  };

  // A fix counts as applied while the console state still covers it, so
  // reopening the sheet reports what is already handled instead of
  // silently re-offering it.
  const fixApplied = (i: DiagIssue): boolean => {
    switch (i.action.type) {
      case 'bassMono': return bassMono;
      case 'width': return macros.width <= i.action.value + 0.005;
      case 'smooth': return macros.smooth >= i.action.value - 0.005;
      case 'balance': {
        const wanted = Math.max(-3, Math.min(3, +(-source.balanceOffsetDb).toFixed(1)));
        return Math.abs(balanceDb - wanted) <= 0.05;
      }
    }
  };

  const plr = source.truePeakDb - source.lufs;

  const anyChecked = issues.some((i) => i.checked && !fixApplied(i));

  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) openDiag(false); }}>
      <div className="dialog frame" role="dialog" aria-label="Track diagnosis" style={{ width: 520 }}>
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>

        <div>
          <div className="display dtitle">Track diagnosis</div>
          <div className="spec" title={source.name}
            style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            SOURCE CHECKS · {flagged === 0 ? 'ALL CLEAR' : `${flagged} FOUND`} · {source.name.toUpperCase()}
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
          {!checks.some((c) => c.label === TEMPO_CHECK) && (
            <div className="row" style={{ alignItems: 'center', gap: 8 }}>
              <span className="lamp" />
              <span className="spec">{TEMPO_CHECK}</span>
              <span className="leader" />
              <span className="spec-value" style={{ fontSize: 11 }}>MEASURING…</span>
            </div>
          )}
        </div>

        {drift && tempo && (
          <>
            <div className="boxlabel" style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 10 }}>
              <span className="spec" style={{ color: 'var(--text-body)' }}>TEMPO DRIFT</span>
              <span className="spec">NO AUDIO FIX · FLAGGED</span>
            </div>
            <DriftChart tempo={tempo} drift={drift} durSec={source.durationSec} />
            <div className="statgrid">
              <div className="row">
                <span className="spec">SETS OUT AT</span>
                <span className="leader" />
                <span className="spec-value">{drift.refBpm.toFixed(1)} BPM</span>
              </div>
              {drift.regions.slice(0, 3).map((r, i) => (
                <div className="row" key={i}>
                  <span className="spec">{i === 0 ? 'DRIFTS' : 'AGAIN'} {mmss(r.startSec)} → {mmss(r.endSec)}</span>
                  <span className="leader" />
                  <span className="spec-value" style={{ color: 'var(--warn-500)' }}>
                    {driftDelta(drift, r.peakBpm)} BY {mmss(r.peakSec)}
                  </span>
                </div>
              ))}
              <div className="row">
                <span className="spec">A FIXED GRID SLIDES</span>
                <span className="leader" />
                <span className="spec-value">{slipText(drift, tempo.bpm)} OFF</span>
              </div>
            </div>
            <div className="drow" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <span className="spec" style={{ lineHeight: 1.5, whiteSpace: 'normal', minWidth: 0, flex: '1 1 auto' }}>
                THE GRID AND CLICK NOW FOLLOW THE BEATS. FOR DJ SETS, VIDEO SYNC OR TEMPO-SYNCED
                EFFECTS, REGENERATE OR WARP TO A FIXED TEMPO FIRST.
              </span>
              <button className="btn btn-sm btn-secondary" style={{ flex: 'none' }} onClick={showDrift}>
                SHOW ON WAVEFORM →
              </button>
            </div>
          </>
        )}

        {issues.length > 0 && (
          <>
            <div className="boxlabel" style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 10 }}>
              <span className="spec" style={{ color: 'var(--text-body)' }}>APPLY FIXES FOR</span>
              <span className="spec">UNCHECK TO SKIP</span>
            </div>
            <div className="statgrid">
              {issues.map((i) => (
                fixApplied(i) ? (
                  <div className="row" key={i.id} style={{ alignItems: 'center', gap: 8 }}>
                    <span className="lamp run" />
                    <span className="spec" style={{ color: 'var(--text-body)' }}>{i.label}</span>
                    <span className="leader" />
                    <span className="spec-value" style={{ fontSize: 11 }}>{i.fixLabel} · APPLIED</span>
                  </div>
                ) : (
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
                )
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
