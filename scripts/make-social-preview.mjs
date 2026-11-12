// Draws the repository's social preview card (docs/assets/social-preview.png,
// 1280 × 640) in the Jamware style, with the app's own fonts. It carries no
// version number, so it never goes stale. GitHub only takes this image by
// hand: Settings → Social preview → Edit.
//
// Usage: node scripts/make-social-preview.mjs   (needs Microsoft Edge)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const W = 1280, H = 640;
const OUT = resolve('docs/assets/social-preview.png');
const fonts = pathToFileURL(resolve('public/fonts/fonts.css')).href;

// ── the waveform: one song's worth of peaks, the same every run ──────────
// Sections as the app labels them, with how loud each one plays.
const SECTIONS = [
  { label: 'INTRO', share: 0.2, level: 0.34 },
  { label: 'PEAK', share: 0.22, level: 0.92 },
  { label: 'MID', share: 0.2, level: 0.52 },
  { label: 'PEAK', share: 0.24, level: 0.96 },
  { label: 'OUTRO', share: 0.14, level: 0.3 },
];
let seed = 20260818;
const rnd = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return ((seed >>> 0) % 100000) / 100000;
};

const X0 = 64, X1 = W - 64;          // the plate, and where the trim brackets stand
const WX0 = X0 + 22, WX1 = X1 - 22;  // the music between them
const WAVE_TOP = 438, WAVE_H = 112;  // its waveform lane
const MID = WAVE_TOP + WAVE_H / 2;
const BARS = 192;
const PLAYHEAD = 0.345;              // inside the first PEAK

let bars = '';
let lane = '';
let labels = '';
let at = 0;
SECTIONS.forEach((s, si) => {
  const x = WX0 + at * (WX1 - WX0);
  if (si > 0) labels += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${WAVE_TOP - 22}" y2="${WAVE_TOP + WAVE_H + 14}" class="rule"/>`;
  labels += `<text x="${(x + (si > 0 ? 8 : 0)).toFixed(1)}" y="${WAVE_TOP - 10}" class="lbl${at <= PLAYHEAD && PLAYHEAD < at + s.share ? ' on' : ''}">${s.label}</text>`;
  at += s.share;
});
for (let i = 0; i < BARS; i++) {
  const u = (i + 0.5) / BARS;
  let acc = 0;
  const sec = SECTIONS.find((s) => (acc += s.share) > u) ?? SECTIONS.at(-1);
  const beat = i % 4 === 0 ? 1 : i % 2 === 0 ? 0.82 : 0.62;            // a pulse to it
  const fade = u > 0.94 ? (1 - u) / 0.06 : u < 0.012 ? u / 0.012 : 1;   // it ends, it starts
  const h = Math.max(2, sec.level * beat * (0.72 + 0.28 * rnd()) * fade * (WAVE_H / 2));
  const x = WX0 + u * (WX1 - WX0);
  bars += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${(MID - h).toFixed(1)}" y2="${(MID + h).toFixed(1)}" class="${u < PLAYHEAD ? 'played' : 'ahead'}"/>`;
}
// The short-term loudness lane under it: the same sections, smoothed.
{
  const pts = [];
  for (let i = 0; i <= 160; i++) {
    const u = i / 160;
    let level = 0, wsum = 0;
    for (let k = -6; k <= 6; k++) {
      const v = Math.min(1, Math.max(0, u + k / 160));
      let acc = 0;
      const sec = SECTIONS.find((s) => (acc += s.share) > v) ?? SECTIONS.at(-1);
      const w = 7 - Math.abs(k);
      level += sec.level * w; wsum += w;
    }
    const y = WAVE_TOP + WAVE_H + 34 - (level / wsum) * 22;
    pts.push(`${(WX0 + u * (WX1 - WX0)).toFixed(1)},${y.toFixed(1)}`);
  }
  lane = `<polyline points="${pts.join(' ')}" class="lane"/>`;
}
const px = WX0 + PLAYHEAD * (WX1 - WX0);
// Registration crosshairs, centred on the frame's corners.
const FRAME = 28;
const cross = [[FRAME, FRAME], [W - FRAME, FRAME], [FRAME, H - FRAME], [W - FRAME, H - FRAME]]
  .map(([x, y]) => `<path d="M${x - 8} ${y}h16M${x} ${y - 8}v16" class="cross"/>`).join('');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="${fonts}">
<style>
  :root { --ink: #0D0E10; --paper: #FBFAF7; --signal: #FF4D00; --g700: #33373C; --g600: #4A4F55; --g400: #878D93; --g300: #AFB3B8; --hair: #26292E; }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${W}px; height: ${H}px; background: var(--ink); overflow: hidden; }
  body { position: relative; color: var(--paper); font-family: 'IBM Plex Mono', monospace; -webkit-font-smoothing: antialiased; }
  .frame { position: absolute; inset: ${FRAME}px; border: 1px solid var(--hair); }
  .cross { stroke: var(--g400); stroke-width: 1; }
  .spec { position: absolute; font-size: 15px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--g400); white-space: nowrap; }
  .spec.l { left: 64px; top: 56px; } .spec.r { right: 64px; top: 56px; }
  .spec b { font-weight: 500; color: var(--paper); }
  .mark { position: absolute; left: 62px; top: 104px; width: 136px; height: 136px; color: var(--paper); }
  h1 {
    position: absolute; left: 236px; top: 96px;
    font: 800 142px/1 'Archivo', sans-serif; font-stretch: 125%; letter-spacing: -0.02em; text-transform: uppercase; white-space: nowrap;
  }
  .tag {
    position: absolute; left: 242px; top: 244px;
    font: 500 30px/1.2 'Archivo', sans-serif; font-stretch: 112%; letter-spacing: 0.005em; color: var(--g300); white-space: nowrap;
  }
  .tag i { font-style: normal; color: var(--signal); }
  .read { position: absolute; left: 64px; right: 64px; top: 310px; display: grid; grid-template-columns: 0.9fr 0.9fr 1.02fr 1.7fr; border-top: 1px solid var(--g700); }
  .read div { padding: 12px 0 0 18px; border-left: 1px solid var(--hair); }
  .read div:first-child { padding-left: 0; border-left: 0; }
  .read .k { display: block; font-size: 13px; letter-spacing: 0.16em; color: var(--g400); }
  .read .v { display: block; margin-top: 4px; font: 800 29px/1.1 'Archivo', sans-serif; font-stretch: 125%; white-space: nowrap; }
  .read .v small { margin-left: 8px; font: 500 14px 'IBM Plex Mono', monospace; letter-spacing: 0.1em; color: var(--g400); }
  svg.plate { position: absolute; inset: 0; }
  .played { stroke: var(--signal); stroke-width: 3.2; }
  .ahead { stroke: var(--g600); stroke-width: 3.2; }
  .rule { stroke: var(--hair); stroke-width: 1; }
  .lbl { font: 500 12px 'IBM Plex Mono', monospace; letter-spacing: 0.16em; fill: var(--g600); }
  .lbl.on { fill: var(--signal); }
  .lane { fill: none; stroke: var(--g400); stroke-width: 1.5; }
  .head { stroke: var(--signal); stroke-width: 2; }
  .cap { fill: var(--signal); }
  .bracket { fill: none; stroke: var(--paper); stroke-width: 2.5; }
</style></head>
<body>
  <div class="frame"></div>
  <span class="spec l">JMW Software · Jamware Records · Music, manufactured.</span>
  <span class="spec r">Windows x64 · ARM64 · <b>Open source</b></span>

  <svg class="mark" viewBox="0 0 64 64" fill="none">
    <circle cx="32" cy="32" r="24" stroke="currentColor" stroke-width="3"/>
    <circle cx="32" cy="32" r="18" stroke="currentColor" stroke-width="1.5"/>
    <circle cx="32" cy="32" r="13" stroke="currentColor" stroke-width="1.5"/>
    <rect x="28" y="28" width="8" height="8" fill="#FF4D00"/>
    <path d="M32 1v4M32 59v4M1 32h4M59 32h4" stroke="currentColor" stroke-width="2"/>
  </svg>
  <h1>J-Master</h1>
  <p class="tag">Mastering console for the AI music era<i>.</i></p>

  <div class="read">
    <div><span class="k">INTEGRATED</span><span class="v">−14.0<small>LUFS</small></span></div>
    <div><span class="k">TRUE PEAK</span><span class="v">−1.0<small>dBTP</small></span></div>
    <div><span class="k">METERED TO</span><span class="v">BS.1770-4</span></div>
    <div><span class="k">EXPORTS</span><span class="v">WAV FLAC MP3 OPUS</span></div>
  </div>

  <svg class="plate" viewBox="0 0 ${W} ${H}">
    ${cross}
    ${labels}
    ${bars}
    ${lane}
    <path d="M${X0 + 9} ${MID - 22}h-9v44h9" class="bracket"/>
    <path d="M${X1 - 9} ${MID - 22}h9v44h-9" class="bracket"/>
    <line x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${WAVE_TOP - 22}" y2="${WAVE_TOP + WAVE_H + 14}" class="head"/>
    <rect x="${(px - 6).toFixed(1)}" y="${WAVE_TOP - 28}" width="12" height="12" class="cap"/>
  </svg>
</body></html>`;

const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!edge) {
  console.error('Microsoft Edge is needed to render the card.');
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), 'jmaster-social-'));
try {
  const page = join(work, 'card.html');
  writeFileSync(page, html);
  // The time budget lets the bundled fonts load before the shot is taken.
  execFileSync(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--virtual-time-budget=6000', `--window-size=${W},${H}`, `--screenshot=${OUT}`, pathToFileURL(page).href], { stdio: 'ignore' });
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`wrote ${OUT}`);
