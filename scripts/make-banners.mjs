// Generates the README banner SVGs in the Jamware Records design language:
// graphite plate, paper ink, one signal orange, registration crosshairs,
// mono spec labels. GitHub-safe (system font stacks, no external resources).
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = 'docs/assets';
mkdirSync(OUT, { recursive: true });

const GRAPHITE = '#0D0E10';
const PAPER = '#FBFAF7';
const SIGNAL = '#FF4D00';
const SPEC = '#878D93';
const HAIR = '#33373C';
const DISPLAY = `font-family="'Arial Black','Segoe UI',Arial,sans-serif" font-weight="900"`;
const MONO = `font-family="'Consolas','Courier New',monospace"`;

const crosshair = (x, y) =>
  `<path d="M${x - 5} ${y}h10M${x} ${y - 5}v10" stroke="${SPEC}" stroke-width="1"/>`;

const mark = (cx, cy, s) => `
  <circle cx="${cx}" cy="${cy}" r="${24 * s}" stroke="${PAPER}" stroke-width="${3 * s}" fill="none"/>
  <circle cx="${cx}" cy="${cy}" r="${18 * s}" stroke="${PAPER}" stroke-width="${1.5 * s}" fill="none"/>
  <circle cx="${cx}" cy="${cy}" r="${13 * s}" stroke="${PAPER}" stroke-width="${1.5 * s}" fill="none"/>
  <rect x="${cx - 4 * s}" y="${cy - 4 * s}" width="${8 * s}" height="${8 * s}" fill="${SIGNAL}"/>
  <path d="M${cx} ${cy - 31 * s}v${4 * s}M${cx} ${cy + 27 * s}v${4 * s}M${cx - 31 * s} ${cy}h${4 * s}M${cx + 27 * s} ${cy}h${4 * s}" stroke="${PAPER}" stroke-width="${2 * s}"/>`;

// ── hero ──────────────────────────────────────────────────────────────
const hero = `<svg xmlns="http://www.w3.org/2000/svg" width="860" height="170" viewBox="0 0 860 170">
  <rect width="860" height="170" fill="${GRAPHITE}"/>
  <rect x="0.5" y="0.5" width="859" height="169" fill="none" stroke="${HAIR}"/>
  ${crosshair(14, 14)}${crosshair(846, 14)}${crosshair(14, 156)}${crosshair(846, 156)}
  ${mark(96, 85, 1.35)}
  <text x="176" y="86" ${DISPLAY} font-size="46" letter-spacing="6" fill="${PAPER}">J-MASTER</text>
  <text x="179" y="114" ${MONO} font-size="12" letter-spacing="3.5" fill="${SIGNAL}">MASTERING CONSOLE FOR THE AI MUSIC ERA</text>
  <text x="179" y="136" ${MONO} font-size="10" letter-spacing="2" fill="${SPEC}">JMW SOFTWARE · JAMWARE RECORDS · MUSIC, MANUFACTURED.</text>
  <text x="846" y="40" text-anchor="end" ${MONO} font-size="10" letter-spacing="2" fill="${SPEC}">WIN X64 · ARM64</text>
  <text x="846" y="56" text-anchor="end" ${MONO} font-size="10" letter-spacing="2" fill="${SPEC}">BS.1770-4</text>
</svg>`;
writeFileSync(`${OUT}/banner-hero.svg`, hero);

// ── section banners ───────────────────────────────────────────────────
const section = (id, label, spec) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="860" height="52" viewBox="0 0 860 52">
  <rect width="860" height="52" fill="${GRAPHITE}"/>
  <rect x="0" y="0" width="860" height="2" fill="${PAPER}"/>
  <rect x="12" y="21" width="10" height="10" fill="${SIGNAL}"/>
  <text x="36" y="34" ${DISPLAY} font-size="19" letter-spacing="4" fill="${PAPER}">${label}</text>
  <line x1="${56 + label.length * 19}" y1="28" x2="${840 - spec.length * 7.2}" y2="28" stroke="${HAIR}" stroke-dasharray="1 4"/>
  <text x="848" y="32" text-anchor="end" ${MONO} font-size="10" letter-spacing="2" fill="${SPEC}">${spec}</text>
</svg>`;
  writeFileSync(`${OUT}/banner-${id}.svg`, svg);
};

section('console', 'THE CONSOLE', 'EIGHT MACROS · STEM LANES · ADV EQ');
section('intelligence', 'INTELLIGENCE', 'DIAGNOSIS · AUTO-MASTER · MATCH');
section('formats', 'FORMATS + DELIVERY', 'WAV FLAC MP3 OPUS · CD IMAGE');
section('architecture', 'ARCHITECTURE', 'WYSIWYG DSP · ZERO-DEP CODECS');
section('verification', 'VERIFICATION', 'EVERY CLAIM MEASURED');
section('start', 'GETTING STARTED', 'BUILD · DEV · PACKAGE');
section('license', 'LICENSE', 'GPL-3.0');

console.log('banners written to docs/assets/');
