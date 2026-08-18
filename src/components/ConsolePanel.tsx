import { useStore } from '../state/store';
import { Knob } from './Knob';
import { OutputBox } from './OutputBox';
import { AdvEqDrawer } from './AdvEqDrawer';
import { FadeCurve } from '../audio/dsp/params';

const pct = (v: number) => `${Math.round(v * 100)}`;
const signedPct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;

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
  const advEqActive = useStore((s) => s.advEq.some((b) => b.on && Math.abs(b.gainDb) >= 0.05));
  const matchActive = useStore((s) => s.matchEqGains.length > 0);
  const stems = useStore((s) => s.stems);
  const setStem = useStore((s) => s.setStem);

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="title">Console</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="seg" style={{ height: 20 }}>
            <button disabled={undoDepth === 0} title="Undo (Ctrl+Z)" onClick={undo}>⟲</button>
            <button disabled={redoDepth === 0} title="Redo (Ctrl+Y)" onClick={redo}>⟳</button>
          </span>
          <span className="seg" style={{ height: 20 }}>
            <button className={advEqOpen || advEqActive ? 'on' : ''}
              title="Advanced 6-band parametric EQ"
              onClick={() => setAdvEqOpen(!advEqOpen)}>EQ</button>
          </span>
          {matchActive && <span className="spec" style={{ color: 'var(--text-accent)' }}>MATCHED</span>}
          <span className="seg" style={{ height: 20 }}>
            <button
              className={activeSlot === 'A' ? 'on' : ''}
              title="Console snapshot A"
              onClick={() => switchSlot('A')}
            >A</button>
            <button
              className={activeSlot === 'B' ? 'on' : ''}
              title={hasB ? 'Console snapshot B' : 'Console snapshot B (starts as a copy of A)'}
              onClick={() => switchSlot('B')}
            >B</button>
          </span>
          <span className="spec">Macro processors</span>
        </span>
      </div>
      <div className="console-body">
        <div className="knobrow">
          <div className="knobcell">
            <Knob label="Tone" value={macros.tone} min={-1} max={1} defaultValue={0} bipolarFrom={0}
              format={signedPct} onChange={(v) => setMacro('tone', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>WARM ◂ ▸ BRIGHT</span>
          </div>
          <div className="knobcell">
            <Knob label="Shape" value={macros.shape} min={-1} max={1} defaultValue={0} bipolarFrom={0}
              format={signedPct} onChange={(v) => setMacro('shape', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>SCOOP ◂ ▸ FORWARD</span>
          </div>
          <div className="knobcell">
            <Knob label="Air" value={macros.air} min={0} max={1} defaultValue={0}
              format={pct} onChange={(v) => setMacro('air', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>13 KHZ SHELF</span>
          </div>
          <div className="knobcell">
            <Knob label="Smooth" value={macros.smooth} min={0} max={1} defaultValue={0}
              format={pct} onChange={(v) => setMacro('smooth', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>DE-HARSH HF</span>
          </div>
          <div className="knobcell">
            <Knob label="Character" value={macros.character} min={0} max={1} defaultValue={0}
              format={pct} onChange={(v) => setMacro('character', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>HARMONIC DRIVE</span>
          </div>
          <div className="knobcell">
            <Knob label="Density" value={macros.density} min={0} max={1} defaultValue={0}
              format={pct} onChange={(v) => setMacro('density', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>GLUE COMP</span>
          </div>
          <div className="knobcell">
            <Knob label="Impact" value={macros.impact} min={-1} max={1} defaultValue={0} bipolarFrom={0}
              format={signedPct} onChange={(v) => setMacro('impact', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>SOFT ◂ ▸ PUNCH</span>
          </div>
          <div className="knobcell">
            <Knob label="Width" value={macros.width} min={0} max={2} defaultValue={1} bipolarFrom={1}
              format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setMacro('width', v)} />
            <span className="spec" style={{ fontSize: 8.5 }}>TILTED · BASS SAFE</span>
          </div>
        </div>

        <div className="stemrow">
          <span className="spec stemlabel">STEM<br />LANES</span>
          {(['bass', 'drums', 'vocal', 'air'] as const).map((lane) => (
            <div className="knobcell" key={lane}>
              <Knob label={lane} value={stems[lane]} min={-3} max={3} defaultValue={0} bipolarFrom={0}
                size={46}
                format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`}
                onChange={(v) => setStem(lane, +v.toFixed(1))} />
            </div>
          ))}
          <span className="spec stemhint">
            COMPONENT TRIMS ±3 DB · BASS &lt;120 HZ · DRUMS = TRANSIENTS ·
            VOCAL = CENTRE 250–3.5K · AIR &gt;8 KHZ
          </span>
        </div>

        {advEqOpen && <AdvEqDrawer />}

        <div className="subrow">
        <div className="fadesbox">
          <div className="boxlabel">
            <span className="spec" style={{ color: 'var(--text-body)' }}>FADES</span>
            <span className="spec">DRAG HANDLES ON WAVEFORM</span>
          </div>
          <div className="fade-row">
            <span className="spec">IN</span>
            <FadeStepper which="in" sec={fadeInSec} onSet={(v) => setFade('in', v)} />
            <div className="seg">
              {CURVES.map((c) => (
                <button key={c.id} className={fadeInCurve === c.id ? 'on' : ''}
                  onClick={() => setFadeCurve('in', c.id)}>{c.label}</button>
              ))}
            </div>
          </div>
          <div className="fade-row">
            <span className="spec">OUT</span>
            <FadeStepper which="out" sec={fadeOutSec} onSet={(v) => setFade('out', v)} />
            <div className="seg">
              {CURVES.map((c) => (
                <button key={c.id} className={fadeOutCurve === c.id ? 'on' : ''}
                  onClick={() => setFadeCurve('out', c.id)}>{c.label}</button>
              ))}
            </div>
          </div>
        </div>
        <OutputBox />
        </div>
      </div>
    </div>
  );
}

function FadeStepper({ which, sec, onSet }: { which: 'in' | 'out'; sec: number; onSet: (v: number) => void }) {
  return (
    <div className="stepper" aria-label={`Fade ${which} seconds`}>
      <button onClick={() => onSet(Math.max(0, +(sec - 0.5).toFixed(1)))} aria-label="Decrease">−</button>
      <span className="val">{sec.toFixed(1)}s</span>
      <button onClick={() => onSet(+(sec + 0.5).toFixed(1))} aria-label="Increase">+</button>
    </div>
  );
}
