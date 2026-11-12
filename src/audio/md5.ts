// MD5 (RFC 1321), streaming. FLAC carries the MD5 of its unencoded audio in
// STREAMINFO so a decoder can prove the file still holds what was put in;
// the render worker has no crypto.subtle digest that streams, so here it is.

const S = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

export class Md5 {
  private a = 0x67452301;
  private b = 0xefcdab89 | 0;
  private c = 0x98badcfe | 0;
  private d = 0x10325476;
  private block = new Uint8Array(64);
  private fill = 0;
  private bytes = 0;
  private m = new Int32Array(16);

  update(data: Uint8Array): this {
    let off = 0;
    this.bytes += data.length;
    if (this.fill > 0) {
      const take = Math.min(64 - this.fill, data.length);
      this.block.set(data.subarray(0, take), this.fill);
      this.fill += take;
      off = take;
      if (this.fill < 64) return this;
      this.transform(this.block, 0);
      this.fill = 0;
    }
    for (; off + 64 <= data.length; off += 64) this.transform(data, off);
    if (off < data.length) {
      this.block.set(data.subarray(off), 0);
      this.fill = data.length - off;
    }
    return this;
  }

  digest(): Uint8Array {
    const bits = this.bytes * 8;
    const pad = new Uint8Array(((this.fill < 56 ? 56 : 120) - this.fill) + 8);
    pad[0] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(pad.length - 8, bits >>> 0, true);
    dv.setUint32(pad.length - 4, Math.floor(bits / 4294967296) >>> 0, true);
    this.update(pad);
    const out = new Uint8Array(16);
    const o = new DataView(out.buffer);
    o.setInt32(0, this.a, true);
    o.setInt32(4, this.b, true);
    o.setInt32(8, this.c, true);
    o.setInt32(12, this.d, true);
    return out;
  }

  private transform(p: Uint8Array, off: number): void {
    const m = this.m;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      m[i] = p[j] | (p[j + 1] << 8) | (p[j + 2] << 16) | (p[j + 3] << 24);
    }
    let a = this.a, b = this.b, c = this.c, d = this.d;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const x = (a + f + K[i] + m[g]) | 0;
      a = d; d = c; c = b;
      b = (b + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
    }
    this.a = (this.a + a) | 0;
    this.b = (this.b + b) | 0;
    this.c = (this.c + c) | 0;
    this.d = (this.d + d) | 0;
  }
}

/** MD5 of stereo integer samples as interleaved little-endian PCM (what FLAC's STREAMINFO signs). */
export function md5OfPcm(qL: Int32Array, qR: Int32Array, bitDepth: 16 | 24): Uint8Array {
  const md5 = new Md5();
  const bytes = bitDepth / 8;
  const CHUNK = 16384;
  const buf = new Uint8Array(CHUNK * 2 * bytes);
  for (let s = 0; s < qL.length; s += CHUNK) {
    const n = Math.min(CHUNK, qL.length - s);
    let o = 0;
    for (let i = 0; i < n; i++) {
      const l = qL[s + i], r = qR[s + i];
      buf[o++] = l & 0xff; buf[o++] = (l >> 8) & 0xff;
      if (bytes === 3) buf[o++] = (l >> 16) & 0xff;
      buf[o++] = r & 0xff; buf[o++] = (r >> 8) & 0xff;
      if (bytes === 3) buf[o++] = (r >> 16) & 0xff;
    }
    md5.update(buf.subarray(0, o));
  }
  return md5.digest();
}
