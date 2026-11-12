// 24-bit / 16-bit PCM WAV encoder with TPDF dither and RIFF LIST/INFO tags,
// and a plain 32-bit float writer for sources.
// Cover art rides in an "id3 " chunk (an embedded ID3v2.3 tag with an APIC
// frame), the de-facto standard most players read from WAV.
import { quantizeStereo, type DitherKind } from './flac';
import { buildId3v23 } from './id3';

export interface WavInfoTags {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  genre?: string;
  /** For the INFO chunk: catalogue number and comment already joined. */
  comment?: string;
  /** For the embedded ID3 tag, which has a field for each. */
  rawComment?: string;
  catalog?: string;
  isrc?: string;
  track?: string;
  picture?: { mime: string; data: Uint8Array };
}

export function encodeWavFromInt(
  qL: Int32Array,
  qR: Int32Array,
  sampleRate: number,
  bitDepth: 16 | 24,
  tags?: WavInfoTags,
): ArrayBuffer {
  const numCh = 2;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = qL.length * blockAlign;
  const infoChunk = buildInfoChunk(tags);
  const id3Chunk = buildId3Chunk(tags);
  const buf = new ArrayBuffer(44 + dataSize + infoChunk.length + id3Chunk.length);
  const view = new DataView(buf);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize + infoChunk.length + id3Chunk.length, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < qL.length; i++) {
    for (let ch = 0; ch < 2; ch++) {
      const v = ch === 0 ? qL[i] : qR[i];
      if (bitDepth === 24) {
        view.setUint8(off, v & 0xff);
        view.setUint8(off + 1, (v >> 8) & 0xff);
        view.setUint8(off + 2, (v >> 16) & 0xff);
        off += 3;
      } else {
        view.setInt16(off, v, true);
        off += 2;
      }
    }
  }
  new Uint8Array(buf).set(infoChunk, off);
  new Uint8Array(buf).set(id3Chunk, off + infoChunk.length);
  return buf;
}

/**
 * The whole tag set again as an embedded ID3v2.3 tag (UTF-16, so any
 * script survives), with the cover: players that read ID3 from a WAV get
 * every field, not just the three that used to ride along with a picture.
 */
function buildId3Chunk(tags?: WavInfoTags): Uint8Array {
  if (!tags) return new Uint8Array(0);
  const tag = buildId3v23({
    title: tags.title,
    artist: tags.artist,
    album: tags.album,
    year: tags.year,
    genre: tags.genre,
    track: tags.track,
    comment: tags.rawComment,
    catalog: tags.catalog,
    isrc: tags.isrc,
    picture: tags.picture,
  });
  if (tag.length === 0) return new Uint8Array(0);
  const padded = tag.length + (tag.length & 1); // RIFF word alignment
  const chunk = new Uint8Array(8 + padded);
  chunk[0] = 0x69; chunk[1] = 0x64; chunk[2] = 0x33; chunk[3] = 0x20; // "id3 "
  new DataView(chunk.buffer).setUint32(4, tag.length, true);
  chunk.set(tag, 8);
  return chunk;
}

export function encodeWav(
  L: Float32Array,
  R: Float32Array,
  sampleRate: number,
  bitDepth: 16 | 24,
  tags?: WavInfoTags,
  dither: DitherKind = 'tpdf',
): ArrayBuffer {
  const { qL, qR } = quantizeStereo(L, R, bitDepth, dither);
  return encodeWavFromInt(qL, qR, sampleRate, bitDepth, tags);
}

/**
 * 32-bit IEEE float WAV: nothing quantized and nothing clipped, for audio
 * that is still a source rather than a master (a drift repair can peak
 * past full scale).
 */
export function encodeWavFloat(L: Float32Array, R: Float32Array, sampleRate: number, tags?: WavInfoTags): ArrayBuffer {
  const frames = L.length;
  const dataSize = frames * 8;
  const infoChunk = buildInfoChunk(tags);
  const id3Chunk = buildId3Chunk(tags);
  const extra = infoChunk.length + id3Chunk.length;
  // A non-PCM format carries an 18-byte fmt chunk and a fact chunk.
  const buf = new ArrayBuffer(58 + dataSize + extra);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 50 + dataSize + extra, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 18, true);
  view.setUint16(20, 3, true);                 // WAVE_FORMAT_IEEE_FLOAT
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 8, true);
  view.setUint16(32, 8, true);
  view.setUint16(34, 32, true);
  view.setUint16(36, 0, true);                 // no extension
  writeStr(38, 'fact');
  view.setUint32(42, 4, true);
  view.setUint32(46, frames, true);
  writeStr(50, 'data');
  view.setUint32(54, dataSize, true);
  // The samples start at byte 58, off the 4-byte alignment a Float32Array needs.
  for (let i = 0, off = 58; i < frames; i++, off += 8) {
    view.setFloat32(off, L[i], true);
    view.setFloat32(off + 4, R[i], true);
  }
  new Uint8Array(buf).set(infoChunk, 58 + dataSize);
  new Uint8Array(buf).set(id3Chunk, 58 + dataSize + infoChunk.length);
  return buf;
}

function buildInfoChunk(tags?: WavInfoTags): Uint8Array {
  if (!tags) return new Uint8Array(0);
  const entries: [string, string][] = [];
  const add = (id: string, v?: string) => {
    if (v && v.length > 0) entries.push([id, v]);
  };
  add('INAM', tags.title);
  add('IART', tags.artist);
  add('IPRD', tags.album);
  add('ICRD', tags.year);
  add('IGNR', tags.genre);
  add('ICMT', tags.comment);
  add('ITRK', tags.track);
  add('ISRC', tags.isrc);
  if (entries.length === 0) return new Uint8Array(0);

  // INFO text has no declared encoding. Windows (Explorer, most players)
  // reads it as Windows-1252, so text that fits is written that way and
  // shows correctly there; anything else is UTF-8, which newer readers
  // take (the ID3 chunk carries the same tags in UTF-16 for the rest).
  const enc = new TextEncoder();
  const subs = entries.map(([id, v]) => {
    const bytes = cp1252(v) ?? enc.encode(v);
    const payload = bytes.length + 1;            // zero terminator
    const padded = payload + (payload & 1);      // word alignment
    const sub = new Uint8Array(8 + padded);
    sub[0] = id.charCodeAt(0); sub[1] = id.charCodeAt(1);
    sub[2] = id.charCodeAt(2); sub[3] = id.charCodeAt(3);
    new DataView(sub.buffer).setUint32(4, payload, true);
    sub.set(bytes, 8);
    return sub;
  });
  let inner = 4; // 'INFO'
  for (const s of subs) inner += s.length;
  const chunk = new Uint8Array(8 + inner);
  chunk[0] = 0x4c; chunk[1] = 0x49; chunk[2] = 0x53; chunk[3] = 0x54; // LIST
  new DataView(chunk.buffer).setUint32(4, inner, true);
  chunk[8] = 0x49; chunk[9] = 0x4e; chunk[10] = 0x46; chunk[11] = 0x4f; // INFO
  let off = 12;
  for (const s of subs) { chunk.set(s, off); off += s.length; }
  return chunk;
}

/** Windows-1252 bytes of `text`, or null when a character has no place in it. */
function cp1252(text: string): Uint8Array | null {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out[i] = c;
    else {
      const j = CP1252_HIGH.indexOf(text[i]);
      if (j < 0) return null;
      out[i] = 0x80 + j;
    }
  }
  return out;
}
// Code points of bytes 0x80..0x9F ('\u0000' marks the five unassigned ones).
const CP1252_HIGH = '\u20ac\u0000\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u0000\u017d\u0000'
  + '\u0000\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u0000\u017e\u0178';
