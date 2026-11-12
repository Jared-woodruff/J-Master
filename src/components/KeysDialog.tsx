// Keyboard cheat sheet, opened with ? or the KEYS button in the status bar.
import { useStore } from '../state/store';
import { useSheetFocus } from '../lib/use-sheet-focus';

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'TRANSPORT',
    rows: [
      ['PLAY / PAUSE', 'SPACE'],
      ['RETURN TO START', 'HOME'],
      ['SEEK 5 S / 30 S', '← → / SHIFT ← →'],
      ['LOOP THE SECTION', 'L · DOUBLE-CLICK WAVE'],
      ['LOOP ANY STRETCH', 'SHIFT+DRAG ON THE WAVE'],
    ],
  },
  {
    title: 'LISTEN',
    rows: [
      ['REFERENCE (UNTOUCHED SOURCE)', 'R · HOLD = MOMENTARY'],
      ['A/B CONSOLE', 'A'],
      ['MONO FOLD-DOWN', 'M'],
    ],
  },
  {
    title: 'CONSOLE',
    rows: [
      ['EVERY ACTION, BY NAME', 'CTRL+K'],
      ['UNDO / REDO', 'CTRL+Z / CTRL+Y'],
      ['FINE KNOB DRAG', 'SHIFT+DRAG'],
      ['RESET A KNOB', 'DOUBLE-CLICK · HOME'],
      ['TYPE A KNOB VALUE', 'CLICK THE READOUT'],
      ['WALK THE PRESETS', '↑ ↓ IN THE RACK'],
      ['TRIM START / END AT THE PLAYHEAD', '[ / ]'],
    ],
  },
  {
    title: 'VIEW',
    rows: [
      ['ZOOM / PAN THE WAVE', 'WHEEL / SHIFT+WHEEL'],
      ['BEAT GRID', 'G'],
      ['FOLLOW THE PLAYHEAD', 'F'],
      ['SOURCE CHECK SHEET', 'D'],
    ],
  },
  {
    title: 'FILES',
    rows: [
      ['EXPORT', 'E'],
      ['BATCH', 'B'],
      ['SAVE / OPEN PROJECT', 'CTRL+S / CTRL+O'],
      ['LOAD A TRACK', 'DROP IT ANYWHERE'],
      ['QUEUE AN ALBUM', 'DROP SEVERAL TRACKS'],
      ['CLOSE THE OPEN SHEET', 'ESC'],
    ],
  },
];

export function KeysDialog() {
  const open = useStore((s) => s.keysOpen);
  const openKeys = useStore((s) => s.openKeys);

  const sheetRef = useSheetFocus<HTMLDivElement>(open);

  if (!open) return null;

  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) openKeys(false); }}>
      <div className="dialog frame" role="dialog" aria-modal="true" tabIndex={-1} ref={sheetRef} aria-label="Keyboard shortcuts" style={{ width: 460 }}>
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>

        <div>
          <div className="display dtitle">Keys</div>
          <div className="spec" style={{ marginTop: 4 }}>EVERY SHORTCUT ON THE CONSOLE</div>
        </div>

        {GROUPS.map((g) => (
          <div key={g.title}>
            <div className="boxlabel" style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: 8, marginBottom: 4 }}>
              <span className="spec" style={{ color: 'var(--text-body)' }}>{g.title}</span>
            </div>
            <div className="statgrid">
              {g.rows.map(([label, keys]) => (
                <div className="row" key={label}>
                  <span className="spec">{label}</span>
                  <span className="leader" />
                  <span className="spec-value" style={{ fontSize: 11 }}>{keys}</span>
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="drow" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={() => openKeys(false)}>DONE</button>
        </div>
      </div>
    </div>
  );
}
