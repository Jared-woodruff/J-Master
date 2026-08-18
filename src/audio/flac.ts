// Self-contained FLAC encoder (RFC 9639): fixed-blocksize 4096 frames,
// per-frame stereo decorrelation (independent / left-side / right-side /
// mid-side, chosen by exact coded cost), fixed predictors (orders 0–4),
// partitioned Rice coding (up to 64 partitions per subframe, per-partition
// parameters), optional VORBIS_COMMENT tags. Zero dependencies; every frame
// is planned before writing so channel mode choices use real bit counts.

const BLOCK = 4096;
const MAX_PART_ORDER = 6;
const MAX_K = 30;
const MAX_LPC_ORDER = 12;
const LPC_PRECISION = 15;

export interface FlacTags {
  [field: string]: string; // e.g. TITLE, ARTIST, ALBUM, CATALOGNUMBER…
}

class BitWriter {
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  private acc = 0;
  private nbits = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + extra));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  writeBits(value: number, n: number): void {
    // n <= 32; value interpreted as unsigned in its low n bits.
    while (n > 0) {
      const take = Math.min(8 - this.nbits, n);
      const shift = n - take;
      const bits = (shift >= 32 ? 0 : value >>> shift) & ((1 << take) - 1);
      this.acc = (this.acc << take) | bits;
      this.nbits += take;
      n -= take;
      if (this.nbits === 8) {
        this.ensure(1);
        this.buf[this.len++] = this.acc & 0xff;
        this.acc = 0;
        this.nbits = 0;
      }
    }
  }

  /** FLAC unary: q zero bits followed by a one bit. */
  writeUnary(q: number): void {
    while (q >= 32) { this.writeBits(0, 32); q -= 32; }
    this.writeBits(1, q + 1);
  }

  alignByte(): void {
    if (this.nbits > 0) this.writeBits(0, 8 - this.nbits);
  }

  get byteLength(): number { return this.len; }
  byteAt(i: number): number { return this.buf[i]; }
  writeByte(b: number): void { this.ensure(1); this.buf[this.len++] = b & 0xff; }
  writeBytes(src: Uint8Array): void {
    this.ensure(src.length);
    this.buf.set(src, this.len);
    this.len += src.length;
  }
  bytes(): Uint8Array { return this.buf.subarray(0, this.len); }
}

// ── CRCs ──────────────────────────────────────────────────────────────
const CRC8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();

const CRC16_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let b = 0; b < 8; b++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();

/** UTF-8-style coding of the frame number. */
function writeCodedNumber(bw: BitWriter, n: number): void {
  if (n < 0x80) {
    bw.writeByte(n);
  } else if (n < 0x800) {
    bw.writeByte(0xc0 | (n >>> 6));
    bw.writeByte(0x80 | (n & 0x3f));
  } else if (n < 0x10000) {
    bw.writeByte(0xe0 | (n >>> 12));
    bw.writeByte(0x80 | ((n >>> 6) & 0x3f));
    bw.writeByte(0x80 | (n & 0x3f));
  } else if (n < 0x200000) {
    bw.writeByte(0xf0 | (n >>> 18));
    bw.writeByte(0x80 | ((n >>> 12) & 0x3f));
    bw.writeByte(0x80 | ((n >>> 6) & 0x3f));
    bw.writeByte(0x80 | (n & 0x3f));
  } else {
    bw.writeByte(0xf8 | (n >>> 24));
    bw.writeByte(0x80 | ((n >>> 18) & 0x3f));
    bw.writeByte(0x80 | ((n >>> 12) & 0x3f));
    bw.writeByte(0x80 | ((n >>> 6) & 0x3f));
    bw.writeByte(0x80 | (n & 0x3f));
  }
}

// ── subframe planning ─────────────────────────────────────────────────

interface PartitionPlan {
  order: number;      // partition order p (2^p partitions)
  ks: number[];       // rice parameter per partition
  method: 0 | 1;      // 0: 4-bit params, 1: 5-bit params
  bits: number;       // residual-coding bits incl. method/order/param fields
}

interface SubframePlan {
  kind: 'constant' | 'verbatim' | 'fixed' | 'lpc';
  bps: number;
  order: number;               // predictor order (fixed or LPC)
  residuals: Int32Array;
  partitions: PartitionPlan | null;
  bits: number;                // total subframe bits incl. header
  qlp?: Int32Array;            // LPC quantized coefficients
  shift?: number;              // LPC quantization shift
}

function bestFixedOrder(x: Int32Array, n: number): number {
  const sums = [0, 0, 0, 0, 0];
  for (let i = 4; i < n; i++) {
    const d1 = x[i] - x[i - 1];
    const d2 = d1 - (x[i - 1] - x[i - 2]);
    const d3 = d2 - (x[i - 1] - 2 * x[i - 2] + x[i - 3]);
    const d4 = d3 - (x[i - 1] - 3 * x[i - 2] + 3 * x[i - 3] - x[i - 4]);
    sums[0] += Math.abs(x[i]);
    sums[1] += Math.abs(d1);
    sums[2] += Math.abs(d2);
    sums[3] += Math.abs(d3);
    sums[4] += Math.abs(d4);
  }
  let best = 0;
  for (let o = 1; o <= 4; o++) if (sums[o] < sums[best]) best = o;
  return best;
}

function computeResiduals(x: Int32Array, n: number, order: number, out: Int32Array): void {
  switch (order) {
    case 0:
      for (let i = 0; i < n; i++) out[i] = x[i];
      break;
    case 1:
      for (let i = 1; i < n; i++) out[i - 1] = x[i] - x[i - 1];
      break;
    case 2:
      for (let i = 2; i < n; i++) out[i - 2] = x[i] - 2 * x[i - 1] + x[i - 2];
      break;
    case 3:
      for (let i = 3; i < n; i++) out[i - 3] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3];
      break;
    case 4:
      for (let i = 4; i < n; i++) out[i - 4] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
      break;
  }
}

/**
 * Optimal partitioned-Rice plan for a residual set.
 * Builds per-partition Σ(u>>k) tables at the deepest level, then merges
 * upward, choosing the best k per partition at every level.
 */
function bestPartitionPlan(res: Int32Array, count: number, predOrder: number, bs: number): PartitionPlan {
  let pmax = 0;
  while (
    pmax < MAX_PART_ORDER &&
    bs % (1 << (pmax + 1)) === 0 &&
    (bs >> (pmax + 1)) > predOrder
  ) pmax++;

  const parts = 1 << pmax;
  const baseLen = bs >> pmax;
  // Per-partition: sample count + Σ(u>>k) table.
  let counts = new Array<number>(parts).fill(baseLen);
  counts[0] = baseLen - predOrder;
  let tables: Float64Array[] = [];
  for (let p = 0; p < parts; p++) tables.push(new Float64Array(MAX_K + 1));

  let idx = 0;
  for (let p = 0; p < parts; p++) {
    const t = tables[p];
    const c = counts[p];
    for (let i = 0; i < c; i++, idx++) {
      const v = res[idx];
      let u = v >= 0 ? v * 2 : -v * 2 - 1;
      let k = 0;
      while (u > 0 && k <= MAX_K) { t[k] += u; u = Math.floor(u / 2); k++; }
    }
  }

  const planAt = (cnts: number[], tbls: Float64Array[], p: number): PartitionPlan => {
    const ks: number[] = [];
    let payload = 0;
    let maxK = 0;
    for (let i = 0; i < cnts.length; i++) {
      const t = tbls[i];
      let bestK = 0;
      let bestBits = Infinity;
      for (let k = 0; k <= MAX_K; k++) {
        const bits = cnts[i] * (k + 1) + t[k];
        if (bits < bestBits) { bestBits = bits; bestK = k; }
      }
      ks.push(bestK);
      payload += bestBits;
      if (bestK > maxK) maxK = bestK;
    }
    const method: 0 | 1 = maxK > 14 ? 1 : 0;
    const paramBits = (method === 1 ? 5 : 4) * cnts.length;
    return { order: p, ks, method, bits: 2 + 4 + paramBits + payload };
  };

  let best = planAt(counts, tables, pmax);
  // Merge upward and compare.
  let curCounts = counts;
  let curTables = tables;
  for (let p = pmax - 1; p >= 0; p--) {
    const half = 1 << p;
    const mCounts = new Array<number>(half);
    const mTables: Float64Array[] = [];
    for (let i = 0; i < half; i++) {
      mCounts[i] = curCounts[2 * i] + curCounts[2 * i + 1];
      const t = new Float64Array(MAX_K + 1);
      const a = curTables[2 * i], b = curTables[2 * i + 1];
      for (let k = 0; k <= MAX_K; k++) t[k] = a[k] + b[k];
      mTables.push(t);
    }
    const plan = planAt(mCounts, mTables, p);
    if (plan.bits < best.bits) best = plan;
    curCounts = mCounts;
    curTables = mTables;
  }
  return best;
}

function planSubframe(x: Int32Array, n: number, bps: number): SubframePlan {
  let constant = true;
  for (let i = 1; i < n; i++) {
    if (x[i] !== x[0]) { constant = false; break; }
  }
  if (constant) {
    return { kind: 'constant', bps, order: 0, residuals: new Int32Array(0), partitions: null, bits: 8 + bps };
  }
  const order = n > 8 ? bestFixedOrder(x, n) : 0;
  const residuals = new Int32Array(n - order);
  computeResiduals(x, n, order, residuals);
  const partitions = bestPartitionPlan(residuals, n - order, order, n);
  const bits = 8 + order * bps + partitions.bits;
  let best: SubframePlan = { kind: 'fixed', bps, order, residuals, partitions, bits };

  const lpc = planLpcSubframe(x, n, bps);
  if (lpc && lpc.bits < best.bits) best = lpc;

  const verbatimBits = 8 + n * bps;
  if (verbatimBits < best.bits) {
    return { kind: 'verbatim', bps, order: 0, residuals: new Int32Array(0), partitions: null, bits: verbatimBits };
  }
  return best;
}

/**
 * LPC subframe candidate: Hann-windowed autocorrelation → Levinson-Durbin,
 * heuristic order pick from the per-order prediction errors, quantized
 * coefficients with error feedback. The returned bit count is exact, so the
 * caller can compare it fairly against the fixed-predictor plan.
 */
function planLpcSubframe(x: Int32Array, n: number, bps: number): SubframePlan | null {
  if (n <= MAX_LPC_ORDER * 2) return null;

  // Windowed autocorrelation.
  const w = new Float64Array(n);
  const wStep = (2 * Math.PI) / (n - 1);
  for (let i = 0; i < n; i++) w[i] = x[i] * (0.5 - 0.5 * Math.cos(wStep * i));
  const autoc = new Float64Array(MAX_LPC_ORDER + 1);
  for (let k = 0; k <= MAX_LPC_ORDER; k++) {
    let s = 0;
    for (let i = k; i < n; i++) s += w[i] * w[i - k];
    autoc[k] = s;
  }
  if (autoc[0] <= 0) return null;

  // Levinson-Durbin; keep coefficients and error for every order.
  const a = new Float64Array(MAX_LPC_ORDER);
  const tmp = new Float64Array(MAX_LPC_ORDER);
  const coefByOrder: Float64Array[] = [];
  const errByOrder: number[] = [];
  let err = autoc[0];
  for (let m = 0; m < MAX_LPC_ORDER; m++) {
    let k = autoc[m + 1];
    for (let j = 0; j < m; j++) k -= a[j] * autoc[m - j];
    k /= err;
    tmp.set(a.subarray(0, m));
    a[m] = k;
    for (let j = 0; j < m; j++) a[j] = tmp[j] - k * tmp[m - 1 - j];
    err *= 1 - k * k;
    if (!(err > 0)) break;
    coefByOrder.push(a.slice(0, m + 1) as Float64Array);
    errByOrder.push(err);
  }
  if (coefByOrder.length === 0) return null;

  // Heuristic order: expected residual std → rice bits/sample + header cost.
  let bestOrder = 1;
  let bestEst = Infinity;
  for (let m = 1; m <= coefByOrder.length; m++) {
    const sigma = Math.sqrt(errByOrder[m - 1] / n);
    const perSample = Math.max(1, Math.log2(sigma + 1) + 2);
    const est = (n - m) * perSample + m * (bps + LPC_PRECISION) + 40;
    if (est < bestEst) { bestEst = est; bestOrder = m; }
  }
  const coefs = coefByOrder[bestOrder - 1];

  // Quantize with error feedback.
  let cmax = 0;
  for (let j = 0; j < bestOrder; j++) cmax = Math.max(cmax, Math.abs(coefs[j]));
  if (cmax <= 0) return null;
  let shift = LPC_PRECISION - 1 - Math.floor(Math.log2(cmax)) - 1;
  if (shift > 15) shift = 15;
  if (shift < 0) return null;
  const qlp = new Int32Array(bestOrder);
  const qmax = (1 << (LPC_PRECISION - 1)) - 1;
  const qmin = -(1 << (LPC_PRECISION - 1));
  let qerr = 0;
  const scale = Math.pow(2, shift);
  for (let j = 0; j < bestOrder; j++) {
    const ideal = coefs[j] * scale + qerr;
    let q = Math.round(ideal);
    if (q > qmax) q = qmax; else if (q < qmin) q = qmin;
    qerr = ideal - q;
    qlp[j] = q;
  }

  // Integer residuals. Accumulator stays within double precision (≤ ~2^42);
  // floor-division implements the spec's arithmetic shift for negatives too.
  const res = new Int32Array(n - bestOrder);
  const div = Math.pow(2, shift);
  for (let i = bestOrder; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < bestOrder; j++) acc += qlp[j] * x[i - 1 - j];
    const r = x[i] - Math.floor(acc / div);
    if (r > 2147483647 || r < -2147483648) return null;
    res[i - bestOrder] = r;
  }

  const partitions = bestPartitionPlan(res, n - bestOrder, bestOrder, n);
  const bits = 8 + bestOrder * bps + 4 + 5 + bestOrder * LPC_PRECISION + partitions.bits;
  return { kind: 'lpc', bps, order: bestOrder, residuals: res, partitions, bits, qlp, shift };
}

function writeSubframe(bw: BitWriter, x: Int32Array, n: number, plan: SubframePlan): void {
  const { bps } = plan;
  const mask = Math.pow(2, bps) - 1;
  bw.writeBits(0, 1);
  if (plan.kind === 'constant') {
    bw.writeBits(0, 6);
    bw.writeBits(0, 1);
    bw.writeBits(x[0] & mask, bps);
    return;
  }
  if (plan.kind === 'verbatim') {
    bw.writeBits(1, 6);
    bw.writeBits(0, 1);
    for (let i = 0; i < n; i++) bw.writeBits(x[i] & mask, bps);
    return;
  }
  if (plan.kind === 'lpc') {
    bw.writeBits(0b100000 | (plan.order - 1), 6);
    bw.writeBits(0, 1);
    for (let i = 0; i < plan.order; i++) bw.writeBits(x[i] & mask, bps);
    bw.writeBits(LPC_PRECISION - 1, 4);
    bw.writeBits(plan.shift!, 5);
    const qmask = (1 << LPC_PRECISION) - 1;
    for (let j = 0; j < plan.order; j++) bw.writeBits(plan.qlp![j] & qmask, LPC_PRECISION);
  } else {
    bw.writeBits(0b001000 | plan.order, 6);
    bw.writeBits(0, 1);
    for (let i = 0; i < plan.order; i++) bw.writeBits(x[i] & mask, bps);
  }

  const pp = plan.partitions!;
  bw.writeBits(pp.method, 2);
  bw.writeBits(pp.order, 4);
  const res = plan.residuals;
  const parts = 1 << pp.order;
  const baseLen = n >> pp.order;
  let idx = 0;
  for (let p = 0; p < parts; p++) {
    const k = pp.ks[p];
    bw.writeBits(k, pp.method === 1 ? 5 : 4);
    const c = p === 0 ? baseLen - plan.order : baseLen;
    const div = Math.pow(2, k);
    for (let i = 0; i < c; i++, idx++) {
      const v = res[idx];
      const u = v >= 0 ? v * 2 : -v * 2 - 1;
      bw.writeUnary(Math.floor(u / div));
      if (k > 0) bw.writeBits(u % div, k);
    }
  }
}

// ── stereo mode selection ─────────────────────────────────────────────

const ASSIGN_INDEPENDENT = 0b0001;
const ASSIGN_LEFT_SIDE = 0b1000;
const ASSIGN_RIGHT_SIDE = 0b1001;
const ASSIGN_MID_SIDE = 0b1010;

// ── public API ────────────────────────────────────────────────────────

/** Quantizes float stereo to ints with TPDF dither (shared with WAV path). */
export function quantizeStereo(
  L: Float32Array,
  R: Float32Array,
  bitDepth: 16 | 24,
): { qL: Int32Array; qR: Int32Array } {
  const n = L.length;
  const full = bitDepth === 24 ? 8388607 : 32767;
  const ditherAmp = 1 / full;
  const qL = new Int32Array(n);
  const qR = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let a = Math.round((L[i] + (Math.random() + Math.random() - 1) * ditherAmp) * full);
    let b = Math.round((R[i] + (Math.random() + Math.random() - 1) * ditherAmp) * full);
    if (a > full) a = full; else if (a < -full - 1) a = -full - 1;
    if (b > full) b = full; else if (b < -full - 1) b = -full - 1;
    qL[i] = a;
    qR[i] = b;
  }
  return { qL, qR };
}

export function encodeFlacFromInt(
  qL: Int32Array,
  qR: Int32Array,
  sampleRate: number,
  bitDepth: 16 | 24,
  tags?: FlacTags,
): ArrayBuffer {
  const n = qL.length;
  const out = new BitWriter();
  out.writeByte(0x66); out.writeByte(0x4c); out.writeByte(0x61); out.writeByte(0x43); // fLaC

  const hasTags = tags && Object.keys(tags).length > 0;
  // STREAMINFO
  out.writeBits(hasTags ? 0 : 1, 1);
  out.writeBits(0, 7);
  out.writeBits(34, 24);
  out.writeBits(BLOCK, 16);
  out.writeBits(BLOCK, 16);
  out.writeBits(0, 24);
  out.writeBits(0, 24);
  out.writeBits(sampleRate, 20);
  out.writeBits(1, 3);
  out.writeBits(bitDepth - 1, 5);
  out.writeBits(0, 4);
  out.writeBits(n >>> 0, 32);
  for (let i = 0; i < 16; i++) out.writeByte(0);

  if (hasTags) writeVorbisComment(out, tags!);

  const bufA = new Int32Array(BLOCK);   // left / mid / side depending on mode
  const bufB = new Int32Array(BLOCK);
  const mid = new Int32Array(BLOCK);
  const side = new Int32Array(BLOCK);
  const srCode = sampleRate === 48000 ? 0b1010 : sampleRate === 44100 ? 0b1001 : 0b0000;
  const ssCode = bitDepth === 24 ? 0b110 : 0b100;

  let frameIndex = 0;
  for (let s = 0; s < n; s += BLOCK, frameIndex++) {
    const bs = Math.min(BLOCK, n - s);
    for (let i = 0; i < bs; i++) {
      const l = qL[s + i];
      const r = qR[s + i];
      bufA[i] = l;
      bufB[i] = r;
      mid[i] = (l + r) >> 1;
      side[i] = l - r;
    }

    // Plan all four candidate channels, pick the cheapest assignment.
    const planL = planSubframe(bufA, bs, bitDepth);
    const planR = planSubframe(bufB, bs, bitDepth);
    const planM = planSubframe(mid, bs, bitDepth);
    const planS = planSubframe(side, bs, bitDepth + 1);

    const costs: [number, number][] = [
      [ASSIGN_INDEPENDENT, planL.bits + planR.bits],
      [ASSIGN_LEFT_SIDE, planL.bits + planS.bits],
      [ASSIGN_RIGHT_SIDE, planS.bits + planR.bits],
      [ASSIGN_MID_SIDE, planM.bits + planS.bits],
    ];
    let assign = ASSIGN_INDEPENDENT;
    let bestCost = Infinity;
    for (const [a, c] of costs) {
      if (c < bestCost) { bestCost = c; assign = a; }
    }

    const fw = new BitWriter();
    fw.writeBits(0b11111111111110, 14);
    fw.writeBits(0, 1);
    fw.writeBits(0, 1);
    fw.writeBits(0b0111, 4);
    fw.writeBits(srCode, 4);
    fw.writeBits(assign, 4);
    fw.writeBits(ssCode, 3);
    fw.writeBits(0, 1);
    writeCodedNumber(fw, frameIndex);
    fw.writeBits(bs - 1, 16);
    let crc8 = 0;
    for (let i = 0; i < fw.byteLength; i++) crc8 = CRC8_TABLE[crc8 ^ fw.byteAt(i)];
    fw.writeByte(crc8);

    switch (assign) {
      case ASSIGN_INDEPENDENT:
        writeSubframe(fw, bufA, bs, planL);
        writeSubframe(fw, bufB, bs, planR);
        break;
      case ASSIGN_LEFT_SIDE:
        writeSubframe(fw, bufA, bs, planL);
        writeSubframe(fw, side, bs, planS);
        break;
      case ASSIGN_RIGHT_SIDE:
        writeSubframe(fw, side, bs, planS);
        writeSubframe(fw, bufB, bs, planR);
        break;
      case ASSIGN_MID_SIDE:
        writeSubframe(fw, mid, bs, planM);
        writeSubframe(fw, side, bs, planS);
        break;
    }
    fw.alignByte();
    let crc16 = 0;
    for (let i = 0; i < fw.byteLength; i++) {
      crc16 = ((crc16 << 8) & 0xffff) ^ CRC16_TABLE[((crc16 >> 8) ^ fw.byteAt(i)) & 0xff];
    }
    fw.writeByte(crc16 >> 8);
    fw.writeByte(crc16 & 0xff);

    out.writeBytes(fw.bytes());
  }

  const result = out.bytes();
  const ab = new ArrayBuffer(result.length);
  new Uint8Array(ab).set(result);
  return ab;
}

export function encodeFlac(
  L: Float32Array,
  R: Float32Array,
  sampleRate: number,
  bitDepth: 16 | 24,
  tags?: FlacTags,
): ArrayBuffer {
  const { qL, qR } = quantizeStereo(L, R, bitDepth);
  return encodeFlacFromInt(qL, qR, sampleRate, bitDepth, tags);
}

function writeVorbisComment(out: BitWriter, tags: FlacTags): void {
  const enc = new TextEncoder();
  const vendor = enc.encode('J-Master (JMW Software)');
  const entries = Object.entries(tags)
    .filter(([, v]) => v && v.length > 0)
    .map(([k, v]) => enc.encode(`${k.toUpperCase()}=${v}`));
  let size = 4 + vendor.length + 4;
  for (const e of entries) size += 4 + e.length;

  out.writeBits(1, 1);   // last metadata block
  out.writeBits(4, 7);   // VORBIS_COMMENT
  out.writeBits(size, 24);
  const le32 = (v: number) => {
    out.writeByte(v & 0xff);
    out.writeByte((v >>> 8) & 0xff);
    out.writeByte((v >>> 16) & 0xff);
    out.writeByte((v >>> 24) & 0xff);
  };
  le32(vendor.length);
  out.writeBytes(vendor);
  le32(entries.length);
  for (const e of entries) {
    le32(e.length);
    out.writeBytes(e);
  }
}
