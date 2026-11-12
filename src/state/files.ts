// Names for the files the app writes, text for a CUE sheet, and words for
// what went wrong when a file couldn't be read or saved. Pure: no store.
import { effectiveBitDepth, effectiveRate, type EncodeOptions, type ExportFormat } from '../audio/encode';

/** "48k24", "44k16", "48k32f": the lossless spec a file name carries. */
function specTag(encode: EncodeOptions): string {
  const rate = effectiveRate(encode);
  const depth = effectiveBitDepth(encode);
  return `${rate === 44100 ? '44k' : `${Math.round(rate / 1000)}k`}${depth === 32 ? '32f' : depth}`;
}

/**
 * The default name of a master. Plain ASCII, hyphen and all: these files
 * go to distributors' upload forms and into CUE sheets, and a long dash in
 * a file name is one more thing for either to choke on.
 */
export function masterFileName(sourceName: string, encode: EncodeOptions): string {
  const base = sourceName.replace(/\.[^.]+$/, '');
  if (encode.format === 'mp3') return `${base} - Master ${encode.mp3Kbps}.mp3`;
  if (encode.format === 'opus') return `${base} - Master OPUS${encode.opusKbps ?? 192}.opus`;
  return `${base} - Master ${specTag(encode)}.${encode.format}`;
}

/** `name` ending in the format's own extension, whatever was typed. */
export function withFormatExt(name: string, format: ExportFormat): string {
  return `${name.trim().replace(/\.(wav|flac|mp3|opus|ogg)$/i, '')}.${format}`;
}

/**
 * Name for a companion format saved beside the master. Default-named
 * masters give each format its own default name (no "48k24" on an MP3);
 * a renamed master lends companions its base name.
 */
export function companionFileName(
  mainName: string,
  sourceName: string,
  main: EncodeOptions,
  extra: EncodeOptions,
): string {
  if (mainName === masterFileName(sourceName, main)) return masterFileName(sourceName, extra);
  return `${mainName.replace(/\.[^.]+$/, '')}.${extra.format}`;
}

/** The folder a saved file sits in ("E:\" for a file at a drive's root, not "E:"). */
export function folderOf(path: string): string {
  const dir = path.replace(/[\\/][^\\/]*$/, '');
  return /^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir;
}

export const isPath = (s: string): boolean => s.includes('\\') || s.includes('/');
export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
/** A path that reaches another machine (Windows signs in to those). */
export const isNetworkPath = (p: string): boolean => /^[\\/]{2}/.test(p);

/** Why reading, decoding or saving a file failed, in the status line's words. */
export function fileErrorText(err: unknown): string {
  const m = String((err as { message?: string })?.message ?? err);
  if (/network path/i.test(m)) return 'NETWORK FOLDER · CHOOSE IT AGAIN';
  if (/EBUSY|resource busy|locked/i.test(m)) return 'THE FILE IS OPEN IN ANOTHER APP';
  if (/EPERM|EACCES|permission/i.test(m)) return 'NO PERMISSION';
  if (/ENOSPC/i.test(m)) return 'THE DISK IS FULL';
  if (/ENOENT|no such file/i.test(m)) return 'FILE OR FOLDER NOT FOUND';
  if (/FILE_TOO_LARGE|too large/i.test(m)) return 'THE FILE IS TOO LARGE';
  if (/decode|EncodingError/i.test(m)) return 'CAN’T DECODE THIS FILE';
  return m.replace(/^Error invoking remote method '[^']+': /, '').replace(/^\w*Error: /, '').slice(0, 48).toUpperCase();
}

// ── CD image text ─────────────────────────────────────────────────────────
/**
 * Text for a CUE sheet: CD-TEXT is Latin-1, so other characters fold to
 * their base letter (or "?"); a CUE can't escape a quote, so quotes become
 * apostrophes; one line, at most 80 characters.
 */
export function cueText(t: string): string {
  let out = '';
  for (const ch of t.normalize('NFC')) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f) continue;
    if ('"“”„‘’'.includes(ch)) out += "'";
    else if (ch === '–' || ch === '—') out += '-';
    else if (ch === '…') out += '...';
    else if (c <= 0xff) out += ch;
    else {
      const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      out += base.length === 1 && base.charCodeAt(0) <= 0xff ? base : '?';
    }
  }
  return out.trim().slice(0, 80);
}

/** A file name every burning tool can find: plain ASCII. */
export function asciiFileName(t: string): string {
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e]/g, '_').replace(/[<>:"/\\|?*]/g, '_').trim() || 'Album';
}

/** Latin-1 bytes of text already folded by `cueText`. */
export function latin1(t: string): ArrayBuffer {
  const b = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i) & 0xff;
  return b.buffer;
}

/** The 13-digit barcode for a UPC-A (12) or EAN-13 code; null when its check digit fails. */
export function ean13(code: string): string | null {
  const d = code.length === 12 ? `0${code}` : code;
  if (!/^\d{13}$/.test(d)) return null;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(d[12]) ? d : null;
}

/** CC-XXX-YY-NNNNN, written without the hyphens. */
export const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/** The Red Book's limits: 99 tracks, 4 s each at least, 79:57 in all. */
export const CD_MAX_TRACKS = 99;
export const CD_MIN_TRACK_SEC = 4;
export const CD_MAX_SEC = 79 * 60 + 57;
/** A CD frame: 1/75 s, 588 samples at 44.1 kHz. */
export const CD_FRAME_SAMPLES = 588;

/** mm:ss:ff for a frame count (75 frames a second). */
export function mmssff(frame: number): string {
  const ff = frame % 75;
  const totalSec = Math.floor(frame / 75);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}

export interface CueTrack { title: string; isrc?: string; startFrame: number; lengthSec: number }

/** The CUE sheet for an image: CD-TEXT titles, valid ISRCs, frame-exact indexes. */
export function buildCue(
  imageFile: string, albumTitle: string, performer: string, upc: string | null, tracks: CueTrack[],
): string {
  let cue = '';
  if (upc) cue += `CATALOG ${upc}\r\n`;
  cue += `TITLE "${cueText(albumTitle)}"\r\nPERFORMER "${cueText(performer)}"\r\nFILE "${imageFile}" WAVE\r\n`;
  tracks.forEach((t, i) => {
    cue += `  TRACK ${String(i + 1).padStart(2, '0')} AUDIO\r\n`;
    cue += `    TITLE "${cueText(t.title)}"\r\n`;
    cue += `    PERFORMER "${cueText(performer)}"\r\n`;
    if (t.isrc && ISRC_RE.test(t.isrc)) cue += `    ISRC ${t.isrc}\r\n`;
    cue += `    INDEX 01 ${mmssff(t.startFrame)}\r\n`;
  });
  return cue;
}
