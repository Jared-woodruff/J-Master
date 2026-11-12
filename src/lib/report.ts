// The master's spec sheet: one self-contained HTML page (no scripts, no
// network) saved beside an export. What was measured, what the chain did
// to get there, how each platform will play it, and the waveform and
// loudness lane of the file itself. Pure: a LastExport in, a string out.
import { PLATFORMS, eqBandActive, type AdvEqBand, type MacroValues } from '../audio/dsp/params';
import type { LastExport } from '../state/store';

declare const __APP_VERSION__: string | undefined;

const esc = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const n1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '--');
const signed = (v: number, d = 1): string => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
const lufs = (v: number): string => (Number.isFinite(v) && v > -70 ? `${v.toFixed(1)} LUFS` : 'UNDER -70 LUFS');
const dbtp = (v: number): string => (Number.isFinite(v) && v > -150 ? `${v.toFixed(2)} dBTP` : 'SILENT');

function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function sizeText(bytes: number): string {
  return bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function hz(f: number): string {
  return f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`;
}

function formatText(s: LastExport['stats']): string {
  const rate = `${+(s.sampleRate / 1000).toFixed(1)} kHz`;
  if (s.format === 'mp3') return `MP3 · ${s.mp3Kbps ?? 320} kbps CBR · ${rate}`;
  if (s.format === 'opus') return `OPUS · ${s.opusKbps ?? 192} kbps · ${rate}`;
  const depth = s.bitDepth === 32 ? '32-BIT FLOAT' : `${s.bitDepth}-BIT`;
  const dither = s.bitDepth === 16 ? ` · ${s.dither === 'shaped' ? 'NOISE-SHAPED' : 'TPDF'} DITHER` : '';
  return `${s.format.toUpperCase()} · ${rate} · ${depth}${dither}`;
}

interface Check { label: string; value: string; flag: boolean }

function row(label: string, value: string, flag = false): string {
  return `<div class="row"><span class="k">${esc(label)}</span><span class="leader"></span>`
    + `<span class="v${flag ? ' flag' : ''}">${esc(value)}</span></div>`;
}

function waveSvg(wave: { mins: number[]; maxs: number[] }, ceilingLin: number): string {
  const n = Math.min(wave.mins.length, wave.maxs.length);
  if (n === 0) return '';
  const W = 896, H = 120, mid = H / 2;
  let d = '';
  for (let i = 0; i < n; i++) {
    const x = ((i + 0.5) / n) * W;
    const y1 = mid - Math.max(-1, Math.min(1, wave.maxs[i])) * (mid - 2);
    const y2 = mid - Math.max(-1, Math.min(1, wave.mins[i])) * (mid - 2);
    d += `M${x.toFixed(1)} ${y1.toFixed(1)}V${Math.max(y2, y1 + 0.6).toFixed(1)}`;
  }
  const c = Math.min(1, ceilingLin) * (mid - 2);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Waveform of the master" preserveAspectRatio="none">`
    + `<line x1="0" x2="${W}" y1="${mid}" y2="${mid}" class="axis"/>`
    + `<path d="${d}" class="wave" stroke-width="${Math.max(0.6, (W / n) * 0.8).toFixed(2)}"/>`
    + `<line x1="0" x2="${W}" y1="${(mid - c).toFixed(1)}" y2="${(mid - c).toFixed(1)}" class="ceil"/>`
    + `<line x1="0" x2="${W}" y1="${(mid + c).toFixed(1)}" y2="${(mid + c).toFixed(1)}" class="ceil"/>`
    + `</svg>`;
}

function laneSvg(lane: number[], stepSec: number, targetLufs: number, durationSec: number): string {
  const vals = lane.filter((v) => Number.isFinite(v) && v > -70);
  if (vals.length < 2) return '';
  const W = 896, H = 96, padT = 6, padB = 16;
  const hi = Math.max(targetLufs + 4, Math.max(...vals) + 1);
  const lo = Math.max(-48, Math.min(targetLufs - 14, Math.min(...vals) - 1));
  const y = (v: number) => padT + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - padT - padB);
  const total = Math.max(durationSec, lane.length * stepSec);
  let pts = '';
  let open = false;
  lane.forEach((v, i) => {
    if (!Number.isFinite(v) || v <= -70) { open = false; return; }
    const x = (((i + 0.5) * stepSec) / total) * W;
    pts += `${open ? 'L' : 'M'}${x.toFixed(1)} ${y(v).toFixed(1)}`;
    open = true;
  });
  const ty = y(targetLufs).toFixed(1);
  let ticks = '';
  const every = total > 600 ? 120 : total > 240 ? 60 : 30;
  for (let t = every; t < total - every / 3; t += every) {
    const x = ((t / total) * W).toFixed(1);
    ticks += `<line x1="${x}" x2="${x}" y1="${H - padB}" y2="${H - padB + 4}" class="axis"/>`
      + `<text x="${x}" y="${H - 2}" text-anchor="middle">${clock(t)}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Short-term loudness of the master">`
    + `<line x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}" class="axis"/>${ticks}`
    + `<line x1="0" x2="${W}" y1="${ty}" y2="${ty}" class="target"/>`
    + `<text x="2" y="${(+ty - 4).toFixed(1)}" class="t-target">TARGET ${targetLufs.toFixed(1)}</text>`
    + `<path d="${pts}" class="lane"/>`
    + `<text x="${W - 2}" y="${padT + 8}" text-anchor="end">${hi.toFixed(0)} LUFS</text>`
    + `<text x="${W - 2}" y="${H - padB - 4}" text-anchor="end">${lo.toFixed(0)}</text>`
    + `</svg>`;
}

const MACROS: [keyof MacroValues, string, boolean][] = [
  ['tone', 'TONE', true], ['shape', 'SHAPE', true], ['air', 'AIR', false], ['smooth', 'SMOOTH', false],
  ['character', 'CHARACTER', false], ['density', 'DENSITY', false], ['impact', 'IMPACT', true], ['width', 'WIDTH', false],
];

function bandText(b: AdvEqBand): string {
  const type = { lowshelf: 'LOW SHELF', peak: 'BELL', highshelf: 'HIGH SHELF', highpass: 'HIGH-PASS', lowpass: 'LOW-PASS' }[b.type];
  const where = b.ch && b.ch !== 'stereo' ? ` · ${b.ch.toUpperCase()} ONLY` : '';
  const gain = b.type === 'highpass' || b.type === 'lowpass' ? '' : ` ${signed(b.gainDb)} dB`;
  const q = b.type === 'peak' ? ` · Q ${b.q.toFixed(2)}` : '';
  return `${type} ${hz(b.freq)}${gain}${q}${where}`;
}

export function buildReport(x: LastExport): string {
  const s = x.stats;
  const c = x.console;
  const target = s.targetLufs ?? c.targetLufs;
  const ceiling = s.ceilingDb ?? c.ceilingDb;
  const plr = s.plr ?? s.truePeakDb - s.integratedLufs;
  const lossy = s.format === 'mp3' || s.format === 'opus';
  const srcPlr = x.source.truePeakDb - x.source.lufs;

  // ── the verdict, one line per thing a mastering engineer would check ──
  const checks: Check[] = [];
  if (s.loudnessMeasured === false) {
    checks.push({ label: 'LOUDNESS', value: 'TOO QUIET TO MEASURE · RENDERED AT UNITY GAIN', flag: true });
  } else if (s.targetReached === false) {
    checks.push({
      label: 'LOUDNESS',
      value: `${lufs(s.integratedLufs)} · ${(target - s.integratedLufs).toFixed(1)} LU SHORT OF ${target.toFixed(1)} UNDER THIS CEILING`, flag: true,
    });
  } else {
    checks.push({ label: 'LOUDNESS', value: `${lufs(s.integratedLufs)} · ON TARGET (${target.toFixed(1)})`, flag: false });
  }
  const over = s.truePeakDb - ceiling;
  checks.push(over > 0.05
    ? { label: 'TRUE PEAK', value: `${dbtp(s.truePeakDb)} · ${over.toFixed(2)} dB OVER THE ${ceiling.toFixed(1)} CEILING`, flag: true }
    : { label: 'TRUE PEAK', value: `${dbtp(s.truePeakDb)} · UNDER THE ${ceiling.toFixed(1)} CEILING`, flag: false });
  if (lossy && s.codecPeakDb !== undefined) {
    const codecOver = s.codecPeakDb - ceiling;
    checks.push({
      label: `${s.format.toUpperCase()} DECODED`,
      value: codecOver > 0.2
        ? `${dbtp(s.codecPeakDb)} · THE CODEC OVERSHOOTS BY ${codecOver.toFixed(1)} dB · A LOWER CEILING LEAVES IT ROOM`
        : `${dbtp(s.codecPeakDb)} · THE CODEC STAYS UNDER THE CEILING`,
      flag: codecOver > 0.2,
    });
  }
  checks.push({
    label: 'LIMITER',
    value: s.limiterMaxGrDb > 0.05
      ? `${s.limiterMaxGrDb.toFixed(1)} dB AT ITS DEEPEST${s.limiterMaxGrDb > 6 ? ' · WORKING HARD' : ''}`
      : 'NEVER TOUCHED THE SIGNAL',
    flag: s.limiterMaxGrDb > 6,
  });
  if (c.clipMode !== 'off') {
    checks.push({
      label: `CLIP · ${c.clipMode.toUpperCase()}`,
      value: (s.clipMaxGrDb ?? 0) > 0.05 ? `${(s.clipMaxGrDb ?? 0).toFixed(1)} dB OFF THE TALLEST PEAK` : 'NOTHING REACHED IT',
      flag: false,
    });
  }
  checks.push({
    label: 'DYNAMICS',
    value: `PLR ${plr.toFixed(1)} dB${s.lra !== undefined ? ` · LRA ${s.lra.toFixed(1)} LU` : ''}${plr < 7 ? ' · VERY DENSE' : ''}`,
    flag: plr < 6,
  });
  const flagged = checks.filter((k) => k.flag).length;

  // ── what the chain did ──
  const chain: string[] = [];
  const presetLine = x.presetName
    ? `${x.presetName}${Math.abs(c.presetAmount - 1) > 0.005 ? ` AT ${Math.round(c.presetAmount * 100)}%` : ''}`
    : 'CUSTOM';
  chain.push(row('PRESET', presetLine));
  chain.push(row('TARGET · CEILING', `${target.toFixed(1)} LUFS · ${ceiling.toFixed(1)} dBTP`));
  chain.push(row('GAIN INTO THE LIMITER', `${signed(s.appliedGainDb)} dB`));
  chain.push(row('CLIP', c.clipMode === 'off' ? 'OUT' : c.clipMode.toUpperCase()));
  const bands = c.advEq.filter((b) => eqBandActive(b));
  chain.push(row('EQ', bands.length === 0 ? 'FLAT' : `${bands.length} BAND${bands.length > 1 ? 'S' : ''}`));
  for (const b of bands) chain.push(row('', bandText(b)));
  const stems = (['bass', 'drums', 'vocal', 'air'] as const).filter((k) => Math.abs(c.stems[k]) >= 0.05);
  chain.push(row('LANES', stems.length === 0 ? 'ALL AT 0 dB' : stems.map((k) => `${k.toUpperCase()} ${signed(c.stems[k])}`).join(' · ')));
  if (c.matchEqGains.some((g) => Math.abs(g) >= 0.05)) chain.push(row('MATCH EQ', 'FITTED TO A REFERENCE'));

  const fixes: string[] = [];
  if (x.repaired) fixes.push(row('TEMPO', `DRIFT REPAIRED · STEADY ${x.tempoBpm.toFixed(1)} BPM`));
  else if (x.tempoBpm > 0) fixes.push(row('TEMPO', `${x.tempoBpm.toFixed(1)} BPM`));
  if (c.sourceFix !== 'none') {
    fixes.push(row('CHANNELS', c.sourceFix === 'flip' ? 'ONE SIDE’S POLARITY FLIPPED BACK' : `${c.sourceFix.toUpperCase()} SIDE COPIED TO BOTH`));
  }
  if (c.bassMono) fixes.push(row('BASS', 'MONO BELOW 140 Hz'));
  if (Math.abs(c.balanceDb) >= 0.05) fixes.push(row('BALANCE', `${signed(c.balanceDb)} dB TOWARD ${c.balanceDb > 0 ? 'RIGHT' : 'LEFT'}`));
  if (c.airRestore > 0.005) fixes.push(row('AIR RESTORE', `${Math.round(c.airRestore * 100)}% ABOVE ${hz(c.airRestoreHz)}`));
  if (c.trimStartSec > 0 || c.trimEndSec > 0) {
    fixes.push(row('TOP & TAIL', `${clock(c.trimStartSec)} TO ${c.trimEndSec > 0 ? clock(c.trimEndSec) : 'THE END'} OF ${clock(x.source.durationSec)}`));
  }
  if (c.fadeInSec > 0.0005) fixes.push(row('FADE IN', `${c.fadeInSec < 1 ? `${Math.round(c.fadeInSec * 1000)} MS` : `${c.fadeInSec.toFixed(1)} S`} · ${c.fadeInCurve.toUpperCase()}`));
  if (c.fadeOutSec > 0.0005) fixes.push(row('FADE OUT', `${c.fadeOutSec < 1 ? `${Math.round(c.fadeOutSec * 1000)} MS` : `${c.fadeOutSec.toFixed(1)} S`} · ${c.fadeOutCurve.toUpperCase()}`));
  if (fixes.length === 0) fixes.push(row('CORRECTIONS', 'NONE NEEDED'));

  const macroCells = MACROS.map(([k, label, bipolar]) => {
    const v = c.macros[k];
    const text = k === 'width' ? `${Math.round(v * 100)}%` : `${bipolar && v > 0 ? '+' : ''}${Math.round(v * 100)}`;
    const neutral = k === 'width' ? Math.abs(v - 1) < 0.005 : Math.abs(v) < 0.005;
    return `<div class="cell${neutral ? ' idle' : ''}"><span class="spec">${label}</span><span class="num">${text}</span></div>`;
  }).join('');

  // ── delivery: what each platform's normalization does with it ──
  const delivery = PLATFORMS.map((p) => {
    const delta = s.integratedLufs - p.targetLufs;
    const level = delta > 0.2 ? `TURNED DOWN ${delta.toFixed(1)} dB`
      : delta < -0.2 ? `PLAYS ${Math.abs(delta).toFixed(1)} dB UNDER THEIR LEVEL`
      : 'PLAYS AS MASTERED';
    const peakOver = s.truePeakDb > p.ceilingDb + 0.05;
    return row(`${p.name} · ${p.targetLufs} LUFS`, `${level}${peakOver ? ` · PEAKS OVER THEIR ${p.ceilingDb.toFixed(1)} dBTP` : ''}`, peakOver);
  }).join('');

  const tags = ([
    ['TITLE', x.title], ['ARTIST', x.meta.artist], ['ALBUM', x.meta.album], ['YEAR', x.meta.year],
    ['GENRE', x.meta.genre], ['CATALOG', x.meta.catalog],
  ] as const).filter(([, v]) => v).map(([k, v]) => row(k, v)).join('');

  const when = new Date(x.when);
  const date = Number.isNaN(when.getTime()) ? x.when : when.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const version = typeof __APP_VERSION__ === 'string' ? ` ${__APP_VERSION__}` : '';
  const srcSpec = `${+(x.source.sampleRate / 1000).toFixed(1)} kHz${x.source.bitDepth ? ` · ${x.source.bitDepth}-BIT` : ''}`;
  const wave = x.report ? waveSvg(x.report.wave, Math.pow(10, ceiling / 20)) : '';
  const lane = x.report ? laneSvg(x.report.lane, x.report.laneStepSec, target, s.durationSec) : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="J-Master${version}">
<title>${esc(x.title || x.fileName)} · Master report</title>
<style>
:root{--paper:#FBFAF7;--ink:#0D0E10;--mute:#6C6E72;--line:#D8D5CC;--signal:#FF4D00}
*{box-sizing:border-box}
html{background:var(--paper)}
body{margin:0;color:var(--ink);font:12px/1.5 "IBM Plex Mono",ui-monospace,"Cascadia Mono",Consolas,monospace}
.sheet{max-width:960px;margin:0 auto;padding:40px 32px 48px}
.spec{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
h1{margin:6px 0 2px;font:800 30px/1.08 "Archivo","Arial Black","Segoe UI Black","Helvetica Neue",sans-serif;font-stretch:125%;text-transform:uppercase;overflow-wrap:anywhere}
h2{margin:0;font:inherit;font-size:10px;letter-spacing:.14em;text-transform:uppercase}
header{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;padding-bottom:16px;border-bottom:1px solid var(--ink)}
header .right{text-align:right;white-space:nowrap}
.hero{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid var(--line)}
.hero .cell{padding:16px 16px 14px 0;border-right:1px solid var(--line)}
.hero .cell+.cell{padding-left:16px}
.hero .cell:last-child{border-right:0}
.big{display:block;margin-top:2px;font:800 26px/1.15 "Archivo","Arial Black","Segoe UI Black","Helvetica Neue",sans-serif;font-stretch:125%}
.big small{font:500 11px "IBM Plex Mono",ui-monospace,Consolas,monospace;letter-spacing:.08em;color:var(--mute);margin-left:6px}
section{padding:18px 0 4px}
.head{display:flex;justify-content:space-between;align-items:baseline;padding-bottom:8px;margin-bottom:8px;border-bottom:1px solid var(--line)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:0 40px}
.row{display:flex;align-items:baseline;gap:8px;padding:2px 0;text-transform:uppercase;letter-spacing:.04em}
.row .k{color:var(--mute);white-space:nowrap}
.row .leader{flex:1;min-width:16px;border-bottom:1px dotted var(--line);transform:translateY(-3px)}
.row .v{text-align:right;overflow-wrap:anywhere}
.flag{color:var(--signal)}
.check{display:flex;align-items:baseline;gap:10px;padding:3px 0;text-transform:uppercase;letter-spacing:.04em}
.lamp{flex:none;width:8px;height:8px;border:1px solid var(--ink);background:var(--ink);transform:translateY(-1px)}
.lamp.on{border-color:var(--signal);background:var(--signal)}
.check .k{flex:none;width:150px;color:var(--mute)}
.macros{display:grid;grid-template-columns:repeat(8,1fr);border:1px solid var(--line);margin-bottom:10px}
.macros .cell{padding:8px 10px;border-right:1px solid var(--line)}
.macros .cell:last-child{border-right:0}
.macros .num{display:block;font-size:15px;font-weight:600}
.macros .idle .num{color:var(--mute);font-weight:400}
svg{display:block;width:100%;height:auto}
svg .axis{stroke:var(--line);stroke-width:1}
svg .wave{stroke:var(--ink);fill:none}
svg .ceil{stroke:var(--mute);stroke-width:1;stroke-dasharray:2 4}
svg .lane{stroke:var(--ink);stroke-width:1.4;fill:none;stroke-linejoin:round}
svg .target{stroke:var(--signal);stroke-width:1}
svg text{font:9px "IBM Plex Mono",ui-monospace,Consolas,monospace;fill:var(--mute);letter-spacing:.08em}
svg .t-target{fill:var(--signal)}
.plot{border:1px solid var(--line);padding:8px 8px 4px;margin-bottom:8px}
table{width:100%;border-collapse:collapse;text-transform:uppercase;letter-spacing:.04em}
th,td{padding:4px 0;text-align:right;border-bottom:1px solid var(--line);font-weight:400}
th{font-size:10px;letter-spacing:.14em;color:var(--mute)}
th:first-child,td:first-child{text-align:left;color:var(--mute);width:22%}
th:nth-child(2),td:nth-child(2){width:22%}
th:nth-child(4),td:nth-child(4){width:14%}
table{table-layout:fixed}
td{overflow-wrap:anywhere}
footer{display:flex;justify-content:space-between;gap:16px;margin-top:22px;padding-top:12px;border-top:1px solid var(--ink)}
@media (max-width:720px){.cols{grid-template-columns:1fr}.hero{grid-template-columns:1fr 1fr}.hero .cell:nth-child(2){border-right:0}.macros{grid-template-columns:repeat(4,1fr)}header{flex-direction:column;align-items:flex-start}header .right{text-align:left}.check .k{width:110px}}
@media print{.sheet{padding:0}@page{margin:14mm}section{break-inside:avoid}}
</style>
</head>
<body>
<div class="sheet">
<header>
  <div>
    <div class="spec">J-MASTER · MASTER REPORT</div>
    <h1>${esc(x.title || x.fileName.replace(/\.[^.]+$/, ''))}</h1>
    <div class="spec">${esc(x.fileName)}</div>
  </div>
  <div class="right">
    <div class="spec">${esc(date)}</div>
    <div class="spec${flagged > 0 ? ' flag' : ''}">${flagged === 0 ? 'ALL CHECKS CLEAR' : `${flagged} TO LOOK AT`}</div>
  </div>
</header>

<div class="hero">
  <div class="cell"><span class="spec">INTEGRATED</span><span class="big">${n1(s.integratedLufs)}<small>LUFS</small></span></div>
  <div class="cell"><span class="spec">TRUE PEAK</span><span class="big">${Number.isFinite(s.truePeakDb) ? s.truePeakDb.toFixed(2) : '--'}<small>dBTP</small></span></div>
  <div class="cell"><span class="spec">LOUDNESS RANGE</span><span class="big">${s.lra !== undefined ? n1(s.lra) : '--'}<small>LU</small></span></div>
  <div class="cell"><span class="spec">PEAK TO LOUDNESS</span><span class="big">${n1(plr)}<small>dB</small></span></div>
</div>

<section>
  <div class="head"><h2>Checks</h2><span class="spec">EBU R128 · ITU-R BS.1770-4</span></div>
  ${checks.map((k) => `<div class="check"><span class="lamp${k.flag ? ' on' : ''}"></span><span class="k">${esc(k.label)}</span><span class="${k.flag ? 'flag' : ''}">${esc(k.value)}</span></div>`).join('\n  ')}
</section>
${wave || lane ? `
<section>
  <div class="head"><h2>The master</h2><span class="spec">${clock(s.durationSec)} · PEAKS, THEN SHORT-TERM LOUDNESS</span></div>
  ${wave ? `<div class="plot">${wave}</div>` : ''}
  ${lane ? `<div class="plot">${lane}</div>` : ''}
</section>` : ''}

<section>
  <div class="head"><h2>Source to master</h2><span class="spec">${esc(x.sourceName)}</span></div>
  <table>
    <tr><th></th><th>SOURCE</th><th>MASTER</th><th>CHANGE</th></tr>
    <tr><td>INTEGRATED</td><td>${lufs(x.source.lufs)}</td><td>${lufs(s.integratedLufs)}</td><td>${x.source.lufs > -70 ? `${signed(s.integratedLufs - x.source.lufs)} LU` : ''}</td></tr>
    <tr><td>TRUE PEAK</td><td>${dbtp(x.source.truePeakDb)}</td><td>${dbtp(s.truePeakDb)}</td><td>${x.source.truePeakDb > -150 ? `${signed(s.truePeakDb - x.source.truePeakDb)} dB` : ''}</td></tr>
    <tr><td>LOUDNESS RANGE</td><td>${n1(x.source.lra)} LU</td><td>${s.lra !== undefined ? `${n1(s.lra)} LU` : ''}</td><td>${s.lra !== undefined ? `${signed(s.lra - x.source.lra)} LU` : ''}</td></tr>
    <tr><td>PEAK TO LOUDNESS</td><td>${n1(srcPlr)} dB</td><td>${n1(plr)} dB</td><td>${x.source.lufs > -70 ? `${signed(plr - srcPlr)} dB` : ''}</td></tr>
    ${s.maxShortTerm !== undefined ? `<tr><td>LOUDEST 3 S</td><td></td><td>${lufs(s.maxShortTerm)}</td><td></td></tr>` : ''}
    ${s.maxMomentary !== undefined ? `<tr><td>LOUDEST 400 MS</td><td></td><td>${lufs(s.maxMomentary)}</td><td></td></tr>` : ''}
    <tr><td>FORMAT</td><td>${esc(srcSpec)}</td><td>${esc(formatText(s))}</td><td></td></tr>
    <tr><td>LENGTH</td><td>${clock(x.source.durationSec)}</td><td>${clock(s.durationSec)}</td><td>${sizeText(s.bytes)}</td></tr>
  </table>
</section>

<section>
  <div class="head"><h2>Console</h2><span class="spec">HOW IT GOT THERE</span></div>
  <div class="macros">${macroCells}</div>
  <div class="cols">
    <div>${chain.join('\n    ')}</div>
    <div>${fixes.join('\n    ')}</div>
  </div>
</section>

<section>
  <div class="head"><h2>Delivery</h2><span class="spec">WHAT LOUDNESS NORMALIZATION DOES WITH ${n1(s.integratedLufs)} LUFS</span></div>
  <div class="cols"><div>${PLATFORMS.length > 0 ? delivery : ''}</div>${tags ? `<div>${tags}</div>` : ''}</div>
</section>

<footer>
  <span class="spec">MADE WITH J-MASTER${esc(version)} · JMW SOFTWARE</span>
  <span class="spec">MEASURED ON THE SAMPLES IN THE FILE</span>
</footer>
</div>
</body>
</html>
`;
}
