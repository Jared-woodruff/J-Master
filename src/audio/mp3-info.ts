// The Info frame at the head of an MP3: one silent frame that tells a
// player how many frames follow and, in its LAME extension, how many
// samples at each end are the encoder's own padding. Without it a decoded
// MP3 starts 1105 samples late (576 of encoder delay, 529 of decoder
// delay), runs past the end of the music, and players can only estimate
// its length. With it the file decodes to exactly the samples that went in.
//
// Layout (MPEG-1 Layer III): the stream's own 4-byte frame header, the
// side info left at zero (so the frame decodes as silence), "Info", the
// frame and byte counts, a seek table, and the LAME tag.

const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG1_RATES = [44100, 48000, 32000];
const SAMPLES_PER_FRAME = 1152;
/** What LAME's encoder (and lamejs, its port) puts ahead of the music. */
const ENCODER_DELAY = 576;
/** What a decoder adds on top, by convention (528 + 1). */
const DECODER_DELAY = 529;

interface FrameHeader { kbps: number; rate: number; padding: number; mono: boolean; size: number }

function parseHeader(d: Uint8Array, at: number): FrameHeader | null {
  if (at + 4 > d.length) return null;
  // Sync, MPEG-1, Layer III.
  if (d[at] !== 0xff || (d[at + 1] & 0xfe) !== 0xfa) return null;
  const kbps = MPEG1_L3_KBPS[d[at + 2] >> 4];
  const rate = MPEG1_RATES[(d[at + 2] >> 2) & 3];
  if (!kbps || !rate) return null;
  const padding = (d[at + 2] >> 1) & 1;
  return { kbps, rate, padding, mono: (d[at + 3] >> 6) === 3, size: Math.floor((144000 * kbps) / rate) + padding };
}

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc16(d: Uint8Array, from: number, to: number, crc = 0): number {
  for (let i = from; i < to; i++) crc = CRC_TABLE[(crc ^ d[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

export interface Mp3Layout { frames: number; delay: number; padding: number }

/**
 * `audio` (a CBR MPEG-1 Layer III stream of `nSamples` of music) with its
 * Info frame in front. The stream comes back as it was when it isn't one
 * this can describe.
 */
export function withInfoFrame(audio: Uint8Array, nSamples: number): { data: Uint8Array; layout: Mp3Layout | null } {
  const first = parseHeader(audio, 0);
  if (!first || first.mono) return { data: audio, layout: null };
  // Count the frames; every one must be where the last one's size says.
  let frames = 0;
  for (let at = 0; at < audio.length;) {
    const h = parseHeader(audio, at);
    if (!h || h.kbps !== first.kbps || h.rate !== first.rate) return { data: audio, layout: null };
    frames++;
    at += h.size;
  }
  const padding = frames * SAMPLES_PER_FRAME - ENCODER_DELAY - nSamples;
  // The 12-bit fields hold up to 4095; anything else is a stream this
  // doesn't understand, and a wrong trim is worse than none.
  if (padding < 0 || padding > 4095) return { data: audio, layout: null };

  const size = Math.floor((144000 * first.kbps) / first.rate);
  const f = new Uint8Array(size);
  const v = new DataView(f.buffer);
  f[0] = 0xff;
  f[1] = 0xfb;                          // MPEG-1 Layer III, no CRC
  f[2] = audio[2] & 0xfc;               // the stream's bitrate and rate, no padding byte
  f[3] = audio[3];                      // the stream's channel mode
  const tag = 4 + 32;                   // after the (zeroed) stereo side info
  f.set([0x49, 0x6e, 0x66, 0x6f], tag); // "Info": constant bitrate
  v.setUint32(tag + 4, 0x0f);           // frames, bytes, seek table, quality
  v.setUint32(tag + 8, frames);
  v.setUint32(tag + 12, size + audio.length);
  for (let i = 0; i < 100; i++) f[tag + 16 + i] = Math.floor((i * 256) / 100);
  v.setUint32(tag + 116, 0);            // quality: not stated

  const lame = tag + 120;
  f.set([0x4c, 0x41, 0x4d, 0x45, 0x33, 0x2e, 0x39, 0x38, 0x72], lame);   // "LAME3.98r"
  f[lame + 9] = 0x01;                   // tag revision 0, method: CBR
  f[lame + 10] = 0;                     // lowpass: not stated
  // 8 bytes of replay gain, 1 of encoding flags: left at zero.
  f[lame + 20] = Math.min(255, first.kbps);
  f[lame + 21] = (ENCODER_DELAY >> 4) & 0xff;
  f[lame + 22] = ((ENCODER_DELAY & 0x0f) << 4) | ((padding >> 8) & 0x0f);
  f[lame + 23] = padding & 0xff;
  f[lame + 24] = ((first.rate === 48000 ? 2 : first.rate === 44100 ? 1 : 0) << 6) | (3 << 2);   // source rate, joint stereo
  // MP3 gain (1), preset and surround (2): zero.
  v.setUint32(lame + 28, size + audio.length);
  v.setUint16(lame + 32, crc16(audio, 0, audio.length));
  v.setUint16(lame + 34, crc16(f, 0, lame + 34));

  const out = new Uint8Array(size + audio.length);
  out.set(f, 0);
  out.set(audio, size);
  return { data: out, layout: { frames, delay: ENCODER_DELAY + DECODER_DELAY, padding } };
}
