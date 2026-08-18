// 24-bit / 16-bit PCM WAV encoder with TPDF dither and RIFF LIST/INFO tags.
import { quantizeStereo } from './flac';

export interface WavInfoTags {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  genre?: string;
  comment?: string;
  track?: string;
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
  const buf = new ArrayBuffer(44 + dataSize + infoChunk.length);
  const view = new DataView(buf);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize + infoChunk.length, true);
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
  return buf;
}

export function encodeWav(
  L: Float32Array,
  R: Float32Array,
  sampleRate: number,
  bitDepth: 16 | 24,
  tags?: WavInfoTags,
): ArrayBuffer {
  const { qL, qR } = quantizeStereo(L, R, bitDepth);
  return encodeWavFromInt(qL, qR, sampleRate, bitDepth, tags);
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
  if (entries.length === 0) return new Uint8Array(0);

  const enc = new TextEncoder();
  const subs = entries.map(([id, v]) => {
    const bytes = enc.encode(v);
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
