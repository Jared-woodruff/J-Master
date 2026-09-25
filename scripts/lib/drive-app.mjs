// Drives the built J-Master app over the Chrome DevTools Protocol, for the
// scripts that make the README media. The app runs in production mode on a
// throwaway profile (your own settings, presets and recent files are never
// touched), with audio muted, and is operated with real input: OS-style
// file drops, mouse moves, clicks, drags and key presses.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

// A presentation cursor and click ring, drawn in the page because CDP input
// has no visible pointer; plus the card that follows it during file drags.
const OVERLAY = `(() => {
  if (window.__demo) return;
  const css = document.createElement('style');
  css.textContent = \`
#__demo_cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-60px,-60px)}
.__demo_ring{position:fixed;z-index:2147483646;pointer-events:none;width:30px;height:30px;margin:-15px 0 0 -15px;border:2px solid #FF4D00;border-radius:50%;animation:__demo_ring .5s cubic-bezier(.2,0,0,1) forwards}
@keyframes __demo_ring{from{transform:scale(.25);opacity:1}to{transform:scale(1.25);opacity:0}}
#__demo_ghost{position:fixed;left:0;top:0;z-index:2147483645;pointer-events:none;display:none;align-items:center;gap:9px;padding:8px 12px 8px 8px;background:rgba(23,25,28,.92);border:1px solid #4A4F55;color:#FBFAF7;font:500 12px/1 'IBM Plex Mono',monospace;letter-spacing:.04em;box-shadow:0 8px 24px rgba(0,0,0,.35)}
#__demo_ghost .ic{width:26px;height:32px;flex:none;display:grid;place-items:end center;padding-bottom:4px;box-sizing:border-box;background:#222528;border:1px solid #878D93;clip-path:polygon(0 0,70% 0,100% 22%,100% 100%,0 100%);font:600 8px/1 'IBM Plex Mono',monospace;color:#FBFAF7}
#__demo_ghost img{width:32px;height:32px;flex:none;object-fit:cover;border:1px solid #878D93}
#__demo_ghost .badge{margin-left:4px;padding:3px 5px;background:#FF4D00;color:#0D0E10;font-size:10px}\`;
  document.head.appendChild(css);
  const cursor = document.createElement('div');
  cursor.id = '__demo_cursor';
  cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M4 2.5v18l4.6-4.4 3.1 6.9 3-1.4-3.1-6.8 6.4-.3z" fill="#FBFAF7" stroke="#0D0E10" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const ghost = document.createElement('div');
  ghost.id = '__demo_ghost';
  document.body.append(ghost, cursor);
  const place = (x, y) => {
    cursor.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 2.5) + 'px)';
    ghost.style.transform = 'translate(' + (x + 16) + 'px,' + (y + 18) + 'px)';
  };
  const ring = (x, y) => {
    const r = document.createElement('div');
    r.className = '__demo_ring';
    r.style.left = x + 'px'; r.style.top = y + 'px';
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 600);
  };
  for (const t of ['pointermove', 'mousemove']) window.addEventListener(t, (e) => place(e.clientX, e.clientY), true);
  window.addEventListener('pointerdown', (e) => ring(e.clientX, e.clientY), true);
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height }; };
  window.__demo = {
    place,
    hide() { cursor.style.transform = 'translate(-60px,-60px)'; ghost.style.display = 'none'; },
    ghost(html) { ghost.innerHTML = html; ghost.style.display = html ? 'flex' : 'none'; },
    // The innermost visible element whose text or aria-label matches,
    // optionally inside a container (a wrapper can share its button's
    // text). A trailing * matches a prefix ("+ MP3*").
    find(text, within) {
      const root = within ? document.querySelector(within) : document;
      if (!root) return null;
      const prefix = text.endsWith('*');
      const want = (prefix ? text.slice(0, -1) : text).toUpperCase();
      let best = null;
      for (const el of root.querySelectorAll('button,[role=tab],[role=slider],.pname,span,label,div')) {
        if (!vis(el)) continue;
        const t = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().toUpperCase();
        if (!(prefix ? t.startsWith(want) : t === want)) continue;
        const b = box(el);
        if (!best || b.width * b.height < best.width * best.height) best = b;
      }
      return best;
    },
    box(selector) { const el = document.querySelector(selector); return el && vis(el) ? box(el) : null; },
  };
})()`;

export async function launchApp({ port = 9235, width = 1440, height = 900, scale = 1.5 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'jmaster-media-'));
  const child = spawn(electronPath, [
    '.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--mute-audio',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
  ], { stdio: 'ignore', cwd: ROOT, env: { ...process.env, VITE_DEV_SERVER_URL: '' } });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(400);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
    } catch { /* still booting */ }
  }
  if (!target) { child.kill(); throw new Error('the app did not start'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  const listeners = new Map();
  const problems = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    listeners.get(m.method)?.(m.params);
  };
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => pending.set(id, res));
  };
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await sleep(1200);
  await evalJs(OVERLAY);

  let pos = { x: width + 20, y: height * 0.72 };
  const app = {
    width, height, scale, problems, send, eval: evalJs,
    store: (expr) => evalJs(`(async () => { const st = () => window.__jmaster.store.getState(); return ${expr}; })()`),
    async find(text, within) {
      const r = await evalJs(`window.__demo.find(${JSON.stringify(text)}, ${JSON.stringify(within ?? null)})`);
      if (!r) throw new Error(`not on screen: ${text}`);
      return r;
    },
    async box(selector) {
      const r = await evalJs(`window.__demo.box(${JSON.stringify(selector)})`);
      if (!r) throw new Error(`not on screen: ${selector}`);
      return r;
    },
    /**
     * Glides the pointer to (x, y) over `ms` of wall-clock time, sending real
     * mouse moves on the way (as many as the round trips allow).
     */
    async move(x, y, ms = 450, buttons = 0) {
      const from = { ...pos };
      const t0 = Date.now();
      for (;;) {
        const u = Math.min(1, (Date.now() - t0) / ms);
        const e = ease(u);
        pos = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, buttons, button: buttons ? 'left' : 'none' });
        if (u >= 1) break;
        await sleep(10);
      }
    },
    async click(x, y, { ms = 450, count = 1 } = {}) {
      await app.move(x, y, ms);
      await sleep(90);
      for (let c = 1; c <= count; c++) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: c });
        await sleep(70);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: c });
        if (c < count) await sleep(90);
      }
    },
    async clickOn(text, within, opts) {
      const r = await app.find(text, within);
      await app.click(r.x, r.y, opts);
      return r;
    },
    /** Press, move with the button held, release (knobs, handles). */
    async drag(x0, y0, x1, y1, ms = 700) {
      await app.move(x0, y0, 400);
      await sleep(80);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(80);
      await app.move(x1, y1, ms, 1);
      await sleep(80);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1 });
    },
    async wheel(x, y, deltaY, times = 1) {
      for (let i = 0; i < times; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
        await sleep(90);
      }
    },
    async key(key, code = key, text) {
      const vk = { ' ': 32, Enter: 13, Escape: 27, l: 76, L: 76 }[key] ?? key.toUpperCase().charCodeAt(0);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text });
      await sleep(40);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    },
    async type(text, perChar = 55) {
      for (const ch of text) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
        await sleep(perChar);
      }
    },
    /**
     * Drags files in from outside the window the way the OS does (enter,
     * over, drop), with a card under the pointer showing what is carried.
     */
    async dropFiles(files, x, y, { card = '', ms = 1100 } = {}) {
      const data = { items: [], files, dragOperationsMask: 1 };
      await evalJs(`window.__demo.ghost(${JSON.stringify(card)})`);
      const from = { ...pos };
      const t0 = Date.now();
      let entered = false;
      for (;;) {
        const u = Math.min(1, (Date.now() - t0) / ms);
        const e = ease(u);
        pos = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
        await evalJs(`window.__demo.place(${pos.x}, ${pos.y})`);
        const inside = pos.x >= 0 && pos.y >= 0 && pos.x < width && pos.y < height;
        if (inside) {
          await send('Input.dispatchDragEvent', { type: entered ? 'dragOver' : 'dragEnter', x: pos.x, y: pos.y, data });
          entered = true;
        }
        if (u >= 1) break;
        await sleep(10);
      }
      await sleep(250);
      await send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
      await evalJs(`window.__demo.ghost('')`);
    },
    /** Parks the presentation cursor off screen (for stills). */
    async hideCursor() {
      pos = { x: width + 20, y: height * 0.72 };
      await evalJs('window.__demo.hide()');
    },
    /** Hovers files over the window without dropping them (drop veils). */
    async hoverFiles(files, x, y) {
      const data = { items: [], files, dragOperationsMask: 1 };
      await send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
      await send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
      return async () => send('Input.dispatchDragEvent', { type: 'dragCancel', x, y, data });
    },
    /** Starts a screencast; resolves the stop function to the frames. */
    async record() {
      const frames = [];
      listeners.set('Page.screencastFrame', (p) => {
        frames.push({ data: p.data, t: p.metadata.timestamp });
        void send('Page.screencastFrameAck', { sessionId: p.sessionId });
      });
      await send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
      return async () => {
        await send('Page.stopScreencast');
        listeners.delete('Page.screencastFrame');
        return frames;
      };
    },
    async screenshot(clip) {
      const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      return Buffer.from(r.result.data, 'base64');
    },
    async close() {
      try { ws.close(); } catch { /* already closed */ }
      child.kill();
      for (let i = 0; i < 20; i++) {
        await sleep(250);
        try { rmSync(profile, { recursive: true, force: true }); break; } catch { /* still locked */ }
      }
    },
  };
  return app;
}

/** Waits until the loaded track's tempo and sections are in. */
export async function waitForAnalysis(app) {
  await app.eval(`(async () => {
    const st = () => window.__jmaster.store.getState();
    for (let i = 0; i < 200; i++) { if (st().loaded && st().tempo) return true; await new Promise(r => setTimeout(r, 100)); }
    throw new Error('analysis did not finish');
  })()`);
}

/** Waits for the master preview render and for toasts to clear. */
export async function settle(app, quietMs = 1500) {
  await app.eval(`(async () => {
    const eng = window.__jmaster.engine;
    let quiet = 0;
    for (let i = 0; i < 400 && quiet < ${Math.round(quietMs / 100)}; i++) {
      const s = window.__jmaster.store.getState();
      quiet = !eng.previewPending && s.toasts.length === 0 ? quiet + 1 : 0;
      await new Promise(r => setTimeout(r, 100));
    }
  })()`);
}
