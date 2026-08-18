import { useStore } from '../state/store';
import { pickAndLoadFile } from '../lib/filepick';

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
  const openBatch = useStore((s) => s.openBatch);

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
        <div className="name">{source.name}</div>
        <div className="specs">
          <span className="spec">IN {source.lufs.toFixed(1)} LUFS</span>
          <span className="spec">{(source.originalSampleRate / 1000).toFixed(1)}K{source.originalBitDepth ? `/${source.originalBitDepth}` : ''}→48K</span>
          <span className="spec" style={tempo && tempo.confidence > 0.25 ? { color: 'var(--text-body)' } : undefined}>
            {tempo ? `${tempo.bpm.toFixed(1)} BPM${tempo.confidence < 0.25 ? ' ?' : ''}` : '… BPM'}
          </span>
        </div>
      </div>

      <div className="strip-actions">
        <button
          className="btn btn-sm btn-accent"
          disabled={useStore((s) => s.masterItBusy)}
          onClick={() => void useStore.getState().masterIt()}
          title="Auto-master: analysis picks a preset, applies fixes, shows its reasoning"
        >
          AUTO →
        </button>
        <button
          className={`btn btn-sm btn-toggle ${useStore((s) => s.matchEqGains.length > 0) ? 'on' : ''}`}
          onClick={() => useStore.getState().openMatch(true)}
          title="Match this master to a reference track"
        >
          MATCH
        </button>
        <button
          className={`btn btn-sm btn-toggle ${bypass ? 'on' : ''}`}
          onClick={() => setBypass(!bypass)}
          title="Loudness-matched reference (hear the untouched source) · key R"
        >
          <span className={`lamp ${bypass ? 'signal' : ''}`} />
          REF
        </button>
        <button
          className={`btn btn-sm btn-toggle ${limiterDelta ? 'on' : ''}`}
          onClick={() => setLimiterDelta(!limiterDelta)}
          title="Hear only what the limiter is removing (never exported)"
          disabled={bypass}
        >
          <span className={`lamp ${limiterDelta ? 'warn' : ''}`} />
          LIM Δ
        </button>
        <button
          className={`btn btn-sm btn-toggle ${metronome ? 'on' : ''}`}
          onClick={() => setMetronome(!metronome)}
          title={tempo ? `Metronome click at ${tempo.bpm.toFixed(1)} BPM (never exported)` : 'Metronome (waiting for tempo detection)'}
          disabled={!tempo}
        >
          <span className={`lamp ${metronome ? 'signal' : ''}`} />
          CLICK
        </button>
        <button
          className="btn btn-sm btn-toggle"
          onClick={() => openDiag(true)}
          title="Source check sheet: bass placement, width stability, balance, HF texture"
        >
          <span className={`lamp ${diagIssueCount > 0 ? 'warn' : 'run'}`} />
          DIAG
        </button>
        <button
          className="btn btn-sm btn-secondary"
          onClick={() => void useStore.getState().saveProject()}
          title="Save project — console, slots, metadata, batch queue (Ctrl+S)"
        >
          SAVE
        </button>
        <button className="btn btn-sm btn-secondary" onClick={() => void pickAndLoadFile()}
          title="Load audio or a .jmaster project (Ctrl+O)">
          LOAD
        </button>
        <button className="btn btn-sm btn-secondary" onClick={() => openBatch(true)} title="Master a whole album with these settings">
          BATCH
        </button>
      </div>
    </div>
  );
}
