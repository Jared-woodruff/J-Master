// Captures the README screenshots from the built app, playing the demo
// track (scripts/make-demo-song.mjs), with the same driver as the GIFs
// (scripts/lib/drive-app.mjs): production build, throwaway profile, muted.
//
// Prereq: `npm run build`.
// Usage:  node scripts/capture-screens.mjs [shot ...]
//         shots: 01-console 02-spectrogram 03-adv-eq 05-paper 07-palette
//         08-trim-loop 09-export 10-report 06-drop 04-diagnosis (default:
//         all; the others still run, unsaved, since each scene sets up the
//         next). 10-report needs Microsoft Edge (it renders the saved page).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchApp, settle, sleep, waitForAnalysis } from './lib/drive-app.mjs';

const OUT = 'docs/screenshots';
mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'jmaster-screens-'));
const song = join(work, 'midnight-static.wav');
execFileSync(process.execPath, ['scripts/make-demo-song.mjs', song], { stdio: 'inherit' });
const wanted = new Set(process.argv.slice(2));

const app = await launchApp({ width: 1440, height: 900 });
const shoot = async (name, { cursor = false } = {}) => {
  if (wanted.size > 0 && !wanted.has(name)) return;
  if (!cursor) await app.hideCursor();
  await sleep(450);
  writeFileSync(join(OUT, `${name}.png`), await app.screenshot());
  console.log(`captured ${name}`);
};
const ctrl = async (key) => {
  const ev = { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers: 2 };
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ev });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
};
const waitPreview = () => app.eval(`(async () => { const eng = window.__jmaster.engine;
  for (let i = 0; i < 300; i++) { if (eng.processedPreview && !eng.previewPending) return; await new Promise(r => setTimeout(r, 100)); } })()`);

try {
  const dz = await app.box('.dropzone');
  await app.dropFiles([song], dz.x, dz.y, { ms: 150 });
  await waitForAnalysis(app);

  // The console, playing, with SPLIT compare: source above, master below.
  await app.store(`(st().applyPreset('synthwave'), st().setProcessedView(true), st().setOutSplit(true), 1)`);
  await waitPreview();
  await settle(app);
  await app.store(`(st().seekSec(55.2), st().togglePlay(), 1)`);
  await sleep(2600);
  await shoot('01-console');

  // Spectrogram, zoomed in around the first drop.
  await app.store(`(st().togglePlay(), st().setOutSplit(false), st().setProcessedView(false), st().setWaveView('spec'), st().seekSec(17.2), 1)`);
  await app.eval(`(async () => { for (let i = 0; i < 100 && !window.__jmaster.engine.spectrogram; i++) await new Promise(r => setTimeout(r, 100)); })()`);
  const canvas = await app.box('.waveframe canvas');
  await app.wheel(canvas.left + canvas.width * 0.22, canvas.y, -100, 3);
  await settle(app);
  await shoot('02-spectrogram');
  // Back to the whole track for the scenes that follow.
  await app.clickOn('FIT', '.wave-controls', { ms: 200 });
  // Off the button, or its tooltip would sit in every shot after this one.
  await app.move(app.width * 0.5, app.height - 8, 150);

  // The advanced EQ drawer: a high-pass, a cut in the SIDE only, a bell and
  // a shelf, with MID and SIDE drawn apart over the live spectrum.
  await app.store(`(st().setWaveView('wave'), st().setAdvEqOpen(true),
    st().setAdvBand(0, { type: 'highpass', freq: 32 }), st().setAdvBand(1, { gainDb: -3, freq: 220, ch: 'side' }),
    st().setAdvBand(3, { gainDb: 3, freq: 3200, q: 1.4 }), st().setAdvBand(5, { gainDb: 2 }),
    st().seekSec(20), st().togglePlay(), 1)`);
  await app.eval(`document.querySelectorAll('.eqband')[1]?.click()`);
  await sleep(2400);
  await shoot('03-adv-eq');

  // PAPER, the light theme.
  await app.store(`(st().togglePlay(), st().setAdvEqOpen(false), st().setTheme('paper'), st().seekSec(56), st().togglePlay(), 1)`);
  await sleep(2400);
  await shoot('05-paper');

  await app.store(`(st().togglePlay(), st().setTheme('plate'), st().resetAdvEq(), 1)`);
  await settle(app, 800);

  // The command palette, part-way through a search.
  await ctrl('k');
  await sleep(300);
  await app.type('loud', 30);
  await sleep(300);
  await shoot('07-palette');
  await app.key('Escape', 'Escape');

  // Top and tail trimmed, fades from the trim points, a free loop, the
  // master drawn over the source, and the loudness history.
  await app.store(`(st().setTrim('start', 3.2), st().setTrim('end', 74), st().setFade('in', 1.5), st().setFade('out', 5),
    st().setLoopRange(17.45, 34.9), st().setProcessedView(true), st().setClipMode('soft'), st().setMeterView('loudness'), 1)`);
  await waitPreview();
  await settle(app);
  await app.store(`(st().seekSec(19), st().togglePlay(), 1)`);
  await sleep(6000);
  await shoot('08-trim-loop');
  await app.store(`(st().togglePlay(), st().clearLoop(), 1)`);

  // EXPORT, set for a 16-bit 44.1 kHz delivery, before anything renders.
  await app.store(`(st().setMeta('artist', 'Neon Circuit'), st().setMeta('album', 'Midnight Static EP'), st().setMeta('catalog', 'JW-014'),
    st().setExportFormat('flac'), st().setExportBitDepth(16), st().setExportRate(44100), st().setExportDither('shaped'), st().openExport(true), 1)`);
  await settle(app, 800);
  await shoot('09-export');
  await app.store(`(st().openExport(false), 1)`);

  // The report of that master: rendered in the app (nothing is saved by
  // it), written here, and shot as the page a browser shows.
  if (wanted.size === 0 || wanted.has('10-report')) {
    const html = await app.eval(`(async () => {
      const { engine, chainParams, report } = window.__jmaster;
      const src = engine.currentAudio();
      const r = await engine.renderBuffers(src.l, src.r, chainParams(), src.lufs, src.durationSec,
        { format: 'flac', bitDepth: 16, mp3Kbps: 320, sampleRate: 44100, dither: 'shaped' });
      return report(r, 'midnight-static - Master 44k16.flac', 'Midnight Static');
    })()`);
    const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
    if (html && edge) {
      const page = join(work, 'report.html');
      writeFileSync(page, html);
      execFileSync(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1.5',
        '--window-size=1000,1560', `--screenshot=${resolve(OUT, '10-report.png')}`, pathToFileURL(page).href], { stdio: 'ignore' });
      console.log('captured 10-report');
    } else {
      console.log('skipped 10-report (needs Microsoft Edge)');
    }
  }
  await app.store(`(st().clearTrim(), st().setFade('in', 0), st().setFade('out', 0), st().setProcessedView(false), st().setClipMode('off'),
    st().setMeterView('spectrum'), st().setExportFormat('wav'), st().setExportBitDepth(24), st().setExportRate(48000), 1)`);
  await settle(app, 800);

  // Four tracks dragged over the loaded console: they will queue in BATCH.
  const names = ['01 midnight-static', '02 neon-arcade', '03 last-train-home', '04 afterglow'];
  const files = names.map((n) => { const p = join(work, `${n}.wav`); copyFileSync(song, p); return p; });
  const x = app.width * 0.56, y = app.height * 0.58;
  const cancel = await app.hoverFiles(files, x, y);
  await app.eval(`(window.__demo.ghost('<span class="ic">WAV</span>4 files<span class="badge">+ COPY</span>'), window.__demo.place(${x}, ${y}))`);
  await shoot('06-drop', { cursor: true });
  await cancel();

  // The diagnosis sheet, on an extended take whose tempo runs away.
  const extended = join(work, 'midnight-static (extended).wav');
  execFileSync(process.execPath, ['scripts/make-demo-song.mjs', extended, '--drift'], { stdio: 'inherit' });
  const wave = await app.box('.waveframe');
  await app.dropFiles([extended], wave.x, wave.y, { ms: 150 });
  await app.eval(`(async () => { const st = () => window.__jmaster.store.getState();
    for (let i = 0; i < 200; i++) { if (st().source?.name.includes('extended') && st().tempo) return; await new Promise(r => setTimeout(r, 100)); } })()`);
  await app.store(`(st().openDiag(true), 1)`);
  await settle(app, 800);
  await shoot('04-diagnosis');

  if (app.problems.length) console.log('page problems:\n  ' + app.problems.join('\n  '));
} finally {
  await app.close();
  rmSync(work, { recursive: true, force: true });
}
console.log('done');
