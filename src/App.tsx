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
import { MatchDialog } from './components/MatchDialog';
import { MasterItReport } from './components/MasterItReport';
import { AlbumDialog } from './components/AlbumDialog';
import { Toasts } from './components/Toasts';
import { EmptyState } from './components/EmptyState';
import { loadDroppedFile } from './lib/filepick';

export function App() {
  const loaded = useStore((s) => s.loaded);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);

  // Space = play/pause, Home = start, ←/→ = seek 5 s (Shift = 30 s),
  // R = reference, A = A/B slot, E = export,
  // Ctrl+S/O = save/open project, Ctrl+Z/Y = undo/redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 's') { e.preventDefault(); void s.saveProject(); return; }
        if (k === 'o') { e.preventDefault(); void import('./lib/filepick').then((m) => m.pickAndLoadFile()); return; }
        if (k === 'z' && e.shiftKey) { e.preventDefault(); s.redo(); return; }
        if (k === 'z') { e.preventDefault(); s.undo(); return; }
        if (k === 'y') { e.preventDefault(); s.redo(); return; }
      }
      const el = e.target as HTMLElement;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      // Focused knobs own the arrow keys.
      const knobFocused = el?.getAttribute?.('role') === 'slider';
      if (e.code === 'Space') {
        e.preventDefault();
        s.togglePlay();
      } else if (e.code === 'Home') {
        s.seekSec(0);
      } else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && !knobFocused) {
        if (!s.loaded) return;
        e.preventDefault();
        const step = (e.shiftKey ? 30 : 5) * (e.code === 'ArrowLeft' ? -1 : 1);
        const d = s.source?.durationSec ?? 0;
        s.seekSec(Math.max(0, Math.min(d, s.playheadSec + step)));
      } else if (e.key === 'r' || e.key === 'R') {
        if (s.loaded) s.setBypass(!s.bypass);
      } else if (e.key === 'a' || e.key === 'A') {
        if (s.loaded) s.switchSlot(s.activeSlot === 'A' ? 'B' : 'A');
      } else if (e.key === 'e' || e.key === 'E') {
        if (s.loaded) s.openExport(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Double-clicked .jmaster files arrive from the main process.
  useEffect(() => {
    const bridge = (window as any).jmaster;
    if (!bridge?.onOpenPath || !bridge?.readFileByPath) return;
    bridge.onOpenPath(async (path: string) => {
      const data: ArrayBuffer = await bridge.readFileByPath(path);
      const name = path.split(/[\\/]/).pop() ?? 'project.jmaster';
      await useStore.getState().loadFile(data, name, path);
    });
  }, []);

  // Whole-window drop target once loaded (swap tracks fast).
  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      // When the batch dialog is open it owns the drop target.
      if (useStore.getState().batchOpen) return;
      const f = e.dataTransfer?.files?.[0];
      if (f) void loadDroppedFile(f);
    };
    const onDrag = (e: DragEvent) => e.preventDefault();
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragover', onDrag);
    return () => {
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', onDrag);
    };
  }, []);

  return (
    <div className="app">
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
        <span className="spec" style={{ opacity: 0.6 }}>MUSIC, MANUFACTURED.</span>
        <span className="grow" />
        <span className="spec">ENGINE 48K / 32-BIT FLOAT</span>
        <div className="theme-switch" role="group" aria-label="Theme">
          <button className={theme === 'plate' ? 'on' : ''} onClick={() => setTheme('plate')}>PLATE</button>
          <button className={theme === 'paper' ? 'on' : ''} onClick={() => setTheme('paper')}>PAPER</button>
        </div>
      </footer>
      <ExportDialog />
      <BatchDialog />
      <DiagDialog />
      <MatchDialog />
      <MasterItReport />
      <AlbumDialog />
      <Toasts />
    </div>
  );
}
