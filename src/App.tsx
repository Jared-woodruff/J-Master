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
import { CommandPalette } from './components/CommandPalette';
import { FileDrop } from './components/FileDrop';
import { Tooltip } from './components/Tooltip';
import { pickAndLoadFile } from './lib/filepick';

type State = ReturnType<typeof useStore.getState>;

const anySheetOpen = (s: State) =>
  s.paletteOpen || s.keysOpen || s.albumOpen || !!s.masterItReport || s.matchOpen || s.repairOpen
  || s.diagOpen || s.batchOpen || s.exportOpen;

/** What a closing window would abandon, in the words the close guard uses. */
const busyLabel = (s: State): string | null =>
  s.exporting ? 'The export'
    : s.batchRunning ? 'The batch'
    : s.albumAssembling ? 'The CD image'
    : s.repairing ? 'The drift repair'
    : null;

/**
 * Esc closes the sheet on top (the last one rendered), with the same guard
 * as a click on its scrim: nothing closes mid-render. True if a sheet was
 * open, so the key is spent either way.
 */
function closeTopSheet(s: State): boolean {
  if (s.paletteOpen) s.openPalette(false);
  else if (s.keysOpen) s.openKeys(false);
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

  // The keys of the console (the KEYS sheet lists them all). A held key
  // repeats: toggles answer the first press only, or holding Space would
  // stutter the transport and holding A would flicker between consoles.
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
      const sheet = anySheetOpen(s);
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'k') {
          e.preventDefault();
          // Not over a render: the palette's commands would act under it.
          if (!e.repeat && (s.paletteOpen || !(s.exporting || s.batchRunning || s.albumAssembling))) s.openPalette(!s.paletteOpen);
          return;
        }
        if (k === 's') { e.preventDefault(); if (!e.repeat) void s.saveProject(); return; }
        if (k === 'o') {
          e.preventDefault();
          // Behind a sheet there is no console to open a track into.
          if (!sheet && !e.repeat) void pickAndLoadFile();
          return;
        }
        // In a text field these are the field's own undo and redo.
        if (typing) return;
        const undoKey = k === 'z' && !e.shiftKey;
        const redoKey = (k === 'z' && e.shiftKey) || k === 'y';
        if (undoKey || redoKey) {
          e.preventDefault();
          // The AUTO report is the one sheet that is about an undo.
          if (s.masterItReport && undoKey) { s.undoMasterIt(); return; }
          if (sheet) return;
          if (undoKey) s.undo(); else s.redo();
        }
        // Every other shortcut is a bare key: Ctrl+A is not A.
        return;
      }
      if (e.altKey || typing) return;
      if (e.code === 'Space') {
        // A button reached with Tab inside a sheet takes Space itself.
        if (sheet && tag === 'BUTTON' && el.closest('.dialog')) return;
        e.preventDefault();
        if (!e.repeat) s.togglePlay();
        return;
      }
      if (e.key === '?') { if (!e.repeat) s.openKeys(!s.keysOpen); return; }
      // Behind an open sheet the console keys rest.
      if (sheet) return;
      // Focused sliders (knobs, trim handles) own the arrow keys, Home and End.
      const sliderFocused = el?.getAttribute?.('role') === 'slider';
      if (e.code === 'Home') {
        if (!sliderFocused && s.loaded) { e.preventDefault(); s.seekSec(s.trimStartSec); }
        return;
      }
      if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && !sliderFocused) {
        if (!s.loaded) return;
        e.preventDefault();
        const step = (e.shiftKey ? 30 : 5) * (e.code === 'ArrowLeft' ? -1 : 1);
        const d = s.source?.durationSec ?? 0;
        s.seekSec(Math.max(0, Math.min(d, s.playheadSec + step)));
        return;
      }
      // One press, one action, for everything below.
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      if (key === 'b') { s.openBatch(true); return; }
      if (!s.loaded) return;
      switch (key) {
        case 'l': s.toggleLoop(); break;
        case 'r':
          rDownAt = Date.now();
          rRevertTo = s.bypass;
          s.setBypass(!s.bypass);
          break;
        case 'a': s.switchSlot(s.activeSlot === 'A' ? 'B' : 'A'); break;
        case 'e': s.openExport(true); break;
        case 'd': s.openDiag(true); break;
        case 'm': s.setMonitor(s.monitor === 'mono' ? 'stereo' : 'mono'); break;
        case 'g': s.setGridEnabled(!s.gridEnabled); break;
        case 'f': s.setFollowPlayhead(!s.followPlayhead); break;
        case '[': s.setTrim('start', s.playheadSec); break;
        case ']': s.setTrim('end', s.playheadSec); break;
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Files the app was opened with (a double-clicked project, a track dropped
  // on the shortcut) wait in the main process until the window takes them:
  // once now, and again whenever it says another has arrived.
  useEffect(() => {
    const bridge = (window as any).jmaster;
    if (!bridge?.takeOpenPath || !bridge?.readFileByPath) return;
    const take = async () => {
      const path: string | null = await bridge.takeOpenPath().catch(() => null);
      if (!path) return;
      const name = path.split(/[\\/]/).pop() ?? 'project.jmaster';
      void useStore.getState().loadFile(bridge.readFileByPath(path), name, path);
    };
    void take();
    return bridge.onOpenPath?.(() => void take());
  }, []);

  // The main process asks before closing a window that is mid-render: it
  // needs to know when that is.
  useEffect(() => {
    const bridge = (window as any).jmaster;
    if (!bridge?.setBusy) return;
    let last: string | null = null;
    const tell = (s: State) => {
      const now = busyLabel(s);
      if (now !== last) { last = now; bridge.setBusy(now); }
    };
    tell(useStore.getState());
    return useStore.subscribe(tell);
  }, []);

  // While a sheet is up, the console behind it is out of reach: no Tab
  // stops, no clicks, nothing for a screen reader to wander into. The
  // title bar stays live (the window still has to minimise and close).
  const sheetOpen = useStore(anySheetOpen);

  return (
    <div className="app">
      <TitleBar sheetOpen={sheetOpen} />
      <div className="shell" inert={sheetOpen}>
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
          <button onClick={() => useStore.getState().openPalette(true)} title="Every action, by name · Ctrl+K">COMMANDS</button>
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
      <CommandPalette />
      <FileDrop />
      <Toasts />
      <Tooltip />
    </div>
  );
}
