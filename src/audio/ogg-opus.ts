// Ogg Opus export with zero dependencies: Chromium's native WebCodecs
// AudioEncoder produces the Opus packets, and this module muxes them into an
// Ogg container per RFC 7845 (OpusHead + OpusTags header pages, granule
// positions in 48 kHz samples, page CRCs).

export interface OpusTagsInput {
  [field: string]: string; // TITLE, ARTIST, ALBUM, DATE, GENRE…
}

declare const AudioEncoder: any;
declare const AudioData: any;

const SERIAL = 0x4a4d5752; // "JMWR"
const PRESKIP_DEFAULT = 312;

// Ogg CRC32: poly 0x04C11DB7, no reflection, init/xorout 0.
const OGG_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let b = 0; b < 8; b++) {
      c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (((crc << 8) >>> 0) ^ OGG_CRC[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

interface Packet {
  data: Uint8Array;
  /** Cumulative granule (48 kHz samples incl. preskip) after this packet. */
  granule: number;
}

function buildPage(
  packets: Uint8Array[],
  granule: number,
  seq: number,
  flags: number,
): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let rem = p.length;
    while (rem >= 255) { lacing.push(255); rem -= 255; }
    lacing.push(rem); // includes terminating 0..254 (a 255-multiple ends with 0)
  }
  let bodyLen = 0;
  for (const p of packets) bodyLen += p.length;
  const page = new Uint8Array(27 + lacing.length + bodyLen);
  const dv = new DataView(page.buffer);
  page[0] = 0x4f; page[1] = 0x67; page[2] = 0x67; page[3] = 0x53; // OggS
  page[4] = 0;          // version
  page[5] = flags;      // 0x02 BOS, 0x04 EOS
  // 64-bit granule position, little-endian.
  dv.setUint32(6, granule >>> 0, true);
  dv.setUint32(10, Math.floor(granule / 4294967296), true);
  dv.setUint32(14, SERIAL, true);
  dv.setUint32(18, seq, true);
  dv.setUint32(22, 0, true); // CRC placeholder
  page[26] = lacing.length;
  page.set(lacing, 27);
  let off = 27 + lacing.length;
  for (const p of packets) { page.set(p, off); off += p.length; }
  dv.setUint32(22, crc32(page), true);
  return page;
}

function buildOpusHead(preskip: number, inputRate: number): Uint8Array {
  const h = new Uint8Array(19);
  const dv = new DataView(h.buffer);
  h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // OpusHead
  h[8] = 1;   // version
  h[9] = 2;   // channels
  dv.setUint16(10, preskip, true);
  dv.setUint32(12, inputRate, true);
  dv.setUint16(16, 0, true); // output gain
  h[18] = 0;  // mapping family
  return h;
}

function buildOpusTags(tags?: OpusTagsInput): Uint8Array {
  const enc = new TextEncoder();
  const vendor = enc.encode('J-Master (JMW Software)');
  const entries = Object.entries(tags ?? {})
    .filter(([, v]) => v && v.length > 0)
    .map(([k, v]) => enc.encode(`${k.toUpperCase()}=${v}`));
  let size = 8 + 4 + vendor.length + 4;
  for (const e of entries) size += 4 + e.length;
  const t = new Uint8Array(size);
  const dv = new DataView(t.buffer);
  t.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]); // OpusTags
  let off = 8;
  dv.setUint32(off, vendor.length, true); off += 4;
  t.set(vendor, off); off += vendor.length;
  dv.setUint32(off, entries.length, true); off += 4;
  for (const e of entries) {
    dv.setUint32(off, e.length, true); off += 4;
    t.set(e, off); off += e.length;
  }
  return t;
}

export function opusSupported(): boolean {
  return typeof AudioEncoder !== 'undefined';
}

export async function encodeOggOpus(
  L: Float32Array,
  R: Float32Array,
  sampleRate: number,
  kbps: number,
  tags?: OpusTagsInput,
): Promise<ArrayBuffer> {
  if (!opusSupported()) throw new Error('WebCodecs AudioEncoder unavailable');
  const n = L.length;
  const packets: Packet[] = [];
  let preskip = PRESKIP_DEFAULT;
  let granule = 0;
  let encodeError: unknown = null;

  const encoder = new AudioEncoder({
    output: (chunk: any, meta: any) => {
      // Chromium provides an OpusHead in decoderConfig.description; its
      // preskip reflects the true encoder delay.
      const desc = meta?.decoderConfig?.description;
      if (desc) {
        const d = new Uint8Array(desc instanceof ArrayBuffer ? desc : desc.buffer);
        if (d.length >= 12) preskip = d[10] | (d[11] << 8);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const samples = Math.round(((chunk.duration ?? 20000) * 48000) / 1e6);
      granule += samples;
      packets.push({ data, granule });
    },
    error: (e: unknown) => { encodeError = e; },
  });
  encoder.configure({
    codec: 'opus',
    sampleRate,
    numberOfChannels: 2,
    bitrate: kbps * 1000,
  });

  const FRAME = Math.round(sampleRate * 0.02);
  const planar = new Float32Array(FRAME * 2);
  for (let s = 0; s < n; s += FRAME) {
    const len = Math.min(FRAME, n - s);
    planar.fill(0);
    planar.set(L.subarray(s, s + len), 0);
    planar.set(R.subarray(s, s + len), FRAME);
    const audio = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: FRAME,
      numberOfChannels: 2,
      timestamp: Math.round((s / sampleRate) * 1e6),
      data: planar.slice(0, FRAME * 2),
    });
    encoder.encode(audio);
    audio.close();
  }
  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;
  if (packets.length === 0) throw new Error('opus encoder produced no packets');

  // Mux: header pages, then audio pages of up to 50 packets.
  const pages: Uint8Array[] = [];
  let seq = 0;
  pages.push(buildPage([buildOpusHead(preskip, sampleRate)], 0, seq++, 0x02));
  pages.push(buildPage([buildOpusTags(tags)], 0, seq++, 0));
  const totalGranule = n + preskip; // clamp playback to the real length
  for (let i = 0; i < packets.length; i += 50) {
    const group = packets.slice(i, i + 50);
    const last = i + 50 >= packets.length;
    const g = Math.min(group[group.length - 1].granule + preskip, last ? totalGranule : Infinity);
    pages.push(buildPage(group.map((p) => p.data), last ? totalGranule : g, seq++, last ? 0x04 : 0));
  }

  let size = 0;
  for (const p of pages) size += p.length;
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of pages) { out.set(p, off); off += p.length; }
  return out.buffer;
}
