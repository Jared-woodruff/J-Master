import { useStore } from '../state/store';
import { PLATFORMS, type ClipMode } from '../audio/dsp/params';

const CLIP: { id: ClipMode; label: string; title: string }[] = [
  { id: 'off', label: 'OUT', title: 'No clipper: the limiter does all the work' },
  { id: 'soft', label: 'SOFT', title: 'Rounds off the tallest peaks before the limiter: louder with less pumping, a little colour · 4× oversampled' },
  { id: 'hard', label: 'HARD', title: 'Shaves the tallest peaks flat before the limiter: the loudest, most forward option · best on drums-forward material · 4× oversampled' },
];

/**
 * Where an export of the console as it stands will land, from the
 * background solve: the box's own headline, so it is always in view.
 */
function Estimate() {
  const loaded = useStore((s) => s.loaded);
  const est = useStore((s) => s.masterEstimate);
  const pending = useStore((s) => s.previewPending);
  const targetLufs = useStore((s) => s.targetLufs);
  const tooLong = useStore((s) => (s.source?.durationSec ?? 0) > 20 * 60);
  if (!loaded) return <span className="spec">LOUDNESS TARGET</span>;

  const HOW = 'What an export would measure right now: the whole track is rendered in the background each time the console settles, and playback runs at that same gain';
  let value: string;
  let detail: string;
  let warn = false;
  if (est && !pending) {
    if (!est.measured) {
      value = 'TOO QUIET TO MEASURE';
      detail = 'It renders at unity gain, not at the target';
      warn = true;
    } else if (!est.reached) {
      value = `LANDS ${est.lufs.toFixed(1)} · ${(targetLufs - est.lufs).toFixed(1)} LU SHORT`;
      detail = 'The target is out of reach under this ceiling: lower the target, raise the ceiling, or bring CLIP in';
      warn = true;
    } else {
      value = `LANDS ${est.lufs.toFixed(1)} LUFS · ${est.truePeakDb.toFixed(1)} dBTP`;
      detail = `Limiter ${est.limiterMaxGrDb.toFixed(1)} dB at its deepest${est.clipMaxGrDb > 0.05 ? `, clip ${est.clipMaxGrDb.toFixed(1)} dB` : ''} · loudness range ${est.lra.toFixed(1)} LU`;
    }
  } else if (pending || !tooLong) {
    value = 'SOLVING…';
    detail = 'Rendering the whole track in the background';
  } else {
    value = 'SOLVED ON EXPORT';
    detail = 'Over 20 minutes: solved when OUT is shown, or on export';
  }
  return (
    <span className={`spec estimate ${warn ? 'warn' : ''}`} role="status" title={`${detail} · ${HOW}`}>{value}</span>
  );
}

export function OutputBox() {
  const platformId = useStore((s) => s.platformId);
  const targetLufs = useStore((s) => s.targetLufs);
  const ceilingDb = useStore((s) => s.ceilingDb);
  const clipMode = useStore((s) => s.clipMode);
  const applyPlatform = useStore((s) => s.applyPlatform);
  const nudgeTarget = useStore((s) => s.nudgeTarget);
  const nudgeCeiling = useStore((s) => s.nudgeCeiling);
  const setClipMode = useStore((s) => s.setClipMode);

  return (
    <div className="outputbox">
      <div className="boxlabel">
        <span className="spec" style={{ color: 'var(--text-body)' }}>OUTPUT</span>
        <Estimate />
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
            <div className="stepper" role="group" aria-label="Loudness target">
              <button onClick={() => nudgeTarget(-0.5)} aria-label="Lower target">−</button>
              <button onClick={() => nudgeTarget(0.5)} aria-label="Raise target">+</button>
            </div>
          </div>
        </div>
        <div className="tgroup">
          <div className="spec">CEILING · dBTP</div>
          <div className="tval">
            <span className="big">{ceilingDb.toFixed(1)}</span>
            <div className="stepper" role="group" aria-label="True-peak ceiling">
              <button onClick={() => nudgeCeiling(-0.1)} aria-label="Lower ceiling">−</button>
              <button onClick={() => nudgeCeiling(0.1)} aria-label="Raise ceiling">+</button>
            </div>
          </div>
        </div>
      </div>
      <div className="target-row">
        <div className="tgroup">
          <div className="spec">CLIP · BEFORE THE LIMITER</div>
          <div className="seg" role="group" aria-label="Peak clipper">
            {CLIP.map((c) => (
              <button key={c.id} className={clipMode === c.id ? 'on' : ''} aria-pressed={clipMode === c.id}
                title={c.title} onClick={() => setClipMode(c.id)}>{c.label}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
