// Generates the README banners in the Jamware Records design language:
// graphite plates, paper type, one signal orange, hairline structure,
// registration crosshairs, mono spec labels, and small looping figures.
//
// Type is set as vector paths from scripts/banner-glyphs.json (Archivo
// Expanded ExtraBold and IBM Plex Mono, the fonts the app ships), because
// GitHub serves repository SVGs under a content policy that blocks fonts.
// Motion is CSS only (no script, no SMIL) so that reduced-motion settings
// stop all of it; every element's resting style is its finished pose, which
// is the still frame shown when motion is off.
//
// Usage: node scripts/make-banners.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const OUT = 'docs/assets';
mkdirSync(OUT, { recursive: true });
const atlas = JSON.parse(readFileSync(new URL('./banner-glyphs.json', import.meta.url), 'utf8'));

const C = {
  g950: '#0D0E10', g900: '#17191C', g800: '#222528', g700: '#33373C', g600: '#4A4F55',
  g500: '#63696F', g400: '#878D93', g300: '#AFB3B8', paper: '#FBFAF7', signal: '#FF4D00',
  well: '#0A0B0D', hair: '#26292E', bar: '#3D4248', run: '#1F9D55',
};
const EASE = 'cubic-bezier(.2,0,0,1)';
const MINUS = '−';
const rnd = (i) => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
const f1 = (n) => (Math.round(n * 10) / 10).toString();
const num = (v, digits = 0) => (v < 0 ? MINUS : '') + Math.abs(v).toFixed(digits);

// ── type as paths ───────────────────────────────────────────────────────
const TOKENS = /[MLHVQCZ]|-?\d+/g;
function glyphPath(d, ox, oy, s) {
  let out = '';
  let cmd = '';
  let idx = 0;
  for (const t of d.match(TOKENS) ?? []) {
    if (/[MLHVQCZ]/.test(t)) { cmd = t; idx = 0; out += t; continue; }
    const v = Number(t);
    const n = cmd === 'H' ? ox + v * s
      : cmd === 'V' ? oy - v * s
      : idx % 2 === 0 ? ox + v * s : oy - v * s;
    idx++;
    out += (/[MLHVQCZ]$/.test(out) ? '' : ' ') + f1(n);
  }
  return out;
}

function measure(key, str, size, tracking) {
  const f = atlas[key];
  const s = size / f.upm;
  const chars = Array.from(str);
  const xs = [];
  let x = 0;
  chars.forEach((ch, i) => {
    xs.push(x);
    const g = f.glyphs[ch] ?? f.glyphs['?'];
    let adv = g.adv;
    if (f.kern && i + 1 < chars.length) adv += f.kern[ch + chars[i + 1]] ?? 0;
    x += adv * s + (i + 1 < chars.length ? tracking * size : 0);
  });
  return { chars, xs, width: x, s };
}

/**
 * Sets `str` with its baseline at (x, y). Options: tracking (em), anchor,
 * fill, cls, maxWidth (shrinks to fit), perGlyph (one path per glyph, for
 * staggered entrances, with delay0 and stagger in ms).
 */
function type(key, str, x, y, size, o = {}) {
  const tracking = o.tracking ?? 0;
  let sz = size;
  let m = measure(key, str, sz, tracking);
  if (o.maxWidth && m.width > o.maxWidth) {
    sz = (size * o.maxWidth) / m.width;
    m = measure(key, str, sz, tracking);
  }
  const x0 = o.anchor === 'end' ? x - m.width : o.anchor === 'middle' ? x - m.width / 2 : x;
  const f = atlas[key];
  const g = (ch, i) => glyphPath((f.glyphs[ch] ?? f.glyphs['?']).d, x0 + m.xs[i], y, m.s);
  const cls = o.cls ? ` class="${o.cls}"` : '';
  const fill = (ch, i) => ` fill="${o.fills?.[i] ?? o.fill ?? C.paper}"`;
  if (o.perGlyph) {
    const svg = m.chars.map((ch, i) => (ch === ' ' ? '' :
      `<path${cls}${fill(ch, i)} style="animation-delay:${(o.delay0 ?? 0) + i * (o.stagger ?? 45)}ms" d="${g(ch, i)}"/>`)).join('');
    return { svg, width: m.width, x0, size: sz };
  }
  const d = m.chars.map((ch, i) => (ch === ' ' ? '' : g(ch, i))).join('');
  return { svg: `<path${cls}${fill()} d="${d}"/>`, width: m.width, x0, size: sz };
}

const crosshair = (x, y) => `<path d="M${x - 5} ${y}h10M${x} ${y - 5}v10" stroke="${C.g500}" stroke-width="1"/>`;
const plate = (w, h) =>
  `<rect width="${w}" height="${h}" fill="${C.g950}"/>`
  + `<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" fill="none" stroke="${C.hair}"/>`;

function svgDoc(w, h, label, css, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}">
<title>${label}</title>
<style>${css}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}</style>
${body}
</svg>
`;
}

// The Jamware mark: platter and grooves under fixed registration ticks,
// with the label (signal arc and spindle) turning.
function mark(cx, cy, s) {
  const r = 21 * s;
  const a0 = -1.2, a1 = -0.35;
  return {
    svg: `<circle cx="${cx}" cy="${cy}" r="${24 * s}" stroke="${C.paper}" stroke-width="${3 * s}" fill="none"/>
<circle cx="${cx}" cy="${cy}" r="${18 * s}" stroke="${C.paper}" stroke-width="${1.5 * s}" fill="none"/>
<circle cx="${cx}" cy="${cy}" r="${13 * s}" stroke="${C.paper}" stroke-width="${1.5 * s}" fill="none"/>
<path d="M${cx} ${cy - 31 * s}v${4 * s}M${cx} ${cy + 27 * s}v${4 * s}M${cx - 31 * s} ${cy}h${4 * s}M${cx + 27 * s} ${cy}h${4 * s}" stroke="${C.paper}" stroke-width="${2 * s}"/>
<g class="spin">
<path d="M${f1(cx + r * Math.cos(a0))} ${f1(cy + r * Math.sin(a0))}A${f1(r)} ${f1(r)} 0 0 1 ${f1(cx + r * Math.cos(a1))} ${f1(cy + r * Math.sin(a1))}" stroke="${C.signal}" stroke-width="${1.5 * s}" fill="none"/>
<rect x="${cx - 4 * s}" y="${cy - 4 * s}" width="${8 * s}" height="${8 * s}" fill="${C.signal}"/>
</g>`,
    css: `.spin{transform-origin:${cx}px ${cy}px;animation:spin 14s linear infinite}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`,
  };
}

// ── hero ────────────────────────────────────────────────────────────────
function hero() {
  const W = 880, H = 300;
  const L = 28, R = W - 28;
  // A song's shape: intro, build, peak, breakdown, peak, outro.
  const envAt = (p) =>
    p < 0.14 ? 0.3 : p < 0.24 ? 0.3 + ((p - 0.14) / 0.1) * 0.5 : p < 0.52 ? 0.92
      : p < 0.64 ? 0.4 : p < 0.9 ? 0.95 : 0.95 - ((p - 0.9) / 0.1) * 0.85;
  const n = Math.floor((R - L) / 4);
  const cy = 244, amp = 24;
  let bars = '';
  for (let i = 0; i < n; i++) {
    const p = i / n;
    const a = envAt(p) * (0.66 + 0.34 * rnd(i)) + (i % 8 === 0 ? 0.08 : 0);
    const h = Math.max(1.5, Math.min(1, a) * amp * 2);
    bars += `<rect x="${L + i * 4}" y="${f1(cy - h / 2)}" width="2" height="${f1(h)}"/>`;
  }
  const sections = [[0, 'INTRO'], [0.24, 'PEAK'], [0.52, 'MID'], [0.64, 'PEAK'], [0.9, 'OUTRO']];
  const markers = sections.map(([p, label]) => {
    const x = L + p * (R - L);
    return (p > 0 ? `<rect x="${f1(x)}" y="212" width="1" height="62" fill="${C.signal}" opacity=".55"/>` : '')
      + type('mono', label, x + 4, 222, 8, { tracking: 0.12, fill: p > 0 ? C.g400 : C.g500 }).svg;
  }).join('');
  const times = [['0:00', L, 'start'], ['1:04', (L + R) / 2, 'middle'], ['2:08', R, 'end']]
    .map(([t, x, a]) => type('mono', t, x, 290, 9, { anchor: a, fill: C.g500, tracking: 0.05 }).svg).join('');

  // The hyphen in signal orange, the way the app marks its accent.
  const word = type('display', 'J-MASTER', 176, 142, 64, {
    tracking: 0.02, perGlyph: true, cls: 'rise', stagger: 55, fills: { 1: C.signal },
  });

  const meterRows = [['M', 0.62, 0.84, 1.1, -0.2], ['S', 0.66, 0.8, 1.7, -0.9], ['I', 0.73, 0.76, 2.4, -0.3], ['TP', 0.7, 0.9, 0.8, -0.5]];
  const mx = 752, mw = 100;
  const meters = meterRows.map(([label, lo, hi, dur, delay], k) => {
    const y = 96 + k * 22;
    return type('mono', label, 722, y + 7, 9, { fill: C.g400, tracking: 0.1 }).svg
      + `<rect x="${mx}" y="${y}" width="${mw}" height="8" fill="${C.g800}"/>`
      + `<rect class="meter" x="${mx}" y="${y}" width="${mw}" height="8" fill="${C.signal}" style="--lo:${lo};--hi:${hi};animation-duration:${dur}s;animation-delay:${delay}s"/>`;
  }).join('')
    + `<rect x="${mx + mw * 0.8}" y="92" width="1" height="54" fill="${C.paper}" opacity=".75"/>`
    + type('mono', 'LOUDNESS', 722, 84, 8, { fill: C.g500, tracking: 0.18 }).svg
    + type('mono', num(-14, 1), R, 84, 8, { anchor: 'end', fill: C.g400, tracking: 0.1 }).svg;

  const m = mark(100, 128, 1.9);
  const css = `${m.css}
.rise{animation:rise .8s ${EASE} both}
@keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
.fade{animation:fade .9s ${EASE} .55s both}
.fade2{animation:fade .9s ${EASE} .8s both}
@keyframes fade{from{opacity:0}to{opacity:1}}
.meter{transform-box:fill-box;transform-origin:0 50%;transform:scaleX(var(--lo));animation:meter 1s ease-in-out infinite alternate}
@keyframes meter{from{transform:scaleX(var(--lo))}to{transform:scaleX(var(--hi))}}
.played{clip-path:inset(0 38% 0 0);animation:sweep 10s linear infinite}
@keyframes sweep{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
.head{transform:translateX(${f1(0.62 * (R - L))}px);animation:head 10s linear infinite}
@keyframes head{from{transform:translateX(0)}to{transform:translateX(${R - L}px)}}`;

  const body = `${plate(W, H)}
<defs><pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="1" height="1" fill="#1A1C20"/></pattern></defs>
<rect x="1" y="40" width="${W - 2}" height="${H - 41}" fill="url(#dots)"/>
${type('mono', 'JMW SOFTWARE · JAMWARE RECORDS', L, 25, 9.5, { tracking: 0.18, fill: C.g400 }).svg}
${type('mono', 'WIN X64 · ARM64 · BS.1770-4', R, 25, 9.5, { tracking: 0.18, fill: C.g400, anchor: 'end' }).svg}
<rect x="${L}" y="36" width="${R - L}" height="1" fill="${C.hair}"/>
${m.svg}
${word.svg}
<g class="fade">${type('monoMedium', 'MASTERING CONSOLE FOR THE AI MUSIC ERA', 179, 172, 12.5, { tracking: 0.2, fill: C.signal }).svg}</g>
<g class="fade2">${type('mono', 'MUSIC, MANUFACTURED.', 179, 194, 10, { tracking: 0.2, fill: C.g400 }).svg}</g>
${meters}
<g fill="${C.bar}">${bars}</g>
<g class="played" fill="${C.signal}">${bars}</g>
${markers}
<g class="head"><rect x="${L - 0.5}" y="210" width="1.5" height="66" fill="${C.paper}"/><rect x="${L - 3.5}" y="207" width="7.5" height="7.5" fill="${C.paper}"/></g>
${times}
${crosshair(10, 10)}${crosshair(W - 10, 10)}${crosshair(10, H - 10)}${crosshair(W - 10, H - 10)}`;
  return svgDoc(W, H, 'J-Master: mastering console for the AI music era', css, body);
}

// ── section banners ─────────────────────────────────────────────────────
const W = 880, H = 116;
const WELL = { x: 596, y: 22, w: 256, h: 72 };

function section({ id, n, kicker, title, spec, motif }) {
  const t = type('display', title.replace(/\.$/, ''), 28, 76, 34, { tracking: 0.01, maxWidth: 520 });
  const dot = type('display', '.', 28 + t.width + 1, 76, t.size, { fill: C.signal });
  const m = motif(WELL.x, WELL.y, WELL.w, WELL.h);
  const css = `.in{animation:in .7s ${EASE} both}
@keyframes in{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:translateX(0)}}
${m.css}`;
  const body = `${plate(W, H)}
<rect x="28" y="0" width="34" height="3" fill="${C.signal}"/>
${type('monoMedium', n, 28, 30, 10.5, { tracking: 0.12, fill: C.signal }).svg}
${type('mono', kicker, 52, 30, 10.5, { tracking: 0.22, fill: C.g400 }).svg}
<g class="in">${t.svg}${dot.svg}</g>
${type('mono', spec, 28, 98, 9.5, { tracking: 0.16, fill: C.g400, maxWidth: 548 }).svg}
<clipPath id="well-${id}"><rect x="${WELL.x}" y="${WELL.y}" width="${WELL.w}" height="${WELL.h}"/></clipPath>
<rect x="${WELL.x}" y="${WELL.y}" width="${WELL.w}" height="${WELL.h}" fill="${C.well}" stroke="${C.hair}"/>
<g clip-path="url(#well-${id})">${m.svg}</g>
${type('mono', `FIG. ${n}`, WELL.x, WELL.y + WELL.h + 12, 7.5, { tracking: 0.2, fill: C.g500 }).svg}
${type('mono', m.caption, WELL.x + WELL.w, WELL.y + WELL.h + 12, 7.5, { tracking: 0.2, fill: C.g500, anchor: 'end' }).svg}
${crosshair(10, H - 10)}${crosshair(W - 10, H - 10)}`;
  const label = `${title.replace(/\.$/, '')}: ${spec.toLowerCase()}`;
  writeFileSync(`${OUT}/banner-${id}.svg`, svgDoc(W, H, label, css, body));
}

// FIG: a file drops into the frame, the frame lights, the track appears.
function motifDrop(x, y, w, h) {
  const fx = x + w / 2 - 50, fy = y + 12, fw = 100, fh = h - 24;
  let bars = '';
  for (let i = 0; i < 20; i++) {
    const a = 0.35 + 0.65 * Math.sin((i / 19) * Math.PI) * (0.6 + 0.4 * rnd(i + 7));
    const bh = 4 + a * (fh - 14);
    bars += `<rect x="${f1(fx + 9 + i * 4.3)}" y="${f1(fy + fh / 2 - bh / 2)}" width="2.2" height="${f1(bh)}"/>`;
  }
  const tx = x + w / 2 - 11, ty = fy + 6;
  return {
    caption: 'DROP · DECODE · ANALYSE',
    svg: `<rect class="df" x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="none" stroke="${C.signal}" stroke-dasharray="3 3"/>
<g class="dw" fill="${C.signal}">${bars}</g>
<g class="tile">
<path d="M${tx} ${ty}h15l7 7v21h-22z" fill="${C.g800}" stroke="${C.g400}"/>
<path d="M${tx + 15} ${ty}v7h7" fill="none" stroke="${C.g400}"/>
${type('monoMedium', 'WAV', tx + 11, ty + 23, 6.5, { anchor: 'middle', tracking: 0.05 }).svg}
</g>`,
    css: `.df{animation:df 4.8s infinite}
@keyframes df{0%,40%{stroke:${C.g600}}46%,82%{stroke:${C.signal}}100%{stroke:${C.g600}}}
.tile{opacity:0;animation:tile 4.8s ${EASE} infinite}
@keyframes tile{0%{opacity:0;transform:translateY(-40px)}14%{opacity:1;transform:translateY(-26px)}40%{opacity:1;transform:translateY(0)}50%,100%{opacity:0;transform:translateY(3px)}}
.dw{transform-box:fill-box;transform-origin:50% 50%;animation:dw 4.8s ${EASE} infinite}
@keyframes dw{0%,46%{opacity:0;transform:scaleY(0)}60%,88%{opacity:1;transform:scaleY(1)}100%{opacity:0;transform:scaleY(1)}}`,
  };
}

// FIG: three console knobs; needle and value arc move together.
function motifKnobs(x, y, w, h) {
  const knobs = [
    { label: 'TONE', offs: [62, 30, 48, 22, 62] },
    { label: 'DENSITY', offs: [70, 45, 26, 52, 70] },
    { label: 'WIDTH', offs: [50, 24, 58, 34, 50] },
  ];
  const r = 17;
  const cy = y + h / 2 - 5;
  const stops = [0, 25, 50, 75, 100];
  let svg = '';
  let css = '';
  knobs.forEach((k, i) => {
    const cx = x + 48 + i * 80;
    const pol = (a) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
    const [sx, sy] = pol(-135);
    const [ex, ey] = pol(135);
    const arc = `M${f1(sx)} ${f1(sy)}A${r} ${r} 0 1 1 ${f1(ex)} ${f1(ey)}`;
    const angle = (o) => -135 + 270 * (1 - o / 100);
    svg += `<path d="${arc}" pathLength="100" fill="none" stroke="${C.g700}" stroke-width="3"/>
<path class="ka${i}" d="${arc}" pathLength="100" fill="none" stroke="${C.signal}" stroke-width="3" stroke-dasharray="100 100" stroke-dashoffset="${k.offs[0]}"/>
<circle cx="${cx}" cy="${cy}" r="${r - 7}" fill="${C.g900}" stroke="${C.hair}"/>
<rect class="kn${i}" x="${cx - 1}" y="${cy - r + 5}" width="2" height="${r - 5}" fill="${C.signal}"/>
<rect x="${cx - 2.5}" y="${cy - 2.5}" width="5" height="5" fill="${C.signal}"/>
${type('mono', k.label, cx, cy + r + 13, 7, { anchor: 'middle', fill: C.g400, tracking: 0.14 }).svg}`;
    css += `.ka${i}{animation:ka${i} 7s ${EASE} infinite}
@keyframes ka${i}{${stops.map((s, j) => `${s}%{stroke-dashoffset:${k.offs[j]}}`).join('')}}
.kn${i}{transform-origin:${cx}px ${cy}px;transform:rotate(${f1(angle(k.offs[0]))}deg);animation:kn${i} 7s ${EASE} infinite}
@keyframes kn${i}{${stops.map((s, j) => `${s}%{transform:rotate(${f1(angle(k.offs[j]))}deg)}`).join('')}}
`;
  });
  return { caption: 'EIGHT MACROS · YOUR PRESETS', svg, css };
}

// FIG: the stereo image, collapsing to a line when the monitor goes MONO.
function motifListen(x, y, w, h) {
  const cx = x + 52, cy = y + h / 2, s = 27;
  let cloud = '', line = '';
  for (let i = 0; i < 64; i++) {
    const a = rnd(i) * Math.PI * 2;
    const rr = Math.sqrt(rnd(i + 99));
    const dx = Math.cos(a) * rr * 13;
    const dy = Math.sin(a) * rr * 22;
    cloud += `<rect x="${f1(cx + dx - 0.8)}" y="${f1(cy + dy - 0.8)}" width="1.6" height="1.6"/>`;
    line += `<rect x="${f1(cx - 0.8)}" y="${f1(cy + dy * 1.1 - 0.8)}" width="1.6" height="1.6"/>`;
  }
  const guides = `<path d="M${cx} ${cy - s}V${cy + s}M${cx - s} ${cy}H${cx + s}M${f1(cx - s * 0.7)} ${f1(cy - s * 0.7)}L${f1(cx + s * 0.7)} ${f1(cy + s * 0.7)}M${f1(cx + s * 0.7)} ${f1(cy - s * 0.7)}L${f1(cx - s * 0.7)} ${f1(cy + s * 0.7)}" stroke="${C.g700}" stroke-width="1"/>`;
  const chipX = x + 112;
  const chips = ['ST', 'MONO', 'SIDE'].map((label, k) => {
    const cxk = chipX + k * 46;
    return `<rect class="chip c${k}" x="${cxk}" y="${y + 12}" width="42" height="16" stroke="${C.g600}"/>`
      + type('monoMedium', label, cxk + 21, y + 23.5, 7.5, { anchor: 'middle', tracking: 0.08 }).svg;
  }).join('');
  const vu = [0, 1].map((k) => {
    const vx = chipX + k * 18;
    return `<rect x="${vx}" y="${y + 36}" width="12" height="26" fill="${C.g800}"/>`
      + `<rect class="vu" x="${vx}" y="${y + 36}" width="12" height="26" fill="${C.signal}" style="animation-duration:${k ? 0.9 : 1.2}s;animation-delay:-${k * 0.4}s"/>`;
  }).join('');
  return {
    caption: 'MON · NORM · VECTORSCOPE',
    svg: `${guides}<g class="cloud" fill="${C.signal}">${cloud}</g><g class="mono" fill="${C.signal}">${line}</g>${chips}${vu}
${type('mono', 'NORM', chipX + 44, y + 47, 7.5, { fill: C.g400, tracking: 0.14 }).svg}
${type('monoMedium', `${num(-3, 1)} DB`, chipX + 44, y + 60, 8.5, { fill: C.signal, tracking: 0.08 }).svg}`,
    css: `.cloud{transform-box:fill-box;transform-origin:50% 50%;animation:cloud 6s ${EASE} infinite}
@keyframes cloud{0%,38%{opacity:1;transform:scale(1,1)}46%,78%{opacity:0;transform:scale(.08,1.05)}86%,100%{opacity:1;transform:scale(1,1)}}
.mono{opacity:0;animation:mono 6s ${EASE} infinite}
@keyframes mono{0%,40%{opacity:0}46%,78%{opacity:1}84%,100%{opacity:0}}
.chip{fill:${C.g900}}
.c0{fill:${C.signal};animation:chip0 6s infinite}
.c1{animation:chip1 6s infinite}
@keyframes chip0{0%,40%{fill:${C.signal}}44%,82%{fill:${C.g900}}86%,100%{fill:${C.signal}}}
@keyframes chip1{0%,40%{fill:${C.g900}}44%,82%{fill:${C.signal}}86%,100%{fill:${C.g900}}}
.vu{transform-box:fill-box;transform-origin:50% 100%;transform:scaleY(.7);animation:vu 1s ease-in-out infinite alternate}
@keyframes vu{from{transform:scaleY(.45)}to{transform:scaleY(.9)}}`,
  };
}

// FIG: analysis reads the track; sections and the tempo appear behind it.
function motifAnalysis(x, y, w, h) {
  const L = x + 10, R = x + w - 10, cy = y + h / 2 + 7;
  const n = 58;
  const SCAN = 62;
  let bars = '';
  for (let i = 0; i < n; i++) {
    const p = i / n;
    const e = p < 0.2 ? 0.35 : p < 0.55 ? 0.95 : p < 0.72 ? 0.45 : p < 0.9 ? 1 : 0.4;
    const bh = 3 + e * (0.6 + 0.4 * rnd(i + 31)) * 34;
    bars += `<rect x="${f1(L + p * (R - L))}" y="${f1(cy - bh / 2)}" width="2" height="${f1(bh)}"/>`;
  }
  let css = '';
  const marks = [[0.2, 'PEAK'], [0.55, 'MID'], [0.72, 'PEAK'], [0.9, 'OUTRO']].map(([p, label], k) => {
    const mx = L + p * (R - L);
    const at = f1(p * SCAN);
    css += `.mk${k}{animation:mk${k} 6s infinite}
@keyframes mk${k}{0%,${at}%{opacity:0}${f1(p * SCAN + 1.5)}%,94%{opacity:1}100%{opacity:0}}
`;
    return `<g class="mk${k}"><rect x="${f1(mx)}" y="${y + 18}" width="1" height="${h - 24}" fill="${C.signal}"/>`
      + type('mono', label, mx + 3, y + 24, 6.5, { fill: C.g400, tracking: 0.12 }).svg + '</g>';
  }).join('');
  return {
    caption: 'TEMPO · SECTIONS · DIAGNOSIS',
    svg: `<g fill="${C.bar}">${bars}</g><g class="lit" fill="${C.signal}" fill-opacity=".85">${bars}</g>${marks}
<rect class="scan" x="${L}" y="${y + 4}" width="1.5" height="${h - 8}" fill="${C.paper}"/>
<g class="bpm">${type('monoMedium', '110.2 BPM', R, y + 12, 8, { anchor: 'end', tracking: 0.1 }).svg}</g>`,
    css: `${css}.lit{animation:lit 6s linear infinite}
@keyframes lit{0%{opacity:1;clip-path:inset(0 100% 0 0)}${SCAN}%{clip-path:inset(0 0 0 0)}94%{opacity:1;clip-path:inset(0 0 0 0)}100%{opacity:0;clip-path:inset(0 0 0 0)}}
.scan{opacity:0;animation:scan 6s linear infinite}
@keyframes scan{0%{opacity:1;transform:translateX(0)}${SCAN}%{opacity:1;transform:translateX(${R - L}px)}66%,100%{opacity:0;transform:translateX(${R - L}px)}}
.bpm{animation:bpm 6s infinite}
@keyframes bpm{0%,62%{opacity:0}66%,94%{opacity:1}100%{opacity:0}}`,
  };
}

// FIG: every deliverable from one render.
function motifFormats(x, y, w, h) {
  const tiles = ['WAV', 'FLAC', 'MP3', 'OPUS'];
  const tw = 52, th = 40, gap = 10;
  const x0 = x + (w - (tiles.length * tw + (tiles.length - 1) * gap)) / 2;
  const ty = y + (h - th) / 2;
  const svg = tiles.map((label, i) => {
    const tx = x0 + i * (tw + gap);
    const d = `animation-delay:${(i * 0.35).toFixed(2)}s`;
    return `<rect class="tl" style="${d}" x="${tx}" y="${ty}" width="${tw}" height="${th}" fill="${C.g900}" stroke="${C.signal}"/>`
      + `<g class="tt" style="${d}">${type('monoMedium', label, tx + tw / 2, ty + th / 2 + 3, 9.5, { anchor: 'middle', tracking: 0.1 }).svg}</g>`
      + `<rect class="tk" style="${d}" x="${tx + tw - 9}" y="${ty + 4}" width="5" height="5" fill="${C.signal}"/>`;
  }).join('');
  return {
    caption: 'ONE RENDER · EVERY FORMAT',
    svg,
    css: `.tl{animation:tl 4.4s infinite both}
@keyframes tl{0%{stroke:${C.g700}}8%,78%{stroke:${C.signal}}90%,100%{stroke:${C.g700}}}
.tt{animation:tt 4.4s infinite both}
@keyframes tt{0%{opacity:.35}8%,78%{opacity:1}90%,100%{opacity:.35}}
.tk{animation:tk 4.4s infinite both}
@keyframes tk{0%,6%{opacity:0}10%,78%{opacity:1}90%,100%{opacity:0}}`,
  };
}

// FIG: two paths, one core. The live worklet and the export worker run
// the same DSP, so what you hear is what you get.
function motifEngine(x, y, w, h) {
  const lanes = [y + 21, y + 45];
  const bw = 50, bh = 16;
  const lx = x + 10, cx0 = x + 103, rx = x + w - 10 - bw;
  const ins = ['LIVE', 'EXPORT'];
  const outs = ['SPEAKERS', 'FILE'];
  const box = (bx, cy, label, hot) =>
    `<rect x="${bx}" y="${cy - bh / 2}" width="${bw}" height="${bh}" fill="${C.well}" stroke="${hot ? C.signal : C.g600}"/>`
    + type('monoMedium', label, bx + bw / 2, cy + 2.5, 6.5, { anchor: 'middle', fill: hot ? C.paper : C.g300, tracking: 0.08 }).svg;
  const flows = lanes.map((ly) =>
    `<path class="flow" d="M${lx + bw} ${ly}H${cx0}M${cx0 + bw} ${ly}H${rx}" stroke="${C.signal}" stroke-width="1.5" stroke-dasharray="3 3"/>`).join('');
  const coreTop = lanes[0] - bh / 2 - 4, coreH = lanes[1] - lanes[0] + bh + 8;
  let bars = '';
  [0.55, 0.9, 0.7, 1, 0.6].forEach((v, i) => {
    bars += `<rect class="cb" style="animation-delay:-${(i * 0.23).toFixed(2)}s" x="${cx0 + 13 + i * 5.5}" y="${f1(lanes[1] + 4 - 14)}" width="3" height="14" fill="${C.signal}"/>`;
  });
  return {
    caption: 'WYSIWYG DSP',
    svg: `${flows}
${ins.map((l, i) => box(lx, lanes[i], l, false)).join('')}
${outs.map((l, i) => box(rx, lanes[i], l, false)).join('')}
<rect x="${cx0}" y="${coreTop}" width="${bw}" height="${coreH}" fill="${C.g900}" stroke="${C.signal}"/>
${type('monoMedium', 'DSP', cx0 + bw / 2, lanes[0] + 1, 8, { anchor: 'middle', tracking: 0.1 }).svg}
${type('mono', 'CORE', cx0 + bw / 2, lanes[0] + 10, 6, { anchor: 'middle', fill: C.g400, tracking: 0.14 }).svg}
${bars}
${type('mono', 'SAME CODE, BOTH PATHS', x + w / 2, y + h - 6, 6.5, { anchor: 'middle', fill: C.g500, tracking: 0.14 }).svg}`,
    css: `.flow{animation:flow .7s linear infinite}
@keyframes flow{from{stroke-dashoffset:0}to{stroke-dashoffset:-12}}
.cb{transform-box:fill-box;transform-origin:50% 100%;transform:scaleY(.7);animation:cb .9s ease-in-out infinite alternate}
@keyframes cb{from{transform:scaleY(.3)}to{transform:scaleY(1)}}`,
  };
}

// FIG: the loudness solve settling onto its target.
function motifProof(x, y, w, h) {
  const L = x + 16, R = x + w - 16, base = y + h - 20;
  const lo = -22, hi = -8;
  const X = (v) => L + ((v - lo) / (hi - lo)) * (R - L);
  let ticks = '';
  for (let v = lo; v <= hi; v += 1) {
    const major = v % 4 === 0;
    ticks += `<rect x="${f1(X(v))}" y="${base - (major ? 7 : v % 2 === 0 ? 4 : 2)}" width="1" height="${major ? 7 : v % 2 === 0 ? 4 : 2}" fill="${C.g600}"/>`;
    if (major) ticks += type('mono', num(v), X(v), base + 11, 6.5, { anchor: 'middle', fill: C.g500 }).svg;
  }
  const target = X(-11.5);
  const settle = -11.58;
  const path = [-20, -9.6, -12.7, -11.1, -11.72, -11.53, settle, settle, -20];
  const pct = [0, 12, 22, 30, 37, 43, 50, 92, 100];
  const dx = (v) => f1(X(v) - X(-20));
  return {
    caption: `EXPORT ${num(settle, 2)} ON A ${num(-11.5, 1)} TARGET`,
    svg: `<rect x="${L}" y="${base}" width="${R - L}" height="1" fill="${C.g600}"/>${ticks}
<path d="M${f1(target - 4)} ${y + 12}h8l-4 6z" fill="${C.signal}"/>
${type('mono', 'TARGET', target, y + 10, 6.5, { anchor: 'middle', fill: C.signal, tracking: 0.12 }).svg}
<g class="needle" transform="translate(${dx(settle)} 0)">
<rect x="${f1(X(-20) - 0.75)}" y="${y + 20}" width="1.5" height="${base - y - 20}" fill="${C.paper}"/>
<rect x="${f1(X(-20) - 3)}" y="${y + 18}" width="6" height="6" fill="${C.paper}"/>
</g>
<g class="read">${type('monoMedium', `${num(settle, 2)} LUFS`, x + 16, y + 14, 8.5, { tracking: 0.08 }).svg}</g>`,
    css: `.needle{animation:needle 6.5s ${EASE} infinite}
@keyframes needle{${path.map((v, i) => `${pct[i]}%{transform:translateX(${dx(v)}px)}`).join('')}}
.read{animation:read 6.5s infinite}
@keyframes read{0%,48%{opacity:0}54%,90%{opacity:1}96%,100%{opacity:0}}`,
  };
}

// FIG: build it yourself or grab the installer.
function motifInstall(x, y, w, h) {
  const tx = x + 14, ty = y + 22;
  const cmd = '> npm run dist';
  const t = type('monoMedium', cmd, tx, ty, 10);
  const steps = Array.from(cmd).length;
  const end = f1(t.width + 3);
  return {
    caption: 'WINDOWS X64 + ARM64',
    svg: `<g class="typing">${t.svg}</g>
<rect class="cursor" x="${tx}" y="${ty - 9}" width="6" height="11" fill="${C.signal}"/>
<rect x="${tx}" y="${ty + 14}" width="${w - 28}" height="4" fill="${C.g800}"/>
<rect class="bar" x="${tx}" y="${ty + 14}" width="${w - 28}" height="4" fill="${C.signal}"/>
<g class="done"><rect x="${tx}" y="${ty + 26}" width="6" height="6" fill="${C.run}"/>
${type('mono', 'setup + portable .exe in release/', tx + 11, ty + 32, 7.5, { fill: C.g300, tracking: 0.04 }).svg}</g>`,
    css: `.typing{animation:typing 6s infinite}
@keyframes typing{0%{clip-path:inset(0 100% 0 0);animation-timing-function:steps(${steps},end)}34%,100%{clip-path:inset(0 0 0 0)}}
.cursor{opacity:0;animation:cursor 6s infinite}
@keyframes cursor{0%{opacity:1;transform:translateX(0);animation-timing-function:steps(${steps},end)}34%{opacity:1;transform:translateX(${end}px)}40%{opacity:0}46%{opacity:1}52%,100%{opacity:0;transform:translateX(${end}px)}}
.bar{transform-box:fill-box;transform-origin:0 50%;animation:bar 6s ${EASE} infinite}
@keyframes bar{0%,36%{transform:scaleX(0)}78%,96%{transform:scaleX(1)}100%{transform:scaleX(0)}}
.done{animation:done 6s infinite}
@keyframes done{0%,78%{opacity:0}82%,96%{opacity:1}100%{opacity:0}}`,
  };
}

// FIG: the seal.
function motifLicense(x, y, w, h) {
  const cx = x + 44, cy = y + h / 2;
  let ticks = '';
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    const r1 = 24, r2 = i % 3 === 0 ? 29 : 27;
    ticks += `M${f1(cx + Math.cos(a) * r1)} ${f1(cy + Math.sin(a) * r1)}L${f1(cx + Math.cos(a) * r2)} ${f1(cy + Math.sin(a) * r2)}`;
  }
  return {
    caption: 'GPL-3.0 · OPEN SOURCE',
    svg: `<circle cx="${cx}" cy="${cy}" r="31" fill="none" stroke="${C.g600}"/>
<circle cx="${cx}" cy="${cy}" r="21" fill="${C.g900}" stroke="${C.hair}"/>
<path class="seal" d="${ticks}" stroke="${C.g500}" stroke-width="1"/>
${type('display', 'GPL', cx, cy + 2, 11, { anchor: 'middle' }).svg}
${type('monoMedium', '3.0', cx, cy + 12, 7.5, { anchor: 'middle', fill: C.signal }).svg}
${type('mono', 'COPYLEFT KEEPS FORKS OPEN', x + 90, y + 28, 7.5, { fill: C.g300, tracking: 0.12 }).svg}
${type('mono', '© JMW SOFTWARE', x + 90, y + 44, 7.5, { fill: C.g400, tracking: 0.12 }).svg}
${type('mono', '© JAMWARE RECORDS', x + 90, y + 56, 7.5, { fill: C.g400, tracking: 0.12 }).svg}`,
    css: `.seal{transform-origin:${cx}px ${cy}px;animation:seal 40s linear infinite}
@keyframes seal{from{transform:rotate(0)}to{transform:rotate(360deg)}}`,
  };
}

writeFileSync(`${OUT}/banner-hero.svg`, hero());
const SECTIONS = [
  { id: 'drop', n: '01', kicker: 'WORKFLOW', title: 'Drop it in.', spec: 'ANY WAV · FLAC · MP3 · DROP ANYWHERE · WHOLE ALBUMS QUEUE IN BATCH', motif: motifDrop },
  { id: 'console', n: '02', kicker: 'THE CONSOLE', title: 'Shape it.', spec: 'EIGHT MACROS · YOUR PRESETS · 6-BAND EQ · STEM LANES · A/B · UNDO', motif: motifKnobs },
  { id: 'listen', n: '03', kicker: 'MONITORING', title: 'Hear it honestly.', spec: 'SPLIT COMPARE · LOOP · REF · MON MATRIX · NORM · VECTORSCOPE', motif: motifListen },
  { id: 'intelligence', n: '04', kicker: 'ANALYSIS', title: 'Let it listen.', spec: 'TEMPO · SECTIONS · DIAGNOSIS · AUTO-MASTER · REFERENCE MATCH', motif: motifAnalysis },
  { id: 'formats', n: '05', kicker: 'DELIVERY', title: 'Ship it.', spec: 'WAV · FLAC · MP3 · OPUS · ALSO SAVE · COVER ART · CD IMAGE', motif: motifFormats },
  { id: 'architecture', n: '06', kicker: 'ENGINE', title: 'Under the hood.', spec: 'ONE DSP CORE · PREVIEW = EXPORT · BS.1770-4 METERING', motif: motifEngine },
  { id: 'verification', n: '07', kicker: 'PROOF', title: 'Measured, not claimed.', spec: 'EVERY NUMBER BELOW CAME FROM THE RUNNING APP', motif: motifProof },
  { id: 'start', n: '08', kicker: 'INSTALL', title: 'Get it.', spec: 'WINDOWS INSTALLER + PORTABLE · OR BUILD FROM SOURCE', motif: motifInstall },
  { id: 'license', n: '09', kicker: 'OPEN SOURCE', title: 'License.', spec: `GPL-3.0 · © JMW SOFTWARE · JAMWARE RECORDS`, motif: motifLicense },
];
for (const s of SECTIONS) section(s);
console.log(`banners written to ${OUT}/: hero + ${SECTIONS.length} sections`);
