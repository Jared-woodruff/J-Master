// Minimal ID3v2.3 tag builder for MP3 exports. Text frames use UTF-16LE with
// BOM (encoding 0x01) — the most widely supported non-ASCII option in v2.3.

export interface Id3Tags {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  genre?: string;
  comment?: string;
  track?: string;      // "3" or "3/12"
  catalog?: string;    // stored as TXXX:CATALOGNUMBER
}

function utf16le(s: string): Uint8Array {
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xff; out[1] = 0xfe; // BOM
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = c & 0xff;
    out[3 + i * 2] = c >> 8;
  }
  return out;
}

function frame(id: string, payload: Uint8Array): Uint8Array {
  const f = new Uint8Array(10 + payload.length);
  for (let i = 0; i < 4; i++) f[i] = id.charCodeAt(i);
  const size = payload.length;
  f[4] = (size >>> 24) & 0xff;
  f[5] = (size >>> 16) & 0xff;
  f[6] = (size >>> 8) & 0xff;
  f[7] = size & 0xff;
  // flags = 0
  f.set(payload, 10);
  return f;
}

function textFrame(id: string, value: string): Uint8Array {
  const text = utf16le(value);
  const payload = new Uint8Array(1 + text.length);
  payload[0] = 0x01; // UTF-16 with BOM
  payload.set(text, 1);
  return frame(id, payload);
}

function commentFrame(value: string): Uint8Array {
  const desc = utf16le('');
  const text = utf16le(value);
  // encoding + language + short-desc + 0x0000 terminator + text
  const payload = new Uint8Array(1 + 3 + desc.length + 2 + text.length);
  payload[0] = 0x01;
  payload[1] = 0x65; payload[2] = 0x6e; payload[3] = 0x67; // "eng"
  payload.set(desc, 4);
  // two zero bytes terminate the UTF-16 description
  payload.set(text, 4 + desc.length + 2);
  return frame('COMM', payload);
}

function txxxFrame(description: string, value: string): Uint8Array {
  const desc = utf16le(description);
  const text = utf16le(value);
  const payload = new Uint8Array(1 + desc.length + 2 + text.length);
  payload[0] = 0x01;
  payload.set(desc, 1);
  payload.set(text, 1 + desc.length + 2);
  return frame('TXXX', payload);
}

export function buildId3v23(tags: Id3Tags): Uint8Array {
  const frames: Uint8Array[] = [];
  if (tags.title) frames.push(textFrame('TIT2', tags.title));
  if (tags.artist) frames.push(textFrame('TPE1', tags.artist));
  if (tags.album) frames.push(textFrame('TALB', tags.album));
  if (tags.year) frames.push(textFrame('TYER', tags.year));
  if (tags.genre) frames.push(textFrame('TCON', tags.genre));
  if (tags.track) frames.push(textFrame('TRCK', tags.track));
  if (tags.catalog) frames.push(txxxFrame('CATALOGNUMBER', tags.catalog));
  if (tags.comment) frames.push(commentFrame(tags.comment));
  if (frames.length === 0) return new Uint8Array(0);

  let size = 0;
  for (const f of frames) size += f.length;
  const tag = new Uint8Array(10 + size);
  tag[0] = 0x49; tag[1] = 0x44; tag[2] = 0x33; // "ID3"
  tag[3] = 0x03; tag[4] = 0x00;                // v2.3.0
  tag[5] = 0x00;                               // flags
  // syncsafe size
  tag[6] = (size >>> 21) & 0x7f;
  tag[7] = (size >>> 14) & 0x7f;
  tag[8] = (size >>> 7) & 0x7f;
  tag[9] = size & 0x7f;
  let off = 10;
  for (const f of frames) { tag.set(f, off); off += f.length; }
  return tag;
}
