import { useStore } from '../state/store';
import { Knob } from './Knob';
import { OutputBox } from './OutputBox';
import { AdvEqDrawer } from './AdvEqDrawer';
import { FadeCurve, eqBandActive } from '../audio/dsp/params';

const pct = (v: number) => `${Math.round(v * 100)}`;
const signedPct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;

const HOW = 'drag, wheel or arrows · Shift for fine · double-click resets';
const HINT = {
  tone: `Spectral tilt from warm to bright: ±4.5 dB around 700 Hz · ${HOW}`,
  shape: `Mid contour: scooped (wall of sound) to forward (presence) · ${HOW}`,
  air: `Sheen: a 13 kHz shelf, up to +6 dB · ${HOW}`,
  smooth: `Dynamic de-harsh: cuts harsh highs only when they flare up · ${HOW}`,
  character: `Harmonic drive: 4× oversampled tape and tube colour · ${HOW}`,
  density: `Glue compression with auto make-up: thickness without pumping · ${HOW}`,
  impact: `Transient contour: soften to punch, up to ±6 dB on attacks · ${HOW}`,
  width: `Stereo width with the bass anchored below 140 Hz and the highs opened most · ${HOW}`,
};

const CURVES: { id: FadeCurve; label: string }[] = [
  { id: 'linear', label: 'LIN' },
  { id: 'smooth', label: 'S' },
  { id: 'exp', label: 'EXP' },
  { id: 'log', label: 'LOG' },
];

export function ConsolePanel() {
  const macros = useStore((s) => s.macros);
  const setMacro = useStore((s) => s.setMacro);
  const fadeInSec = useStore((s) => s.fadeInSec);
  const fadeOutSec = useStore((s) => s.fadeOutSec);
  const fadeInCurve = useStore((s) => s.fadeInCurve);
  const fadeOutCurve = useStore((s) => s.fadeOutCurve);
  const setFade = useStore((s) => s.setFade);
  const setFadeCurve = useStore((s) => s.setFadeCurve);

  const activeSlot = useStore((s) => s.activeSlot);
  const hasB = useStore((s) => s.snapshots.B !== null);
  const switchSlot = useStore((s) => s.switchSlot);
  const undoDepth = useStore((s) => s.undoDepth);
  const redoDepth = useStore((s) => s.redoDepth);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const advEqOpen = useStore((s) => s.advEqOpen);
  const setAdvEqOpen = useStore((s) => s.setAdvEqOpen);
  const advEqActive = useStore((s) => s.advEq.some((b) => eqBandActive(b)));
  const matchActive = useStore((s) => s.matchEqGains.length > 0);
  const stems = useStore((s) => s.stems);
  const setStem = useStore((s) => s.setStem);
  const stemsOpen = useStore((s) => s.stemsOpen);
  const setStemsOpen = useStore((s) => s.setStemsOpen);
  const airRestore = useStore((s) => s.airRestore);
  const airRestoreHz = useStore((s) => s.airRestoreHz);
  const setAirRestore = useStore((s) => s.setAirRestore);
  const cutoffHz = useStore((s) => s.source?.checks.cutoffHz ?? null);
  const sourceFix = useStore((s) => s.sourceFix);
  const setSourceFix = useStore((s) => s.setSourceFix);
  const bassMono = useStore((s) => s.bassMono);
  const trimStartSec = useStore((s) => s.trimStartSec);
  const trimEndSec = useStore((s) => s.trimEndSec);
  const durationSec = useStore((s) => s.source?.durationSec ?? 0);
  const clearTrim = useStore((s) => s.clearTrim);
  const loaded = useStore((s) => s.loaded);
  const balanceDb = useStore((s) => s.balanceDb);
  const setBalance = useStore((s) => s.setBalance);
  const autoCenter = useStore((s) => s.autoCenter);
  const balanceOffset = useStore((s) => s.source?.balanceOffsetDb ?? 0);
  const stemsActive = stems.bass !== 0 || stems.drums !== 0 || stems.vocal !== 0 || stems.air !== 0 || airRestore > 0;
  const trimmed = trimStartSec > 0 || trimEndSec > 0;
  const restoreFrom = (airRestore > 0 ? airRestoreHz : cutoffHz && cutoffHz < 20000 ? cutoffHz : airRestoreHz) / 1000;

  return (
    <div className="panel panel-console">
      <div className="panel-head">
        <span className="title">Console</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="seg" style={{ height: 20 }}>
            <button disabled={undoDepth === 0} title="Undo · Ctrl+Z" aria-label="Undo" onClick={undo}>⟲</button>
            <button disabled={redoDepth === 0} title="Redo · Ctrl+Y" aria-label="Redo" onClick={redo}>⟳</button>
          </span>
          <span className="seg" style={{ height: 20 }}>
            <button className={advEqOpen ? 'on' : ''}
              title={`Advanced 6-band parametric EQ${advEqActive ? ' · bands active' : ''}`}
              aria-pressed={advEqOpen}
              onClick={() => setAdvEqOpen(!advEqOpen)}>
              EQ{advEqActive && <span className="seglamp" aria-label="active" />}
            </button>
            <button className={stemsOpen ? 'on' : ''}
              title={`Lanes: bass / drums / vocal / air trims, and AIR RESTORE for band-limited sources${stemsActive ? ' · in use' : ''}`}
              aria-pressed={stemsOpen}
              onClick={() => setStemsOpen(!stemsOpen)}>
              LANES{stemsActive && <span className="seglamp" aria-label="active" />}
            </button>
          </span>
          {matchActive && <span className="spec" style={{ color: 'var(--text-accent)' }}>MATCHED</span>}
          {bassMono && <span className="spec" title="Bass is mono below 140 Hz (a check-sheet fix) · undo to take it off">BASS MONO</span>}
          {sourceFix !== 'none' && (
            <button className="chipfix" onClick={() => setSourceFix('none')}
              title={`${sourceFix === 'flip' ? 'The right side is turned over (it arrived out of phase)' : `The ${sourceFix} side plays on both (the other arrived silent)`} · click to take the fix off`}>
              {sourceFix === 'flip' ? 'PHASE FIXED' : `${sourceFix === 'left' ? 'L' : 'R'} ON BOTH`} ×
            </button>
          )}
          <span className="seg" style={{ height: 20 }}>
            <button
              className={activeSlot === 'A' ? 'on' : ''} aria-pressed={activeSlot === 'A'}
              title="Console snapshot A · key A switches"
              onClick={() => switchSlot('A')}
            >A</button>
            <button
              className={activeSlot === 'B' ? 'on' : ''} aria-pressed={activeSlot === 'B'}
              title={hasB ? 'Console snapshot B · key A switches' : 'Console snapshot B (starts as a copy of A) · key A switches'}
              onClick={() => switchSlot('B')}
            >B</button>
          </span>
          <span className="spec">Macro processors</span>
        </span>
      </div>
      <div className="console-body">
        <div className="knobrow">
          <div className="knobcell" title={HINT.tone}>
            <Knob label="Tone" value={macros.tone} min={-1} max={1} defaultValue={0} bipolarFrom={0}
              entryScale={100} format={signedPct} onChange={(v) => setMacro('tone', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>WARM ◂ ▸ BRIGHT</span>
          </div>
          <div className="knobcell" title={HINT.shape}>
            <Knob label="Shape" value={macros.shape} min={-1} max={1} defaultValue={0} bipolarFrom={0}
              entryScale={100} format={signedPct} onChange={(v) => setMacro('shape', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>SCOOP ◂ ▸ FORWARD</span>
          </div>
          <div className="knobcell" title={HINT.air}>
            <Knob label="Air" value={macros.air} min={0} max={1} defaultValue={0}
              entryScale={100} format={pct} onChange={(v) => setMacro('air', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>13 KHZ SHELF</span>
          </div>
          <div className="knobcell" title={HINT.smooth}>
            <Knob label="Smooth" value={macros.smooth} min={0} max={1} defaultValue={0}
              entryScale={100} format={pct} onChange={(v) => setMacro('smooth', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>DE-HARSH HF</span>
          </div>
          <div className="knobcell" title={HINT.character}>
            <Knob label="Character" value={macros.character} min={0} max={1} defaultValue={0}
              entryScale={100} format={pct} onChange={(v) => setMacro('character', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>HARMONIC DRIVE</span>
          </div>
          <div className="knobcell" title={HINT.density}>
            <Knob label="Density" value={macros.density} min={0} max={1} defaultValue={0}
              entryScale={100} format={pct} onChange={(v) => setMacro('density', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>GLUE COMP</span>
          </div>
          <div className="knobcell" title={HINT.impact}>
            <Knob label="Impact" value={macros.impact} min={-1} max={1} defaultValue={0} bipolarFrom={0}
              entryScale={100} format={signedPct} onChange={(v) => setMacro('impact', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>SOFT ◂ ▸ PUNCH</span>
          </div>
          <div className="knobcell" title={HINT.width}>
            <Knob label="Width" value={macros.width} min={0} max={2} defaultValue={1} bipolarFrom={1}
              entryScale={100} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setMacro('width', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>TILTED · BASS SAFE</span>
          </div>
        </div>

        {stemsOpen && <div className="stemrow">
          <span className="spec stemlabel">STEM<br />LANES</span>
          {(['bass', 'drums', 'vocal', 'air'] as const).map((lane) => (
            <div className="knobcell" key={lane}>
              <Knob label={lane} value={stems[lane]} min={-3} max={3} defaultValue={0} bipolarFrom={0}
                size={46} step={0.1}
                format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`}
                onChange={(v) => setStem(lane, +v.toFixed(1))} />
            </div>
          ))}
          <div className="knobcell restore"
            title={`Air restore: grows a new top octave from the band below it, for sources that stop short (most AI generators and every MP3) · this one ${cutoffHz && cutoffHz < 19500 ? `stops at ${(cutoffHz / 1000).toFixed(1)} kHz` : 'reaches 20 kHz, so it has nothing to restore'} · ${HOW}`}>
            <Knob label="Restore" value={airRestore} min={0} max={1} defaultValue={0}
              size={46} step={0.01} entryScale={100}
              format={(v) => `${Math.round(v * 100)}`}
              onChange={(v) => setAirRestore(v)} />
          </div>
          <span className="spec stemhint">
            LANE TRIMS ±3 DB · BASS &lt;120 HZ · DRUMS = TRANSIENTS · VOCAL = CENTRE 250–3.5K ·
            AIR &gt;8 KHZ · RESTORE = NEW HARMONICS ABOVE {restoreFrom.toFixed(1)} KHZ
          </span>
        </div>}

        {advEqOpen && <AdvEqDrawer />}

        <div className="subrow">
        <div className="fadesbox">
          <div className="boxlabel">
            <span className="spec" style={{ color: 'var(--text-body)' }}>THIS TRACK</span>
            <span className="spec" title="These are fixes to this track's own faults: a new track starts without them, and A/B slots and presets never carry them">TRIM · FADES · IMAGE</span>
          </div>
          <div className="fade-row trimrow">
            <span className="spec">TRIM</span>
            <span className="val" title="Top and tail: what the export keeps · drag the handles at the ends of the waveform">
              {trimmed ? `${clock(trimStartSec)} → ${clock(trimEndSec > 0 ? trimEndSec : durationSec)}` : 'FULL LENGTH'}
            </span>
            <button className="btn btn-sm btn-ghost" disabled={!trimmed} onClick={clearTrim}
              title="Keep the whole file again">CLEAR</button>
          </div>
          <div className="fade-row">
            <span className="spec">FADE IN</span>
            <FadeStepper which="in" sec={fadeInSec} onSet={(v) => setFade('in', v)} />
            <div className="seg">
              {CURVES.map((c) => (
                <button key={c.id} className={fadeInCurve === c.id ? 'on' : ''} aria-pressed={fadeInCurve === c.id}
                  onClick={() => setFadeCurve('in', c.id)}>{c.label}</button>
              ))}
            </div>
          </div>
          <div className="fade-row">
            <span className="spec">FADE OUT</span>
            <FadeStepper which="out" sec={fadeOutSec} onSet={(v) => setFade('out', v)} />
            <div className="seg">
              {CURVES.map((c) => (
                <button key={c.id} className={fadeOutCurve === c.id ? 'on' : ''} aria-pressed={fadeOutCurve === c.id}
                  onClick={() => setFadeCurve('out', c.id)}>{c.label}</button>
              ))}
            </div>
          </div>
          <div className="fade-row">
            <span className="spec">BALANCE</span>
            <div className="stepper" role="group" aria-label="Balance">
              <button onClick={() => setBalance(balanceDb - 0.1)} aria-label="Shift left">−</button>
              <span className="val">{balanceDb === 0 ? 'CENTRE' : `${balanceDb < 0 ? 'L' : 'R'} ${Math.abs(balanceDb).toFixed(1)}`}</span>
              <button onClick={() => setBalance(balanceDb + 0.1)} aria-label="Shift right">+</button>
            </div>
            <button
              className="btn btn-sm btn-ghost"
              disabled={!loaded || Math.abs(balanceOffset) < 0.05}
              title={Math.abs(balanceOffset) < 0.05
                ? 'The source image sits in the centre'
                : `The source image leans ${balanceOffset >= 0 ? 'right' : 'left'} by ${Math.abs(balanceOffset).toFixed(1)} dB · correct it`}
              onClick={autoCenter}
            >
              AUTO-CENTRE
            </button>
          </div>
        </div>
        <OutputBox />
        </div>
      </div>
    </div>
  );
}

/** m:ss.s */
function clock(sec: number): string {
  const t = Math.round(sec * 10) / 10;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
}

function FadeStepper({ which, sec, onSet }: { which: 'in' | 'out'; sec: number; onSet: (v: number) => void }) {
  return (
    <div className="stepper" role="group" aria-label={`Fade ${which} seconds`}>
      <button onClick={() => onSet(Math.max(0, +(sec - 0.5).toFixed(1)))} aria-label="Decrease">−</button>
      <span className="val">{sec > 0 && sec < 0.1 ? `${Math.round(sec * 1000)}ms` : `${sec.toFixed(1)}s`}</span>
      <button onClick={() => onSet(+(sec + 0.5).toFixed(1))} aria-label="Increase">+</button>
    </div>
  );
}
