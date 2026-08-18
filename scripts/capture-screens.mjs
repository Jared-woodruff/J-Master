// Captures README screenshots by driving the built app over CDP. dist/ is
// served over a local HTTP server so the demo track is fetchable.
// Prereq: `npm run build`, plus a track at dist/test-song.wav.
// Usage: node scripts/capture-screens.mjs
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname } from 'node:path';
import electronPath from 'electron';

const OUT = 'docs/screenshots';
mkdirSync(OUT, { recursive: true });
const port = 9227;
const httpPort = 5197;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.png': 'image/png', '.ico': 'image/x-icon',
};
const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const path = join('dist', url === '/' ? 'index.html' : url.slice(1));
  if (!existsSync(path)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
server.listen(httpPort);

const child = spawn(electronPath, ['.', `--remote-debugging-port=${port}`], {
  stdio: 'ignore',
  env: { ...process.env, VITE_DEV_SERVER_URL: `http://localhost:${httpPort}` },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.url.includes(`localhost:${httpPort}`));
    if (target) break;
  } catch { /* booting */ }
}
if (!target) {
  console.error('no page target');
  child.kill();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
};
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) console.error('eval error:', JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const shoot = async (name) => {
  await sleep(700);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  console.log(`captured ${name}`);
};
// Wait for the master preview to finish rendering and toasts to clear, and
// require 3 s of continuous quiet (the preview re-render debounce is 2 s),
// so no shot catches the console mid-update.
const settle = () => evalJs(`(async () => {
  const eng = window.__jmaster.engine;
  let stable = 0;
  for (let i = 0; i < 240 && stable < 12; i++) {
    const s = window.__jmaster.store.getState();
    if (!eng.previewPending && s.toasts.length === 0) stable++; else stable = 0;
    await new Promise(r => setTimeout(r, 250));
  }
  return 'settled';
})()`);

await send('Page.enable');
await sleep(2500);

// Load the test track and settle.
await evalJs(`(async () => {
  const r = await fetch('/test-song.wav');
  const ab = await r.arrayBuffer();
  await window.__jmaster.store.getState().loadFile(ab, 'midnight-static.wav');
  const st = window.__jmaster.store.getState();
  st.openDiag(false);
  st.applyPreset('synthwave');
  for (let i = 0; i < 40; i++) { await new Promise(r2 => setTimeout(r2, 250)); if (st.tempo || window.__jmaster.store.getState().tempo) break; }
  // SPLIT compare in the hero shot: source above, master below.
  const st3 = window.__jmaster.store.getState();
  st3.setProcessedView(true);
  st3.setOutSplit(true);
  const eng = window.__jmaster.engine;
  for (let i = 0; i < 120; i++) { await new Promise(r2 => setTimeout(r2, 250)); if (eng.processedPreview && !eng.previewPending) break; }
  window.__jmaster.store.getState().seekSec(13.2);
  return 'ok';
})()`);
await sleep(1500);
await settle();
await shoot('01-console');

// Spectrogram + grid, zoomed.
await evalJs(`(async () => {
  const st = window.__jmaster.store.getState();
  st.setWaveView('spec');
  for (let i = 0; i < 40; i++) { await new Promise(r2 => setTimeout(r2, 250)); if (window.__jmaster.engine.spectrogram) break; }
  const canvas = document.querySelector('.waveframe canvas');
  const rc = canvas.getBoundingClientRect();
  for (let i = 0; i < 3; i++) {
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: rc.left + rc.width * 0.4, clientY: rc.top + rc.height / 2, bubbles: true, cancelable: true }));
    await new Promise(r2 => setTimeout(r2, 80));
  }
  return 'ok';
})()`);
await settle();
await shoot('02-spectrogram');

// Advanced EQ drawer with a curve.
await evalJs(`(() => {
  const st = window.__jmaster.store.getState();
  st.setWaveView('wave');
  st.setAdvEqOpen(true);
  st.setAdvBand(1, { gainDb: -2.5 });
  st.setAdvBand(3, { gainDb: 3, freq: 3200, q: 1.4 });
  st.setAdvBand(5, { gainDb: 2 });
  return 'ok';
})()`);
await settle();
await shoot('03-adv-eq');

// Diagnosis sheet.
await evalJs(`(() => {
  const st = window.__jmaster.store.getState();
  st.setAdvEqOpen(false);
  st.openDiag(true);
  return 'ok';
})()`);
await settle();
await shoot('04-diagnosis');

// Paper theme.
await evalJs(`(() => {
  const st = window.__jmaster.store.getState();
  st.openDiag(false);
  st.setTheme('paper');
  return 'ok';
})()`);
await settle();
await shoot('05-paper');

// Export dialog.
await evalJs(`(() => {
  const st = window.__jmaster.store.getState();
  st.setTheme('plate');
  st.setExportFormat('opus');
  st.setMeta('artist', 'Neon Circuit');
  st.setMeta('album', 'Midnight Static EP');
  st.setMeta('catalog', 'JW-014');
  st.openExport(true);
  return 'ok';
})()`);
await settle();
await shoot('06-export');

await evalJs(`window.__jmaster.store.getState().openExport(false); 'ok'`);
ws.close();
child.kill();
server.close();
console.log('done');
process.exit(0);
