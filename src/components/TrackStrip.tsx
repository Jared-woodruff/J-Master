import { useStore } from '../state/store';

function fmtTime(sec: number, ms = true): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  if (!ms) return `${m}:${s}`;
  const milli = Math.floor((sec % 1) * 1000).toString().padStart(3, '0');
  return `${m}:${s}.${milli}`;
}

export function TrackStrip() {
  const source = useStore((s) => s.source);
  const playing = useStore((s) => s.playing);
  const playheadSec = useStore((s) => s.playheadSec);
  const bypass = useStore((s) => s.bypass);
  const limiterDelta = useStore((s) => s.limiterDelta);
  const tempo = useStore((s) => s.tempo);
  const metronome = useStore((s) => s.metronome);
  const setMetronome = useStore((s) => s.setMetronome);
  const diagIssueCount = useStore((s) => s.diagIssues.length);
  const openDiag = useStore((s) => s.openDiag);
  const togglePlay = useStore((s) => s.togglePlay);
  const stop = useStore((s) => s.stop);
  const seekSec = useStore((s) => s.seekSec);
  const setBypass = useStore((s) => s.setBypass);
  const setLimiterDelta = useStore((s) => s.setLimiterDelta);
  const openExport = useStore((s) => s.openExport);
  const masterItBusy = useStore((s) => s.masterItBusy);
  const matchActive = useStore((s) => s.matchEqGains.length > 0);

  if (!source) return null;

  return (
    <div className="trackstrip">
      <div className="transport" role="group" aria-label="Transport">
        <button onClick={() => seekSec(0)} title="Return to start" aria-label="Return to start">⏮</button>
        <button
          className={playing ? 'play-on' : ''}
          onClick={togglePlay}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button onClick={stop} title="Stop" aria-label="Stop">■</button>
      </div>

      <div className="timecode">
        {fmtTime(playheadSec)} <span className="total">/ {fmtTime(source.durationSec, false)}</span>
      </div>

      <div className="trackmeta">
        <div className="name" title={source.name}>{source.name}</div>
        <div className="specs">
          <span className="spec">IN {source.lufs.toFixed(1)} LUFS</span>
          <span className="spec">{(source.originalSampleRate / 1000).toFixed(1)}K{source.originalBitDepth ? `/${source.originalBitDepth}` : ''}→48K</span>
          <span className="spec" style={tempo && tempo.confidence > 0.25 ? { color: 'var(--text-body)' } : undefined}>
            {tempo ? `${tempo.bpm.toFixed(1)} BPM${tempo.confidence < 0.25 ? ' ?' : ''}` : '… BPM'}
          </span>
        </div>
      </div>

      <div className="strip-actions">
        {/* Analyse and shape */}
        <div className="strip-group">
          <button
            className="btn btn-sm btn-toggle"
            onClick={() => openDiag(true)}
            title={diagIssueCount > 0
              ? `Source check sheet · ${diagIssueCount} issue${diagIssueCount > 1 ? 's' : ''} found`
              : 'Source check sheet · all clear'}
          >
            <span className={`lamp ${diagIssueCount > 0 ? 'warn' : 'run'}`} />
            DIAG
          </button>
          <button
            className="btn btn-sm btn-secondary"
            disabled={masterItBusy}
            onClick={() => void useStore.getState().masterIt()}
            title="Auto-master: analysis picks a preset, applies fixes, and shows its reasoning"
          >
            {masterItBusy ? 'THINKING…' : 'AUTO →'}
          </button>
          <button
            className={`btn btn-sm btn-toggle ${matchActive ? 'on' : ''}`}
            onClick={() => useStore.getState().openMatch(true)}
            title="Match this master to a reference track you trust"
          >
            MATCH
          </button>
        </div>
        {/* Listen */}
        <div className="strip-group">
          <button
            className={`btn btn-sm btn-toggle ${bypass ? 'on' : ''}`}
            onClick={() => setBypass(!bypass)}
            title="Hear the untouched source, loudness-matched · R · hold R for a momentary compare"
          >
            <span className={`lamp ${bypass ? 'signal' : ''}`} />
            REF
          </button>
          <button
            className={`btn btn-sm btn-toggle ${limiterDelta ? 'on' : ''}`}
            onClick={() => setLimiterDelta(!limiterDelta)}
            title="Hear only what the limiter is removing · never exported"
            disabled={bypass}
          >
            <span className={`lamp ${limiterDelta ? 'warn' : ''}`} />
            LIM Δ
          </button>
          <button
            className={`btn btn-sm btn-toggle ${metronome ? 'on' : ''}`}
            onClick={() => setMetronome(!metronome)}
            title={tempo ? `Metronome click at ${tempo.bpm.toFixed(1)} BPM · never exported` : 'Metronome · waiting for tempo detection'}
            disabled={!tempo}
          >
            <span className={`lamp ${metronome ? 'signal' : ''}`} />
            CLICK
          </button>
        </div>
        <button className="btn btn-sm btn-accent strip-export" onClick={() => openExport(true)}
          title="Render and save the master · E">
          EXPORT →
        </button>
      </div>
    </div>
  );
}
