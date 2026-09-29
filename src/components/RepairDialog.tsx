// REPAIR DRIFT — stretches a drifting track onto one steady tempo, pitch
// unchanged (src/audio/analysis/repair.ts). Picks the tempo, shows what the
// repair will do before it runs, and follows it while it stretches. The
// file on disk is never touched: the repair plays in its place until
// reverted, and can be saved as a WAV of its own.
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { engine } from '../audio/engine';
import { planRepair } from '../audio/analysis/repair';
import { bpmText, mmss } from '../lib/tempo-text';
import { useSheetFocus } from '../lib/use-sheet-focus';

type Choice = 'start' | 'average' | 'custom';

/** Past this much stretch anywhere in the song, the repair is refused. */
const MAX_STRETCH = 0.25;
/** Past this much, it runs but asks for a careful listen. */
const WARN_STRETCH = 0.1;

/** A tempo a grid would be set to: the whole number when it's that close, else a tenth. */
function gridBpm(bpm: number): number {
  const whole = Math.round(bpm);
  return Math.abs(bpm - whole) <= 0.3 ? whole : Math.round(bpm * 10) / 10;
}

function pct(x: number): string {
  return `${(Math.abs(x) * 100).toFixed(1)}%`;
}

export function RepairDialog() {
  const open = useStore((s) => s.repairOpen);
  const source = useStore((s) => s.source);
  const tempo = useStore((s) => s.tempo);
  const repair = useStore((s) => s.driftRepair);
  const repairing = useStore((s) => s.repairing);
  const openRepair = useStore((s) => s.openRepair);
  const repairDrift = useStore((s) => s.repairDrift);
  const cancelRepair = useStore((s) => s.cancelRepair);
  const [choice, setChoice] = useState<Choice>('start');
  const [custom, setCustom] = useState('');
  const sheetRef = useSheetFocus<HTMLDivElement>(open);

  // What a repair starts from: the file's own analysis, even while a
  // repair plays (re-read when the track or its analysis changes).
  const base = useMemo(() => (open ? engine.repairBase() : null), [open, source, tempo]);
  const startBpm = base ? gridBpm(base.tempo.drift?.refBpm ?? base.tempo.bpm) : 0;
  const avgBpm = base ? gridBpm(base.tempo.bpm) : 0;

  // Opening shows the tempo in force: the repair's, else where the song sets out.
  useEffect(() => {
    if (!open) return;
    const t = useStore.getState().driftRepair?.targetBpm;
    if (t === undefined || t === startBpm) { setChoice('start'); setCustom(String(startBpm || '')); }
    else if (t === avgBpm) { setChoice('average'); setCustom(String(avgBpm)); }
    else { setChoice('custom'); setCustom(String(t)); }
  }, [open, startBpm, avgBpm]);

  const customBpm = Number(custom);
  const target = choice === 'start' ? startBpm : choice === 'average' ? avgBpm : customBpm;
  const inRange = Number.isFinite(target) && target >= 40 && target <= 300;

  const plan = useMemo(() => {
    if (!base?.tempo.curve || !inRange) return null;
    try {
      return planRepair(base.tempo.curve, target, engine.sampleRate, Math.round(base.durationSec * engine.sampleRate));
    } catch {
      return null;
    }
  }, [base, target, inRange]);

  if (!open || !source) return null;

  const busy = repairing !== null;
  const worst = plan ? Math.max(plan.maxStretch, -plan.minStretch) : 0;
  const tooFar = worst > MAX_STRETCH;
  const same = repair !== null && Math.abs(repair.targetBpm - target) < 0.005;
  const outSec = plan ? plan.outLength / engine.sampleRate : 0;
  const delta = base ? outSec - base.durationSec : 0;
  const stretchText = !plan ? '—'
    : plan.minStretch >= -0.0005 ? `SLOWS UP TO ${pct(plan.maxStretch)}`
    : plan.maxStretch <= 0.0005 ? `SPEEDS UP TO ${pct(plan.minStretch)}`
    : `SLOWS UP TO ${pct(plan.maxStretch)} · SPEEDS UP TO ${pct(plan.minStretch)}`;
  const phase = !repairing ? ''
    : repairing.pct < 0.04 ? 'SPLITTING THE BANDS'
    : repairing.pct < 0.4 ? 'STRETCHING THE LOWS · 4096-POINT FRAMES'
    : repairing.pct < 0.999 ? 'STRETCHING THE HIGHS · 2048-POINT FRAMES'
    : 'ANALYSING THE REPAIR';

  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) openRepair(false); }}>
      <div className="dialog frame" role="dialog" aria-modal="true" tabIndex={-1} ref={sheetRef}
        aria-label="Repair tempo drift" style={{ width: 500 }}>
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>

        <div>
          <div className="display dtitle">Repair drift</div>
          <div className="spec" style={{ marginTop: 4, whiteSpace: 'normal', lineHeight: 1.5 }}>
            STRETCHES THE TRACK ONTO ONE STEADY TEMPO · PITCH AND STEREO UNCHANGED
          </div>
        </div>

        {!base?.tempo.curve ? (
          <div className="spec">MEASURING THE TEMPO…</div>
        ) : (
          <>
            <div className="boxlabel" style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 10 }}>
              <span className="spec" style={{ color: 'var(--text-body)' }}>STEADY TEMPO</span>
              <span className="spec">THE GRID IT WILL SIT ON</span>
            </div>
            <div className="formrow">
              <div className="seg grow" role="group" aria-label="Target tempo">
                <button className={choice === 'start' ? 'on' : ''} aria-pressed={choice === 'start'} disabled={busy}
                  title="The tempo the song sets out at, before it drifts"
                  onClick={() => setChoice('start')}>SETS OUT · {bpmText(startBpm)}</button>
                <button className={choice === 'average' ? 'on' : ''} aria-pressed={choice === 'average'} disabled={busy}
                  title="The song's average tempo: the length changes least"
                  onClick={() => setChoice('average')}>AVERAGE · {bpmText(avgBpm)}</button>
                <button className={choice === 'custom' ? 'on' : ''} aria-pressed={choice === 'custom'} disabled={busy}
                  onClick={() => setChoice('custom')}>CUSTOM</button>
              </div>
              {choice === 'custom' && (
                <input type="number" min={40} max={300} step={0.1} value={custom} disabled={busy}
                  aria-label="Custom tempo, BPM"
                  onChange={(e) => setCustom(e.target.value)} />
              )}
            </div>

            <div className="statgrid">
              <div className="row">
                <span className="spec">LENGTH</span>
                <span className="leader" />
                <span className="spec-value">
                  {plan ? `${mmss(base.durationSec)} → ${mmss(outSec)} · ${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)} S` : '—'}
                </span>
              </div>
              <div className="row">
                <span className="spec">STRETCH</span>
                <span className="leader" />
                <span className="spec-value" style={tooFar || worst > WARN_STRETCH ? { color: 'var(--warn-500)' } : undefined}>
                  {stretchText}
                </span>
              </div>
              <div className="row">
                <span className="spec">BEATS</span>
                <span className="leader" />
                <span className="spec-value">{plan ? `${plan.beats} ON ONE ${bpmText(target)} BPM GRID` : '—'}</span>
              </div>
            </div>

            <div className="spec" style={{ lineHeight: 1.5, whiteSpace: 'normal' }}>
              {!inRange ? 'PICK A TEMPO FROM 40 TO 300 BPM.'
                : tooFar ? `THAT TEMPO IS MORE THAN ${pct(MAX_STRETCH)} FROM THE SONG'S. PICK ONE CLOSER.`
                : worst > WARN_STRETCH ? 'A LARGE STRETCH: LISTEN CLOSELY TO THE ATTACKS AND THE BASS AFTERWARDS.'
                : 'THE REPAIR PLAYS, MASTERS AND EXPORTS IN PLACE OF THE FILE. THE FILE ON DISK IS NOT TOUCHED: REVERT, OR SAVE THE REPAIR AS A WAV, FROM DIAG.'}
            </div>
          </>
        )}

        {busy && repairing && (
          <div>
            <div className="drow" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="spec">{phase}</span>
              <span className="spec-value">{Math.round(repairing.pct * 100)}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${repairing.pct * 100}%` }} />
            </div>
          </div>
        )}

        <div className="drow" style={{ justifyContent: 'flex-end', gap: 8 }}>
          {busy ? (
            <button className="btn btn-secondary" onClick={cancelRepair}>CANCEL REPAIR</button>
          ) : (
            <>
              <button className="btn btn-secondary" onClick={() => openRepair(false)}>CANCEL</button>
              <button className="btn btn-accent" disabled={!plan || tooFar || same}
                onClick={() => void repairDrift(target)}>
                {same ? 'REPAIRED AT THIS TEMPO' : repair ? 'REPAIR AGAIN →' : 'REPAIR →'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
