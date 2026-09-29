// The one owner of file drag-and-drop. A single set of window listeners
// routes every drop by context (batch queue, MATCH reference, cover art,
// or the console), so no drop can ever be handled twice. Two handlers
// once fired for the same drop and started two audio engines.
import { useEffect } from 'react';
import { useStore } from '../state/store';
import type { FileDragInfo } from '../state/store';
import { loadDroppedFile } from '../lib/filepick';
import { isImageFile, isLoadableFile } from '../lib/filepath';

type Route = 'console' | 'batch' | 'match' | 'cover' | 'blocked';
type State = ReturnType<typeof useStore.getState>;

/**
 * Where a drop would go, from the open dialogs alone. Read-only sheets
 * (diagnosis, keys, the AUTO report) don't block: a drop closes them and
 * loads, since DIAG opens by itself after most loads.
 */
function routeFor(s: State): Route {
  if (s.batchOpen) return 'batch';
  if (s.matchOpen) return 'match';
  if (s.exportOpen) return 'cover';
  if (s.albumOpen) return 'blocked';
  return 'console';
}
const routeNow = () => routeFor(useStore.getState());

function infoOf(dt: DataTransfer): FileDragInfo {
  const files = Array.from(dt.items).filter((i) => i.kind === 'file');
  return { count: files.length, images: files.filter((i) => i.type.startsWith('image/')).length };
}

function routeDrop(files: File[]): void {
  const s = useStore.getState();
  const audio = files.filter((f) => isLoadableFile(f) && !/\.jmaster$/i.test(f.name));
  const project = files.find((f) => /\.jmaster$/i.test(f.name));
  const image = files.find(isImageFile);

  switch (routeNow()) {
    case 'batch':
      // The batch dialog carries the cover tile too.
      if (audio.length > 0) s.addBatchDroppedFiles(audio);
      else if (image && !s.batchRunning) void s.setCoverFromFile(image);
      else s.pushToast('BATCH TAKES AUDIO FILES · WAV / FLAC / MP3 / OGG / M4A', 'info');
      return;
    case 'match':
      if (audio[0]) void s.loadReference(audio[0]);
      else s.pushToast('DROP AN AUDIO FILE TO USE AS THE REFERENCE', 'info');
      return;
    case 'cover':
      if (image) void s.setCoverFromFile(image);
      else s.pushToast('CLOSE EXPORT TO LOAD A NEW TRACK', 'info');
      return;
    case 'blocked':
      s.pushToast('CLOSE THE DIALOG TO LOAD A TRACK', 'info');
      return;
    case 'console':
      break;
  }

  const loadable = audio.length > 0 || !!project;
  if (loadable) {
    if (s.diagOpen) s.openDiag(false);
    if (s.keysOpen) s.openKeys(false);
    if (s.masterItReport) s.closeMasterItReport();
  }

  if (project && audio.length === 0) { void loadDroppedFile(project); return; }
  if (audio.length === 0) {
    s.pushToast(image
      ? 'THAT’S AN IMAGE · COVER ART GOES ON THE COVER TILE IN EXPORT (E)'
      : `CAN’T OPEN ${files[0]?.name.toUpperCase() ?? 'THAT'} · NOT AN AUDIO FILE`, 'fault');
    return;
  }
  if (audio.length === 1) { void loadDroppedFile(audio[0]); return; }
  // Several tracks: an album. They queue in BATCH; the first one opens in
  // the console if it's empty, so the sound can be dialled in first.
  if (!s.loaded) void loadDroppedFile(audio[0]);
  s.openBatch(true);
  s.addBatchDroppedFiles(audio);
  s.pushToast(`${audio.length} TRACKS QUEUED IN BATCH`, 'run');
}

export function FileDrop() {
  const drag = useStore((s) => s.fileDrag);
  const loaded = useStore((s) => s.loaded);
  const trackName = useStore((s) => s.source?.name ?? null);
  const route = useStore(routeFor);

  useEffect(() => {
    let depth = 0;
    let watchdog = 0;
    const st = () => useStore.getState();
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const clear = () => {
      depth = 0;
      window.clearTimeout(watchdog);
      st().setFileDrag(null);
    };
    // dragover repeats every ~50 ms while a drag hovers the window; if it
    // stops (drag cancelled outside, Esc), the overlay must not stick.
    const arm = () => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(clear, 600);
    };

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      st().setFileDrag(infoOf(e.dataTransfer!));
      arm();
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const info = infoOf(e.dataTransfer!);
      const route = routeNow();
      const accept =
        route === 'blocked' ? false
          : route === 'cover' ? info.images > 0
          : route === 'console' ? info.images < info.count || info.count === 0
          : true;
      e.dataTransfer!.dropEffect = accept ? 'copy' : 'none';
      st().setFileDrag(info);
      arm();
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) clear();
    };
    // Capture phase: the overlay clears before anything else sees the drop.
    const onDropCapture = (e: DragEvent) => { if (hasFiles(e)) clear(); };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) routeDrop(files);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDropCapture, true);
    window.addEventListener('drop', onDrop);
    return () => {
      window.clearTimeout(watchdog);
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDropCapture, true);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  // The empty state and the dialogs light up their own drop zones; the
  // veil is for the loaded console (over any read-only sheet) only.
  if (!drag || !loaded || route !== 'console') return null;

  const imagesOnly = drag.images > 0 && drag.images === drag.count;
  const many = drag.count - drag.images > 1;

  return (
    <div className="dropveil" aria-hidden="true">
      <div className={`dropcard frame ${imagesOnly ? 'reject' : ''}`}>
        <span className="xh tl">+</span><span className="xh tr">+</span>
        <span className="xh bl">+</span><span className="xh br">+</span>
        {imagesOnly ? (
          <>
            <div className="display headline">That’s an image<span className="accentdot">.</span></div>
            <div className="spec">COVER ART GOES ON THE COVER TILE IN EXPORT · PRESS E</div>
          </>
        ) : many ? (
          <>
            <div className="display headline">Drop {drag.count - drag.images} tracks<span className="accentdot">.</span></div>
            <div className="spec">QUEUED IN BATCH · MASTERED WITH THIS CONSOLE</div>
          </>
        ) : (
          <>
            <div className="display headline">Drop to load<span className="accentdot">.</span></div>
            <div className="spec">REPLACES {trackName ? trackName.toUpperCase() : 'THE TRACK'} · YOUR CONSOLE SETTINGS CARRY OVER</div>
          </>
        )}
        <div className="spec" style={{ opacity: 0.6 }}>WAV · FLAC · MP3 · OGG · M4A · .JMASTER PROJECTS</div>
      </div>
    </div>
  );
}
