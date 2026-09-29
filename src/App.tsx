import { useEffect } from 'react';
import { useStore } from './state/store';
import { TitleBar } from './components/TitleBar';
import { TrackStrip } from './components/TrackStrip';
import { Waveform } from './components/Waveform';
import { ConsolePanel } from './components/ConsolePanel';
import { PresetRack } from './components/PresetRack';
import { MetersPanel } from './components/MetersPanel';
import { ExportDialog } from './components/ExportDialog';
import { BatchDialog } from './components/BatchDialog';
import { DiagDialog } from './components/DiagDialog';
import { RepairDialog } from './components/RepairDialog';
import { MatchDialog } from './components/MatchDialog';
import { MasterItReport } from './components/MasterItReport';
import { AlbumDialog } from './components/AlbumDialog';
import { Toasts } from './components/Toasts';
import { EmptyState } from './components/EmptyState';
import { KeysDialog } from './components/KeysDialog';
import { FileDrop } from './components/FileDrop';
import { Tooltip } from './components/Tooltip';
import { pickAndLoadFile } from './lib/filepick';

type State = ReturnType<typeof useStore.getState>;

const anySheetOpen = (s: State) =>
  s.keysOpen || s.albumOpen || !!s.masterItReport || s.matchOpen || s.repairOpen || s.diagOpen || s.batchOpen || s.exportOpen;

/**
 * Esc closes the sheet on top (the last one rendered), with the same guard
 * as a click on its scrim: nothing closes mid-render. True if a sheet was
 * open, so the key is spent either way.
 */
function closeTopSheet(s: State): boolean {
  if (s.keysOpen) s.openKeys(false);
  else if (s.albumOpen) { if (s.albumAssembling === null) s.openAlbum(false); }
  else if (s.masterItReport) s.closeMasterItReport();
  else if (s.matchOpen) { if (!s.matchLoading) s.openMatch(false); }
  // A repair keeps stretching behind a closed sheet (CANCEL REPAIR stops it).
  else if (s.repairOpen) s.openRepair(false);
  else if (s.diagOpen) s.openDiag(false);
  else if (s.batchOpen) { if (!s.batchRunning) s.openBatch(false); }
  else if (s.exportOpen) { if (s.exporting === null) s.openExport(false); }
  else return false;
  return true;
}

export function App() {
  const loaded = useStore((s) => s.loaded);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);

  // Space = play/pause, Home = start, ←/→ = seek 5 s (Shift = 30 s),
  // L = loop section, R = reference, A = A/B slot, E = export, ? = keys,
  // Esc = close the open sheet, Ctrl+S/O = save/open project,
  // Ctrl+Z/Y = undo/redo.
  useEffect(() => {
    // R: tap toggles the reference; holding it makes the compare momentary.
    let rDownAt = 0;
    let rRevertTo: boolean | null = null;
    const onKeyUp = (e: KeyboardEvent) => {
      if ((e.key === 'r' || e.key === 'R') && rRevertTo !== null) {
        if (Date.now() - rDownAt > 350) useStore.getState().setBypass(rRevertTo);
        rRevertTo = null;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const el = e.target as HTMLElement;
      const tag = el?.tagName;
      const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || !!el?.isContentEditable;
      if (e.key === 'Escape' && !e.isComposing) {
        if (closeTopSheet(s)) e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 's') { e.preventDefault(); void s.saveProject(); return; }
        if (k === 'o') { e.preventDefault(); void pickAndLoadFile(); return; }
        // In a text field these are the field's own undo and redo.
        if (typing) return;
        if (k === 'z' && e.shiftKey) { e.preventDefault(); s.redo(); return; }
        if (k === 'z') { e.preventDefault(); s.undo(); return; }
        if (k === 'y') { e.preventDefault(); s.redo(); return; }
        // Every other shortcut is a bare key: Ctrl+A is not A.
        return;
      }
      if (e.altKey || typing) return;
      const sheet = anySheetOpen(s);
      if (e.code === 'Space') {
        // A button reached with Tab inside a sheet takes Space itself.
        if (sheet && tag === 'BUTTON' && el.closest('.dialog')) return;
        e.preventDefault();
        s.togglePlay();
        return;
      }
      if (e.key === '?') { s.openKeys(!s.keysOpen); return; }
      // Behind an open sheet the console keys rest.
      if (sheet) return;
      // Focused knobs own the arrow keys and Home.
      const knobFocused = el?.getAttribute?.('role') === 'slider';
      if (e.code === 'Home') {
        if (!knobFocused) s.seekSec(0);
      } else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && !knobFocused) {
        if (!s.loaded) return;
        e.preventDefault();
        const step = (e.shiftKey ? 30 : 5) * (e.code === 'ArrowLeft' ? -1 : 1);
        const d = s.source?.durationSec ?? 0;
        s.seekSec(Math.max(0, Math.min(d, s.playheadSec + step)));
      } else if (e.key === 'l' || e.key === 'L') {
        if (s.loaded) s.toggleLoop();
      } else if (e.key === 'r' || e.key === 'R') {
        if (s.loaded && !e.repeat) {
          rDownAt = Date.now();
          rRevertTo = s.bypass;
          s.setBypass(!s.bypass);
        }
      } else if (e.key === 'a' || e.key === 'A') {
        if (s.loaded) s.switchSlot(s.activeSlot === 'A' ? 'B' : 'A');
      } else if (e.key === 'e' || e.key === 'E') {
        if (s.loaded) s.openExport(true);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Double-clicked .jmaster files arrive from the main process.
  useEffect(() => {
    const bridge = (window as any).jmaster;
    if (!bridge?.onOpenPath || !bridge?.readFileByPath) return;
    return bridge.onOpenPath((path: string) => {
      const name = path.split(/[\\/]/).pop() ?? 'project.jmaster';
      void useStore.getState().loadFile(bridge.readFileByPath(path), name, path);
    });
  }, []);

  // While a sheet is up, the console behind it is out of reach: no Tab
  // stops, no clicks, nothing for a screen reader to wander into.
  const sheetOpen = useStore(anySheetOpen);

  return (
    <div className="app">
      <div className="shell" inert={sheetOpen}>
      <TitleBar />
      {loaded ? (
        <main className="workspace">
          <TrackStrip />
          <Waveform />
          <div className="deck">
            <PresetRack />
            <ConsolePanel />
            <MetersPanel />
          </div>
        </main>
      ) : (
        <EmptyState />
      )}
      <footer className="statusbar">
        <span className="spec">JMW SOFTWARE · JAMWARE RECORDS</span>
        <span className="spec hide-narrow" style={{ opacity: 0.6 }}>MUSIC, MANUFACTURED.</span>
        <span className="grow" />
        <span className="spec hide-narrow">ENGINE 48K / 32-BIT FLOAT</span>
        <div className="theme-switch">
          <button onClick={() => useStore.getState().openKeys(true)} title="Keyboard shortcuts · ?">KEYS</button>
        </div>
        <div className="theme-switch" role="group" aria-label="Theme">
          <button className={theme === 'plate' ? 'on' : ''} aria-pressed={theme === 'plate'} onClick={() => setTheme('plate')}>PLATE</button>
          <button className={theme === 'paper' ? 'on' : ''} aria-pressed={theme === 'paper'} onClick={() => setTheme('paper')}>PAPER</button>
        </div>
      </footer>
      </div>
      <ExportDialog />
      <BatchDialog />
      <DiagDialog />
      <RepairDialog />
      <MatchDialog />
      <MasterItReport />
      <AlbumDialog />
      <KeysDialog />
      <FileDrop />
      <Toasts />
      <Tooltip />
    </div>
  );
}
