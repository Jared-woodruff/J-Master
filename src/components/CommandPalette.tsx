// Every action on the console, by name. Ctrl+K opens it; type a few
// letters of what you want, Enter runs it. It is also the map of the app:
// each row shows the key that does the same thing.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { PRESETS, PLATFORMS } from '../audio/dsp/params';
import { pickAndLoadFile } from '../lib/filepick';
import { useSheetFocus } from '../lib/use-sheet-focus';

type State = ReturnType<typeof useStore.getState>;

interface Command {
  group: string;
  label: string;
  keys?: string;
  /** Left out: always there. */
  when?: (s: State) => boolean;
  /** Shown as lit: the thing is on. */
  on?: (s: State) => boolean;
  run: (s: State) => void;
}

const loaded = (s: State) => s.loaded;

function commands(s: State): Command[] {
  const list: Command[] = [
    { group: 'FILE', label: 'Open a track or project…', keys: 'Ctrl+O', run: () => void pickAndLoadFile() },
    { group: 'FILE', label: 'Save project…', keys: 'Ctrl+S', run: (st) => void st.saveProject() },
    { group: 'FILE', label: 'Export master…', keys: 'E', when: loaded, run: (st) => st.openExport(true) },
    { group: 'FILE', label: 'Batch master…', keys: 'B', run: (st) => st.openBatch(true) },
    { group: 'FILE', label: 'Album / CD image…', when: (st) => st.batchItems.length > 0, run: (st) => st.openAlbum(true) },
    { group: 'FILE', label: 'Report of the last export', when: (st) => st.lastExport !== null, run: (st) => void st.saveReport() },

    { group: 'TRANSPORT', label: 'Play / pause', keys: 'Space', when: loaded, run: (st) => st.togglePlay() },
    { group: 'TRANSPORT', label: 'Stop', when: loaded, run: (st) => st.stop() },
    { group: 'TRANSPORT', label: 'Return to start', keys: 'Home', when: loaded, run: (st) => st.seekSec(st.trimStartSec) },
    { group: 'TRANSPORT', label: 'Loop the section under the playhead', keys: 'L', when: loaded, on: (st) => st.loopStartSec !== null, run: (st) => st.toggleLoop() },

    { group: 'LISTEN', label: 'Reference: the untouched source', keys: 'R', when: loaded, on: (st) => st.bypass, run: (st) => st.setBypass(!st.bypass) },
    { group: 'LISTEN', label: 'Limiter delta: only what the limiter removes', when: (st) => st.loaded && !st.bypass, on: (st) => st.limiterDelta, run: (st) => st.setLimiterDelta(!st.limiterDelta) },
    { group: 'LISTEN', label: 'Click on the beat', when: (st) => !!st.tempo && st.tempo.bpm > 0, on: (st) => st.metronome, run: (st) => st.setMetronome(!st.metronome) },
    { group: 'LISTEN', label: 'Monitor: stereo', when: loaded, on: (st) => st.monitor === 'stereo', run: (st) => st.setMonitor('stereo') },
    { group: 'LISTEN', label: 'Monitor: mono fold-down', keys: 'M', when: loaded, on: (st) => st.monitor === 'mono', run: (st) => st.setMonitor('mono') },
    { group: 'LISTEN', label: 'Monitor: side only', when: loaded, on: (st) => st.monitor === 'side', run: (st) => st.setMonitor('side') },
    { group: 'LISTEN', label: 'Monitor: left only', when: loaded, on: (st) => st.monitor === 'left', run: (st) => st.setMonitor('left') },
    { group: 'LISTEN', label: 'Monitor: right only', when: loaded, on: (st) => st.monitor === 'right', run: (st) => st.setMonitor('right') },
    { group: 'LISTEN', label: 'Play as mastered (no normalization)', when: loaded, on: (st) => st.normPreview === null, run: (st) => st.setNormPreview(null) },

    { group: 'ANALYSE', label: 'Source check sheet (DIAG)', keys: 'D', when: loaded, run: (st) => st.openDiag(true) },
    { group: 'ANALYSE', label: 'Auto-master this track', when: (st) => st.loaded && !st.masterItBusy, run: (st) => void st.masterIt() },
    { group: 'ANALYSE', label: 'Match to a reference track…', when: loaded, run: (st) => st.openMatch(true) },
    { group: 'ANALYSE', label: 'Repair tempo drift…', when: (st) => !!st.tempo?.drift || !!st.driftRepair, run: (st) => st.openRepair(true) },
    { group: 'ANALYSE', label: 'Read the tempo at half time', when: (st) => !!st.tempo && st.tempo.bpm / 2 >= 40 && !st.repairing, run: (st) => st.rescaleTempo(0.5) },
    { group: 'ANALYSE', label: 'Read the tempo at double time', when: (st) => !!st.tempo && st.tempo.bpm > 0 && st.tempo.bpm * 2 <= 300 && !st.repairing, run: (st) => st.rescaleTempo(2) },

    { group: 'CONSOLE', label: 'Undo', keys: 'Ctrl+Z', when: (st) => st.undoDepth > 0, run: (st) => st.undo() },
    { group: 'CONSOLE', label: 'Redo', keys: 'Ctrl+Y', when: (st) => st.redoDepth > 0, run: (st) => st.redo() },
    { group: 'CONSOLE', label: `Switch to console ${s.activeSlot === 'A' ? 'B' : 'A'}`, keys: 'A', run: (st) => st.switchSlot(st.activeSlot === 'A' ? 'B' : 'A') },
    { group: 'CONSOLE', label: `Copy this console to ${s.activeSlot === 'A' ? 'B' : 'A'}`, run: (st) => st.copyToOtherSlot() },
    { group: 'CONSOLE', label: 'Back to the preset as saved', when: (st) => !!st.lastPresetId, run: (st) => st.revertPreset() },
    { group: 'CONSOLE', label: 'Preset amount: 100%', when: (st) => st.presetAmount !== 1, run: (st) => st.setPresetAmount(1) },
    { group: 'CONSOLE', label: 'Advanced EQ drawer', on: (st) => st.advEqOpen, run: (st) => st.setAdvEqOpen(!st.advEqOpen) },
    { group: 'CONSOLE', label: 'Flatten the advanced EQ', run: (st) => st.resetAdvEq() },
    { group: 'CONSOLE', label: 'Lanes drawer (stem trims, air restore)', on: (st) => st.stemsOpen, run: (st) => st.setStemsOpen(!st.stemsOpen) },
    { group: 'CONSOLE', label: 'Clip: out', on: (st) => st.clipMode === 'off', run: (st) => st.setClipMode('off') },
    { group: 'CONSOLE', label: 'Clip: soft', on: (st) => st.clipMode === 'soft', run: (st) => st.setClipMode('soft') },
    { group: 'CONSOLE', label: 'Clip: hard', on: (st) => st.clipMode === 'hard', run: (st) => st.setClipMode('hard') },
    { group: 'CONSOLE', label: 'Trim start at the playhead', keys: '[', when: loaded, run: (st) => st.setTrim('start', st.playheadSec) },
    { group: 'CONSOLE', label: 'Trim end at the playhead', keys: ']', when: loaded, run: (st) => st.setTrim('end', st.playheadSec) },
    { group: 'CONSOLE', label: 'Keep the full length (clear the trim)', when: (st) => st.trimStartSec > 0 || st.trimEndSec > 0, run: (st) => st.clearTrim() },
    { group: 'CONSOLE', label: 'Take the match EQ off', when: (st) => st.matchEqGains.length > 0, run: (st) => st.clearMatch() },
    { group: 'CONSOLE', label: 'Auto-center the stereo image', when: (st) => Math.abs(st.source?.balanceOffsetDb ?? 0) >= 0.05, run: (st) => st.autoCenter() },

    { group: 'VIEW', label: 'Waveform', when: loaded, on: (st) => st.waveView === 'wave', run: (st) => st.setWaveView('wave') },
    { group: 'VIEW', label: 'Spectrogram', when: loaded, on: (st) => st.waveView === 'spec', run: (st) => st.setWaveView('spec') },
    { group: 'VIEW', label: 'Show the master (OUT) on the waveform', when: loaded, on: (st) => st.processedView, run: (st) => st.setProcessedView(!st.processedView) },
    { group: 'VIEW', label: 'Source and master in split lanes', when: (st) => st.loaded && st.processedView, on: (st) => st.outSplit, run: (st) => st.setOutSplit(!st.outSplit) },
    { group: 'VIEW', label: 'Beat grid', keys: 'G', when: loaded, on: (st) => st.gridEnabled, run: (st) => st.setGridEnabled(!st.gridEnabled) },
    { group: 'VIEW', label: 'Loudness lane', when: loaded, on: (st) => st.loudnessLane, run: (st) => st.setLoudnessLane(!st.loudnessLane) },
    { group: 'VIEW', label: 'Tempo lane', when: loaded, on: (st) => st.tempoLane, run: (st) => st.setTempoLane(!st.tempoLane) },
    { group: 'VIEW', label: 'Follow the playhead', keys: 'F', when: loaded, on: (st) => st.followPlayhead, run: (st) => st.setFollowPlayhead(!st.followPlayhead) },
    { group: 'VIEW', label: 'Meters: spectrum', when: loaded, on: (st) => st.meterView === 'spectrum', run: (st) => st.setMeterView('spectrum') },
    { group: 'VIEW', label: 'Meters: scope', when: loaded, on: (st) => st.meterView === 'scope', run: (st) => st.setMeterView('scope') },
    { group: 'VIEW', label: 'Meters: loudness history', when: loaded, on: (st) => st.meterView === 'loudness', run: (st) => st.setMeterView('loudness') },
    { group: 'VIEW', label: 'Theme: plate (dark)', on: (st) => st.theme === 'plate', run: (st) => st.setTheme('plate') },
    { group: 'VIEW', label: 'Theme: paper (light)', on: (st) => st.theme === 'paper', run: (st) => st.setTheme('paper') },
    { group: 'VIEW', label: 'Keyboard shortcuts', keys: '?', run: (st) => st.openKeys(true) },
  ];
  for (const p of PLATFORMS) {
    list.push({
      group: 'TARGET', label: `${p.name} · ${p.spec}`,
      on: (st) => st.platformId === p.id, run: (st) => st.applyPlatform(p.id),
    });
    if (p.targetLufs < -9) {
      list.push({
        group: 'LISTEN', label: `Play as ${p.name} would (normalized)`, when: loaded,
        on: (st) => st.normPreview === p.id, run: (st) => st.setNormPreview(p.id),
      });
    }
  }
  for (const u of s.userPresets) {
    list.push({ group: 'PRESET', label: `${u.name} (yours)`, on: (st) => st.presetId === u.id, run: (st) => st.applyPreset(u.id) });
  }
  for (const p of PRESETS) {
    list.push({ group: 'PRESET', label: `${p.name} · ${p.spec}`, on: (st) => st.presetId === p.id, run: (st) => st.applyPreset(p.id) });
  }
  const bridge = (window as any).jmaster;
  if (bridge?.readFileByPath) {
    for (const r of s.recentFiles) {
      list.push({
        group: 'RECENT', label: r.name,
        run: (st) => { bridge.allowPath?.(r.path); void st.loadFile(bridge.readFileByPath(r.path), r.name, r.path); },
      });
    }
  }
  return list.filter((c) => !c.when || c.when(s));
}

/** Every word typed must be in the row; rows where they come early rank first. */
function score(c: Command, words: string[]): number {
  const hay = `${c.group} ${c.label}`.toLowerCase();
  const label = c.label.toLowerCase();
  let total = 0;
  for (const w of words) {
    const at = hay.indexOf(w);
    if (at < 0) return -1;
    const inLabel = label.indexOf(w);
    total += inLabel === 0 ? 0 : inLabel > 0 ? (/\W/.test(label[inLabel - 1]) ? 1 : 3) : 5;
  }
  return total;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const openPalette = useStore((s) => s.openPalette);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const sheetRef = useSheetFocus<HTMLDivElement>(open);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setAt(0);
    // After the sheet takes the focus, the field takes it from the sheet.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // The list is made when the palette opens and as you type, not on every
  // meter frame: what is "on" is read fresh when a row is drawn.
  const state = useStore.getState();
  const all = useMemo(() => (open ? commands(useStore.getState()) : []), [open, query]);
  const rows = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return all;
    return all
      .map((c, i) => ({ c, s: score(c, words), i }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .map((x) => x.c);
  }, [all, query]);

  useEffect(() => {
    listRef.current?.querySelector('.cmdrow.at')?.scrollIntoView({ block: 'nearest' });
  }, [at, rows]);

  if (!open) return null;

  const run = (c: Command | undefined) => {
    if (!c) return;
    openPalette(false);
    c.run(useStore.getState());
  };
  const cur = Math.min(at, Math.max(0, rows.length - 1));

  return (
    <div className="scrim palette-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) openPalette(false); }}>
      <div className="dialog frame palette" role="dialog" aria-modal="true" tabIndex={-1} ref={sheetRef} aria-label="Commands">
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>
        <input
          ref={inputRef}
          type="text"
          className="cmdinput"
          value={query}
          placeholder="TYPE WHAT YOU WANT TO DO…"
          spellCheck={false}
          role="combobox"
          aria-expanded="true"
          aria-controls="cmdlist"
          aria-activedescendant={rows[cur] ? `cmd-${cur}` : undefined}
          aria-label="Search commands"
          onChange={(e) => { setQuery(e.target.value); setAt(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setAt(Math.min(rows.length - 1, cur + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(Math.max(0, cur - 1)); }
            else if (e.key === 'PageDown') { e.preventDefault(); setAt(Math.min(rows.length - 1, cur + 8)); }
            else if (e.key === 'PageUp') { e.preventDefault(); setAt(Math.max(0, cur - 8)); }
            else if (e.key === 'Enter') { e.preventDefault(); run(rows[cur]); }
          }}
        />
        <div className="cmdlist" id="cmdlist" role="listbox" ref={listRef} aria-label="Commands">
          {rows.length === 0 && <div className="spec" style={{ padding: '14px 12px' }}>NOTHING BY THAT NAME.</div>}
          {rows.map((c, i) => {
            const lit = c.on?.(state) ?? false;
            return (
              <div
                key={`${c.group}:${c.label}`}
                id={`cmd-${i}`}
                role="option"
                aria-selected={i === cur}
                className={`cmdrow ${i === cur ? 'at' : ''}`}
                onPointerMove={() => { if (i !== cur) setAt(i); }}
                onClick={() => run(c)}
              >
                <span className="spec cmdgroup">{c.group}</span>
                <span className="cmdlabel">{c.label}</span>
                {lit && <span className="spec cmdon"><span className="lamp signal" /> ON</span>}
                {c.keys && <kbd>{c.keys}</kbd>}
              </div>
            );
          })}
        </div>
        <div className="cmdfoot spec">
          <span>↑ ↓ MOVE</span><span>ENTER RUN</span><span>ESC CLOSE</span>
          <span className="grow" />
          <span>{rows.length} OF {all.length}</span>
        </div>
      </div>
    </div>
  );
}
