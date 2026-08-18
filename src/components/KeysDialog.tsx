// Keyboard cheat sheet, opened with ? or the KEYS button in the status bar.
import { useStore } from '../state/store';

const ROWS: [string, string][] = [
  ['PLAY / PAUSE', 'SPACE'],
  ['RETURN TO START', 'HOME'],
  ['SEEK 5 S / 30 S', '← → / SHIFT ← →'],
  ['LOOP SECTION', 'L · DOUBLE-CLICK WAVE'],
  ['REFERENCE (UNTOUCHED SOURCE)', 'R'],
  ['A/B SNAPSHOT SLOT', 'A'],
  ['EXPORT', 'E'],
  ['SAVE / OPEN PROJECT', 'CTRL+S / CTRL+O'],
  ['UNDO / REDO', 'CTRL+Z / CTRL+Y'],
  ['FINE KNOB DRAG', 'SHIFT+DRAG'],
  ['RESET KNOB', 'DOUBLE-CLICK · HOME'],
  ['ZOOM / PAN WAVE', 'WHEEL / SHIFT+WHEEL'],
];

export function KeysDialog() {
  const open = useStore((s) => s.keysOpen);
  const openKeys = useStore((s) => s.openKeys);

  if (!open) return null;

  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) openKeys(false); }}>
      <div className="dialog frame" role="dialog" aria-label="Keyboard shortcuts" style={{ width: 420 }}>
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>

        <div>
          <div className="display dtitle">Keys</div>
          <div className="spec" style={{ marginTop: 4 }}>EVERY SHORTCUT ON THE CONSOLE</div>
        </div>

        <div className="statgrid">
          {ROWS.map(([label, keys]) => (
            <div className="row" key={label}>
              <span className="spec">{label}</span>
              <span className="leader" />
              <span className="spec-value" style={{ fontSize: 11 }}>{keys}</span>
            </div>
          ))}
        </div>

        <div className="drow" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={() => openKeys(false)}>DONE</button>
        </div>
      </div>
    </div>
  );
}
