// Records the README's animated GIFs by driving the built app with real
// input (see scripts/lib/drive-app.mjs): a file dropped in from outside the
// window, clicks, a knob drag, typing, and a cover image dropped on EXPORT.
// Nothing is ever rendered or saved; the export scene stops at hovering the
// RENDER button.
//
// Prereqs: `npm run build`, and ffmpeg on PATH.
// Usage:   node scripts/capture-media.mjs [scene ...]
//          scenes: drop split monitor presets auto export (default: all)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchApp, settle, sleep, waitForAnalysis } from './lib/drive-app.mjs';

const OUT = 'docs/media';
mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'jmaster-capture-'));
const song = join(work, 'midnight-static.wav');
execFileSync(process.execPath, ['scripts/make-demo-song.mjs', song], { stdio: 'inherit' });
const wanted = new Set(process.argv.slice(2));
const want = (name) => wanted.size === 0 || wanted.has(name);

/**
 * Frames (screencast PNGs with timestamps) → optimised looping GIF. `crop`
 * is in CSS pixels; frames arrive at the display's pixel density.
 */
function encodeGif(frames, name, { crop, maxWidth = 1200, fps = 15, hold = 1.4 }) {
  const k = Buffer.from(frames[0].data, 'base64').readUInt32BE(16) / app.width;
  const dir = mkdtempSync(join(work, `${name}-`));
  const file = (i) => `f${String(i).padStart(5, '0')}.png`;
  let list = 'ffconcat version 1.0\n';
  frames.forEach((f, i) => {
    writeFileSync(join(dir, file(i)), Buffer.from(f.data, 'base64'));
    const d = i + 1 < frames.length ? Math.max(0.001, frames[i + 1].t - f.t) : hold;
    list += `file ${file(i)}\nduration ${d.toFixed(4)}\n`;
  });
  list += `file ${file(frames.length - 1)}\n`;
  writeFileSync(join(dir, 'list.txt'), list);
  const c = { x: Math.round(crop.x * k), y: Math.round(crop.y * k), w: Math.round(crop.width * k), h: Math.round(crop.height * k) };
  const scale = c.w > maxWidth ? `,scale=${maxWidth}:-1:flags=lanczos` : '';
  const vf = `crop=${c.w}:${c.h}:${c.x}:${c.y},fps=${fps}${scale},split[a][b];`
    + '[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle';
  const out = join(OUT, `${name}.gif`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', vf, '-loop', '0', out]);
  rmSync(dir, { recursive: true, force: true });
  const secs = frames.at(-1).t - frames[0].t + hold;
  console.log(`${out}: ${(statSync(out).size / 1048576).toFixed(2)} MB, ${secs.toFixed(1)} s, ${frames.length} frames`);
}

const pad = (b, m = 10, app) => {
  const x = Math.max(0, b.left - m), y = Math.max(0, b.top - m);
  return { x, y, width: Math.min(app.width - x, b.width + 2 * m), height: Math.min(app.height - y, b.height + 2 * m) };
};

const app = await launchApp({ width: 1440, height: 900 });
try {
  // Artwork for the export scene, drawn in the page with the app's own fonts.
  const cover = join(work, 'midnight-static-cover.png');
  const art = await app.eval(`(async () => {
    await document.fonts.ready;
    const draw = (size) => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = size;
      const g = cv.getContext('2d');
      const s = size / 1000;
      g.fillStyle = '#0D0E10'; g.fillRect(0, 0, size, size);
      const sun = g.createLinearGradient(0, 180 * s, 0, 640 * s);
      sun.addColorStop(0, '#FF4D00'); sun.addColorStop(1, '#8A1F00');
      g.save();
      g.beginPath(); g.arc(500 * s, 470 * s, 250 * s, 0, Math.PI * 2); g.clip();
      g.fillStyle = sun; g.fillRect(0, 0, size, size);
      g.fillStyle = '#0D0E10';
      for (let i = 0; i < 7; i++) g.fillRect(0, (500 + i * 32) * s, size, (6 + i * 3.2) * s);
      g.restore();
      g.strokeStyle = '#33373C'; g.lineWidth = 2 * s;
      for (let i = 0; i < 9; i++) { const y = (720 + i * i * 4.2) * s; g.beginPath(); g.moveTo(0, y); g.lineTo(size, y); g.stroke(); }
      for (let i = -8; i <= 8; i++) { g.beginPath(); g.moveTo(500 * s + i * 30 * s, 720 * s); g.lineTo(500 * s + i * 190 * s, size); g.stroke(); }
      g.fillStyle = '#FBFAF7';
      g.font = '800 ' + Math.round(96 * s) + 'px Archivo';
      g.fontStretch = 'expanded';
      g.textAlign = 'center';
      g.fillText('MIDNIGHT', 500 * s, 150 * s);
      g.fillText('STATIC', 500 * s, 240 * s);
      g.font = '500 ' + Math.round(26 * s) + 'px "IBM Plex Mono"';
      g.fillStyle = '#878D93';
      g.fillText('NEON CIRCUIT  ·  JW-014', 500 * s, 950 * s);
      return cv.toDataURL('image/png');
    };
    return { full: draw(1000), thumb: draw(64) };
  })()`);
  writeFileSync(cover, Buffer.from(art.full.split(',')[1], 'base64'));

  // ── 1. drop: a track dropped on the open screen, analysed, played ──
  const dz = await app.box('.dropzone');
  if (want('drop')) {
    const stop = await app.record();
    await sleep(600);
    await app.dropFiles([song], dz.x, dz.y + 10, { card: '<span class="ic">WAV</span>midnight-static.wav<span class="badge">+ COPY</span>', ms: 1500 });
    await waitForAnalysis(app);
    await sleep(700);
    const wf = await app.box('.waveframe canvas');
    const dur = await app.store('st().source.durationSec');
    await app.click(wf.left + wf.width * (17.9 / dur), wf.top + wf.height * 0.58, { ms: 700 });
    await sleep(250);
    await app.clickOn('Play', '.transport', { ms: 650 });
    await sleep(200);
    await app.move(wf.left + wf.width * 0.62, wf.top + wf.height + 60, 900);
    await sleep(3000);
    encodeGif(await stop(), 'drop', { crop: { x: 0, y: 0, width: app.width, height: app.height }, hold: 0.1 });
  } else {
    await app.dropFiles([song], dz.x, dz.y, { ms: 200 });
    await waitForAnalysis(app);
  }
  await app.store(`(st().playing && st().togglePlay(), 1)`);
  await settle(app);

  // ── 2. split: OUT, SPLIT and LOOP on a playing track ──────────────
  if (want('split')) {
    // OUT's master preview renders before the take, so the scene is SPLIT
    // and LOOP rather than a progress label.
    await app.store(`(st().applyPreset('synthwave'), st().setProcessedView(true), 1)`);
    await app.eval(`(async () => { const eng = window.__jmaster.engine;
      for (let i = 0; i < 300; i++) { if (eng.processedPreview && !eng.previewPending) return; await new Promise(r => setTimeout(r, 100)); } })()`);
    await settle(app);
    await app.store(`(st().seekSec(64.4), st().togglePlay(), 1)`);
    await sleep(300);
    const top = await app.box('.transport');
    const wave = await app.box('.wavesection');
    const stop = await app.record();
    await sleep(500);
    await app.clickOn('SPLIT', '.wave-controls');
    await sleep(900);
    await app.clickOn('LOOP', '.wave-controls');
    await app.move(wave.left + wave.width * 0.55, wave.top + wave.height * 0.35, 800);
    // The loop wraps at the end of the section (69.8 s), back to 52.4 s.
    await app.eval(`(async () => { const st = () => window.__jmaster.store.getState();
      for (let i = 0; i < 160 && st().playheadSec > 60; i++) await new Promise(r => setTimeout(r, 50)); })()`);
    await sleep(1800);
    const crop = { x: 0, y: top.top - 12, width: app.width, height: wave.top + wave.height - top.top + 22 };
    encodeGif(await stop(), 'split-loop', { crop, fps: 15, hold: 0.1 });
    await app.store(`(st().playing && st().togglePlay(), st().loopStartSec != null && st().toggleLoop(), st().setOutSplit(false), st().setProcessedView(false), 1)`);
  }

  // ── 3. monitor: vectorscope, mono fold-down, platform loudness ─────
  if (want('monitor')) {
    await app.store(`(st().seekSec(36.2), st().togglePlay(), 1)`);
    await sleep(600);
    const panel = await app.box('.panel-meters');
    const stop = await app.record();
    await sleep(700);
    await app.clickOn('SCOPE', '.panel-meters');
    await sleep(1700);
    await app.clickOn('MONO', '.panel-meters');
    await sleep(1700);
    await app.clickOn('ST', '.panel-meters');
    await sleep(900);
    await app.clickOn('SPOTIFY', '.panel-meters');
    await app.move(panel.left + panel.width * 0.8, panel.top + panel.height * 0.46, 600);
    await sleep(1900);
    encodeGif(await stop(), 'monitor', { crop: pad(panel, 8, app), fps: 15, hold: 0.1 });
    await app.store(`(st().togglePlay(), st().setNormPreview(null), 1)`);
  }

  // ── 4. presets: pick, tweak, revert, save your own ─────────────────
  if (want('presets')) {
    await app.store(`(st().applyPreset('flat'), 1)`);
    await sleep(400);
    const rack = await app.box('.panel-presets');
    const desk = await app.box('.panel-console');
    const stop = await app.record();
    await sleep(600);
    await app.clickOn('ELECTRONIC', '.panel-presets');
    await sleep(900);
    const tone = await app.box('[role=slider][aria-label="TONE" i]');
    await app.drag(tone.x, tone.y, tone.x + 6, tone.y - 46, 800);
    await sleep(900);
    await app.clickOn('REVERT', '.panel-presets');
    await sleep(900);
    await app.clickOn('+ SAVE', '.panel-presets');
    await sleep(350);
    await app.type('MIDNIGHT MASTER');
    await sleep(300);
    await app.key('Enter');
    await app.move(desk.left + desk.width * 0.5, desk.top + desk.height * 0.6, 700);
    await sleep(1600);
    const x = rack.left - 8, y = Math.min(rack.top, desk.top) - 8;
    const crop = { x, y, width: desk.left + desk.width - x + 8, height: Math.max(rack.top + rack.height, desk.top + desk.height) - y + 8 };
    encodeGif(await stop(), 'presets', { crop, fps: 15 });
  }

  // ── 5. auto: the one-button master and its reasoning ───────────────
  if (want('auto')) {
    await app.store(`(st().applyPreset('flat'), 1)`);
    await settle(app, 600);
    const button = await app.find('AUTO →');
    const stop = await app.record();
    await sleep(500);
    await app.click(button.x, button.y, { ms: 800 });
    await sleep(900);
    const report = await app.box('[aria-label="Auto-master report"]');
    await app.move(report.left + report.width * 0.72, report.top + report.height * 0.62, 900);
    await sleep(2600);
    // The track, the button, and the report it opens, with the console
    // dimmed behind.
    const meta = await app.box('.trackmeta');
    const x = Math.min(report.left, meta.left) - 24;
    const right = Math.max(report.left + report.width + 24, button.left + button.width + 8);
    const y = button.top - 30;
    encodeGif(await stop(), 'auto', { crop: { x, y, width: right - x, height: report.top + report.height + 40 - y } });
    await app.store(`(st().closeMasterItReport(), 1)`);
    await sleep(300);
  }

  // ── 6. export: formats, ALSO SAVE, cover art (never rendered) ──────
  if (want('export')) {
    await app.store(`(st().applyPreset('synthwave'), st().setExportFormat('wav'), st().setMeta('artist', 'Neon Circuit'),
      st().setMeta('album', 'Midnight Static EP'), st().setMeta('catalog', 'JW-014'), 1)`);
    await settle(app, 600);
    await app.clickOn('EXPORT →', null, { ms: 500 });
    await sleep(700);
    const dlg = await app.box('[aria-label="Export master"]');
    const stop = await app.record();
    await sleep(500);
    await app.clickOn('+ MP3*', '[aria-label="Export master"] .chips', { ms: 800 });
    await sleep(500);
    await app.clickOn('+ OPUS*', '[aria-label="Export master"] .chips');
    await sleep(700);
    const tile = await app.box('[aria-label="Export master"] .cover-tile');
    await app.dropFiles([cover], tile.x, tile.y, { card: `<img src="${art.thumb}">midnight-static-cover.png<span class="badge">+ COPY</span>`, ms: 1300 });
    await sleep(900);
    const render = await app.find('RENDER + SAVE 3 FILES', '[aria-label="Export master"]').catch(() => null);
    if (render) await app.move(render.x, render.y, 800);
    await sleep(1700);
    encodeGif(await stop(), 'export', { crop: pad(dlg, 14, app), fps: 15 });
    await app.store(`(st().openExport(false), 1)`);
  }

  if (app.problems.length) console.log('page problems:\n  ' + app.problems.join('\n  '));
} finally {
  await app.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(`done: ${resolve(OUT)}`);
