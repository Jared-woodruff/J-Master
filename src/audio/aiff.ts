// AIFF and AIFF-C, read here because the browser's decoder doesn't: Logic
// and most Mac tools bounce to it. Uncompressed PCM only (big-endian
// integers of 8 to 32 bits, 'sowt' little-endian, 32 and 64-bit float);
// anything else returns null and is left to the browser to refuse.

export interface PcmAudio {
  channels: Float32Array[];
  sampleRate: number;
  bitDepth: number;
}

/** An 80-bit IEEE 754 extended float (AIFF's sample-rate field). */
function extended(v: DataView, o: number): number {
  const se = v.getUint16(o);
  const exp = se & 0x7fff;
  const hi = v.getUint32(o + 2);
  const lo = v.getUint32(o + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  const mant = hi * 4294967296 + lo;
  return (se & 0x8000 ? -1 : 1) * mant * Math.pow(2, exp - 16383 - 63);
}

const tagAt = (b: Uint8Array, o: number): string => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** True for a file that says it is AIFF or AIFF-C. */
export function isAiff(data: ArrayBuffer): boolean {
  if (data.byteLength < 12) return false;
  const b = new Uint8Array(data, 0, 12);
  const form = tagAt(b, 8);
  return tagAt(b, 0) === 'FORM' && (form === 'AIFF' || form === 'AIFC');
}

/** The file's format line, without decoding it. */
export function aiffFormat(data: ArrayBuffer): { sampleRate: number; bitDepth: number } | null {
  const c = commOf(data);
  return c ? { sampleRate: c.sampleRate, bitDepth: c.bits } : null;
}

interface Comm { channels: number; frames: number; bits: number; sampleRate: number; codec: string; ssnd: number; ssndEnd: number }

function commOf(data: ArrayBuffer): Comm | null {
  if (!isAiff(data)) return null;
  const b = new Uint8Array(data);
  const v = new DataView(data);
  const aifc = tagAt(b, 8) === 'AIFC';
  let comm: Omit<Comm, 'ssnd' | 'ssndEnd'> | null = null;
  let ssnd = -1, ssndEnd = -1;
  for (let o = 12; o + 8 <= b.length;) {
    const id = tagAt(b, o);
    const size = v.getUint32(o + 4);
    const body = o + 8;
    if (id === 'COMM' && body + 18 <= b.length) {
      comm = {
        channels: v.getInt16(body),
        frames: v.getUint32(body + 2),
        bits: v.getInt16(body + 6),
        sampleRate: Math.round(extended(v, body + 8)),
        codec: aifc && size >= 22 ? tagAt(b, body + 18) : 'NONE',
      };
    } else if (id === 'SSND' && body + 8 <= b.length) {
      ssnd = body + 8 + v.getUint32(body);
      // A size of zero, or one that runs past the file, is a file still
      // being written or cut short: take what is there.
      ssndEnd = size >= 8 ? Math.min(b.length, body + size) : b.length;
    }
    o = body + size + (size & 1);
  }
  if (!comm || ssnd < 0) return null;
  if (comm.channels < 1 || comm.channels > 8 || comm.bits < 1 || comm.bits > 64) return null;
  if (!(comm.sampleRate >= 1000 && comm.sampleRate <= 768000)) return null;
  return { ...comm, ssnd, ssndEnd };
}

export function decodeAiff(data: ArrayBuffer): PcmAudio | null {
  const c = commOf(data);
  if (!c) return null;
  const codec = c.codec.toLowerCase();
  const float = codec === 'fl32' || codec === 'fl64';
  const little = codec === 'sowt';
  if (!float && !little && codec !== 'none' && codec !== 'twos' && codec !== 'in24' && codec !== 'in32') return null;
  const bytes = codec === 'fl64' ? 8 : codec === 'fl32' ? 4 : Math.ceil(c.bits / 8);
  if (bytes < 1 || bytes > 4 && !float) return null;
  const frameBytes = bytes * c.channels;
  const frames = Math.min(c.frames, Math.floor((c.ssndEnd - c.ssnd) / frameBytes));
  if (frames <= 0) return null;
  const v = new DataView(data);
  const out = Array.from({ length: c.channels }, () => new Float32Array(frames));
  const scale = 1 / Math.pow(2, bytes * 8 - 1);
  for (let ch = 0; ch < c.channels; ch++) {
    const x = out[ch];
    let o = c.ssnd + ch * bytes;
    if (codec === 'fl32') for (let i = 0; i < frames; i++, o += frameBytes) x[i] = v.getFloat32(o);
    else if (codec === 'fl64') for (let i = 0; i < frames; i++, o += frameBytes) x[i] = v.getFloat64(o);
    else if (bytes === 1) for (let i = 0; i < frames; i++, o += frameBytes) x[i] = v.getInt8(o) * scale;
    else if (bytes === 2) for (let i = 0; i < frames; i++, o += frameBytes) x[i] = v.getInt16(o, little) * scale;
    else if (bytes === 3) {
      for (let i = 0; i < frames; i++, o += frameBytes) {
        const s = little
          ? v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)
          : (v.getInt8(o) << 16) | (v.getUint8(o + 1) << 8) | v.getUint8(o + 2);
        x[i] = s * scale;
      }
    } else for (let i = 0; i < frames; i++, o += frameBytes) x[i] = v.getInt32(o, little) * scale;
  }
  return { channels: out, sampleRate: c.sampleRate, bitDepth: float ? bytes * 8 : c.bits };
}
