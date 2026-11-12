import { Logo } from './Logo';
import { useStore } from '../state/store';
import { pickAndLoadFile } from '../lib/filepick';

const bridge = (window as any).jmaster;

/**
 * The title bar stays live while a sheet is open: the window still has to
 * minimise and close. Only its session menu goes out of reach with the
 * console behind the sheet.
 */
export function TitleBar({ sheetOpen = false }: { sheetOpen?: boolean }) {
  const loaded = useStore((s) => s.loaded);

  return (
    <header className="titlebar">
      <Logo size={20} />
      <div className="wordmark">
        <span className="display" style={{ fontSize: 15 }}>J-Master</span>
        <span className="spec sub">Mastering Console</span>
      </div>
      {/* Session-level actions live up here, track-level ones in the strip. */}
      <nav className="titlemenu" aria-label="Session" inert={sheetOpen}>
        {loaded && (
          <>
            <button onClick={() => void pickAndLoadFile()}
              title="Open audio or a .jmaster project · Ctrl+O · or drop a file anywhere">OPEN</button>
            <button onClick={() => void useStore.getState().saveProject()}
              title="Save the session: console, A/B slots, metadata, cover, batch queue · Ctrl+S">SAVE</button>
            <button onClick={() => useStore.getState().openBatch(true)}
              title="Master a whole album with this console · B">BATCH</button>
          </>
        )}
        <button className="cmd" onClick={() => useStore.getState().openPalette(true)}
          title="Every action, by name · Ctrl+K">
          COMMANDS <kbd>CTRL K</kbd>
        </button>
      </nav>
      <div className="titlebar-spacer" />
      <span className="spec rev">JMW Software · Rev {__APP_VERSION__.split('.').slice(0, 2).join('.')}</span>
      {/* Out of the tab order: Chromium gives initial focus to the first
          tabbable element when the window shows, and that was Minimize
          (a focus ring at startup, and Enter would minimize). The OS
          keeps its own shortcuts for these. */}
      {bridge?.windowControl && (
        <nav className="winbtns" aria-label="Window controls">
          <button className="winbtn" tabIndex={-1} onClick={() => bridge.windowControl('minimize')} aria-label="Minimize">─</button>
          <button className="winbtn" tabIndex={-1} onClick={() => bridge.windowControl('maximize')} aria-label="Maximize">□</button>
          <button className="winbtn close" tabIndex={-1} onClick={() => bridge.windowControl('close')} aria-label="Close">×</button>
        </nav>
      )}
    </header>
  );
}
