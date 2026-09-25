// Captures the README screenshots from the built app, playing the demo
// track (scripts/make-demo-song.mjs), with the same driver as the GIFs
// (scripts/lib/drive-app.mjs): production build, throwaway profile, muted.
//
// Prereq: `npm run build`.
// Usage:  node scripts/capture-screens.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, settle, sleep, waitForAnalysis } from './lib/drive-app.mjs';

const OUT = 'docs/screenshots';
mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'jmaster-screens-'));
const song = join(work, 'midnight-static.wav');
execFileSync(process.execPath, ['scripts/make-demo-song.mjs', song], { stdio: 'inherit' });

const app = await launchApp({ width: 1440, height: 900 });
const shoot = async (name, { cursor = false } = {}) => {
  if (!cursor) await app.hideCursor();
  await sleep(450);
  writeFileSync(join(OUT, `${name}.png`), await app.screenshot());
  console.log(`captured ${name}`);
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

  // The advanced EQ drawer with a curve over the live spectrum.
  await app.store(`(st().setWaveView('wave'), st().setAdvEqOpen(true),
    st().setAdvBand(1, { gainDb: -2.5 }), st().setAdvBand(3, { gainDb: 3, freq: 3200, q: 1.4 }), st().setAdvBand(5, { gainDb: 2 }),
    st().seekSec(20), st().togglePlay(), 1)`);
  await sleep(2400);
  await shoot('03-adv-eq');

  // The diagnosis sheet.
  await app.store(`(st().togglePlay(), st().setAdvEqOpen(false), st().openDiag(true), 1)`);
  await settle(app, 800);
  await shoot('04-diagnosis');

  // PAPER, the light theme.
  await app.store(`(st().openDiag(false), st().setTheme('paper'), st().seekSec(56), st().togglePlay(), 1)`);
  await sleep(2400);
  await shoot('05-paper');

  // Four tracks dragged over the loaded console: they will queue in BATCH.
  await app.store(`(st().togglePlay(), st().setTheme('plate'), 1)`);
  await settle(app, 800);
  const names = ['01 midnight-static', '02 neon-arcade', '03 last-train-home', '04 afterglow'];
  const files = names.map((n) => { const p = join(work, `${n}.wav`); copyFileSync(song, p); return p; });
  const x = app.width * 0.56, y = app.height * 0.58;
  const cancel = await app.hoverFiles(files, x, y);
  await app.eval(`(window.__demo.ghost('<span class="ic">WAV</span>4 files<span class="badge">+ COPY</span>'), window.__demo.place(${x}, ${y}))`);
  await shoot('06-drop', { cursor: true });
  await cancel();

  if (app.problems.length) console.log('page problems:\n  ' + app.problems.join('\n  '));
} finally {
  await app.close();
  rmSync(work, { recursive: true, force: true });
}
console.log('done');
