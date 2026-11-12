// The file writers, read back by independent decoders. The FLAC and MP3
// checks decode with ffmpeg and are skipped where it isn't installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWavFromInt, encodeWavFloat } from '../src/audio/wav';
import { encodeFlacFromInt, quantizeStereo } from '../src/audio/flac';
import { encodeAudio } from '../src/audio/encode';
import { Md5 } from '../src/audio/md5';
import { decodeAiff, aiffFormat } from '../src/audio/aiff';
import { fft } from '../src/audio/dsp/fft';
import { song, sine, rmsDb } from './lib/signals';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'jmaster-codecs-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

/** Decodes `file` to interleaved signed PCM with ffmpeg. */
function ffDecode(file: string, bits: 16 | 24): Buffer {
  const res = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', bits === 16 ? 's16le' : 's24le', '-'], {
    maxBuffer: 1 << 28,
  });
  assert.equal(res.status, 0, res.stderr?.toString());
  assert.equal(res.stderr?.toString() ?? '', '', 'decoder warnings');
  return res.stdout;
}

function pcmOf(qL: Int32Array, qR: Int32Array, bits: 16 | 24): Buffer {
  const bytes = bits / 8;
  const out = Buffer.alloc(qL.length * 2 * bytes);
  for (let i = 0; i < qL.length; i++) {
    out.writeIntLE(qL[i], i * 2 * bytes, bytes);
    out.writeIntLE(qR[i], i * 2 * bytes + bytes, bytes);
  }
  return out;
}

const tags = { TITLE: 'Tést ✓ title', ARTIST: 'J-Master' };

test('WAV: header fields and sample data', () => {
  const s = song(1.5);
  for (const bits of [16, 24] as const) {
    const { qL, qR } = quantizeStereo(s.l, s.r, bits);
    const wav = Buffer.from(encodeWavFromInt(qL, qR, 44100, bits, { title: 'T', artist: 'A' }));
    assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(4), wav.length - 8, 'RIFF size');
    assert.equal(wav.readUInt16LE(20), 1, 'PCM');
    assert.equal(wav.readUInt16LE(22), 2, 'channels');
    assert.equal(wav.readUInt32LE(24), 44100, 'rate');
    assert.equal(wav.readUInt32LE(28), 44100 * 2 * (bits / 8), 'byte rate');
    assert.equal(wav.readUInt16LE(34), bits, 'bit depth');
    const dataSize = wav.readUInt32LE(40);
    assert.equal(dataSize, qL.length * 2 * (bits / 8));
    assert.ok(wav.subarray(44, 44 + dataSize).equals(pcmOf(qL, qR, bits)), 'samples');
    assert.equal((wav.length - 44 - dataSize) % 2, 0, 'chunks word-aligned');
  }
});

test('WAV float: reads back exactly', () => {
  const s = song(0.5);
  s.l[10] = 1.7; // past full scale survives
  const wav = Buffer.from(encodeWavFloat(s.l, s.r, 48000));
  assert.equal(wav.readUInt16LE(20), 3, 'IEEE float');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readFloatLE(58 + 10 * 8), Math.fround(1.7));
  assert.equal(wav.readFloatLE(58 + 11 * 8 + 4), s.r[11]);
});

test('quantizer: stays in range at full scale', () => {
  const one = new Float32Array(1000).fill(1);
  const neg = new Float32Array(1000).fill(-1);
  for (const bits of [16, 24] as const) {
    const full = bits === 16 ? 32767 : 8388607;
    const { qL, qR } = quantizeStereo(one, neg, bits);
    assert.ok(qL.every((v) => v <= full && v >= full - 2));
    assert.ok(qR.every((v) => v >= -full - 1 && v <= -full + 2));
  }
});

test('FLAC: decodes bit-exact, at 16 and 24 bits, 44.1 and 48 kHz', { skip: !hasFfmpeg }, () => {
  const s = song(3);
  for (const bits of [16, 24] as const) {
    for (const rate of [44100, 48000]) {
      const { qL, qR } = quantizeStereo(s.l, s.r, bits);
      const file = join(dir, `t${bits}-${rate}.flac`);
      writeFileSync(file, Buffer.from(encodeFlacFromInt(qL, qR, rate, bits, tags)));
      const back = ffDecode(file, bits);
      assert.ok(back.equals(pcmOf(qL, qR, bits)), `${bits} bit ${rate} Hz differs`);
    }
  }
});

test('FLAC: odd lengths, silence and a mono-compatible pair', { skip: !hasFfmpeg }, () => {
  const cases: [string, Float32Array, Float32Array][] = [
    ['one sample', new Float32Array([0.25]), new Float32Array([-0.25])],
    ['4097 samples', song(4097 / 48000).l.subarray(0, 4097), song(4097 / 48000).r.subarray(0, 4097)],
    ['silence', new Float32Array(5000), new Float32Array(5000)],
    ['identical channels', song(0.7).l, song(0.7).l],
  ];
  for (const [name, l, r] of cases) {
    const { qL, qR } = quantizeStereo(l, r, 24);
    const file = join(dir, `${name.replace(/\W/g, '_')}.flac`);
    writeFileSync(file, Buffer.from(encodeFlacFromInt(qL, qR, 48000, 24)));
    assert.ok(ffDecode(file, 24).equals(pcmOf(qL, qR, 24)), name);
  }
});

test('MP3: decodes to the right length with its tags', { skip: !hasFfmpeg }, async () => {
  const s = song(3);
  const mp3 = await encodeAudio(s.l, s.r, 48000, {
    format: 'mp3', bitDepth: 24, mp3Kbps: 320, tags: { title: 'Tést ✓', artist: 'J-Master', trackNumber: 2, trackTotal: 9 },
  });
  const file = join(dir, 't.mp3');
  writeFileSync(file, Buffer.from(mp3.data));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags', '-of', 'json', file]);
  const info = JSON.parse(probe.stdout.toString());
  assert.ok(Math.abs(Number(info.format.duration) - 3) < 0.001, `duration ${info.format.duration}`);
  assert.equal(info.format.tags.title, 'Tést ✓');
  assert.equal(info.format.tags.track, '2/9');
});

test('MP3: the Info frame makes it gapless (the samples that went in, where they went in)', { skip: !hasFfmpeg }, async () => {
  for (const [fs, kbps] of [[48000, 320], [44100, 192], [44100, 256]] as const) {
    // Music with no period to it: only one alignment correlates.
    const src = song(2.2, 110, fs, 7);
    const n = src.l.length - 317;                 // not a whole number of frames
    const l = src.l.subarray(0, n), r = src.r.subarray(0, n);
    const mp3 = await encodeAudio(l, r, fs, { format: 'mp3', bitDepth: 24, mp3Kbps: kbps });
    const bytes = Buffer.from(mp3.data);
    assert.equal(bytes.subarray(36, 40).toString('latin1'), 'Info', `${fs}/${kbps}: Info tag where a decoder looks for it`);
    assert.equal(bytes.subarray(156, 160).toString('latin1'), 'LAME');
    const file = join(dir, `gapless-${fs}-${kbps}.mp3`);
    writeFileSync(file, bytes);
    const pcm = ffDecode(file, 16);
    assert.equal(pcm.length / 4, n, `${fs}/${kbps}: decodes to the length that went in`);
    // Where does the decoded file best line up with what went in?
    let best = -99, bestCorr = -Infinity;
    for (let lag = -40; lag <= 40; lag++) {
      let c = 0;
      for (let i = 20000; i < 60000; i++) c += l[i] * pcm.readInt16LE((i + lag) * 4);
      if (c > bestCorr) { bestCorr = c; best = lag; }
    }
    assert.equal(best, 0, `${fs}/${kbps}: the decoded file sits ${best} samples off the source`);
  }
});

test('WAV and FLAC of one render carry the same samples', async () => {
  const s = song(1);
  const cache = new Map();
  const wav = Buffer.from((await encodeAudio(s.l, s.r, 48000, { format: 'wav', bitDepth: 16, mp3Kbps: 320 }, cache)).data);
  const q = cache.get('16:tpdf')!;
  assert.ok(wav.subarray(44, 44 + q.qL.length * 4).equals(pcmOf(q.qL, q.qR, 16)));
  if (hasFfmpeg) {
    const flac = await encodeAudio(s.l, s.r, 48000, { format: 'flac', bitDepth: 16, mp3Kbps: 320 }, cache);
    const file = join(dir, 'pair.flac');
    writeFileSync(file, Buffer.from(flac.data));
    assert.ok(ffDecode(file, 16).equals(wav.subarray(44, 44 + q.qL.length * 4)));
  }
});

test('MD5: the reference vectors, in one piece and in pieces', () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  const enc = new TextEncoder();
  assert.equal(hex(new Md5().digest()), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(hex(new Md5().update(enc.encode('abc')).digest()), '900150983cd24fb0d6963f7d28e17f72');
  const long = enc.encode('12345678901234567890123456789012345678901234567890123456789012345678901234567890');
  assert.equal(hex(new Md5().update(long).digest()), '57edf4a22be3c955ac49da2e2107b67a');
  const big = new Uint8Array(100003).map((_, i) => (i * 31) & 0xff);
  const pieces = new Md5();
  for (let o = 0; o < big.length; o += 977) pieces.update(big.subarray(o, o + 977));
  assert.equal(hex(pieces.digest()), createHash('md5').update(big).digest('hex'));
});

test('FLAC: STREAMINFO carries the MD5 of the audio', () => {
  const s = song(1.3);
  for (const bits of [16, 24] as const) {
    const { qL, qR } = quantizeStereo(s.l, s.r, bits);
    const flac = Buffer.from(encodeFlacFromInt(qL, qR, 48000, bits));
    // fLaC (4) + block header (4) + 18 bytes of STREAMINFO before the signature.
    const sig = flac.subarray(26, 42).toString('hex');
    assert.equal(sig, createHash('md5').update(pcmOf(qL, qR, bits)).digest('hex'), `${bits} bit`);
  }
});

test('dither: the same render gives the same bytes', () => {
  const s = song(1);
  const a = quantizeStereo(s.l, s.r, 16);
  const b = quantizeStereo(s.l, s.r, 16);
  assert.deepEqual(a.qL, b.qL);
  assert.deepEqual(a.qR, b.qR);
  // Still dither: the error is not the same sample to sample, and the two
  // channels do not share it.
  const z = new Float32Array(4000).fill(0.3 / 32767);
  const q = quantizeStereo(z, z, 16);
  assert.ok(new Set(q.qL).size >= 2);
  let same = 0;
  for (let i = 0; i < z.length; i++) if (q.qL[i] === q.qR[i]) same++;
  assert.ok(same < z.length * 0.9, 'channels are dithered apart');
});

test('dither: TPDF error has the textbook power, shaped moves it out of the ear\'s way', () => {
  // A quiet tone at 16 bits; what the quantizer adds is everything else.
  const fs = 44100;
  const tone = sine(997, 6, fs, -60);
  const noiseOf = (kind: 'tpdf' | 'shaped') => {
    const { qL } = quantizeStereo(tone, tone, 16, kind);
    const err = new Float32Array(tone.length);
    for (let i = 0; i < err.length; i++) err[i] = qL[i] / 32767 - tone[i];
    return err;
  };
  const band = (x: Float32Array, lo: number, hi: number) => {
    const N = 8192;
    const re = new Float64Array(N), im = new Float64Array(N);
    let acc = 0, frames = 0;
    for (let s = 0; s + N <= x.length; s += N) {
      for (let i = 0; i < N; i++) { re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))); im[i] = 0; }
      fft(re, im);
      for (let k = Math.round((lo / fs) * N); k < Math.round((hi / fs) * N); k++) acc += re[k] * re[k] + im[k] * im[k];
      frames++;
    }
    return 10 * Math.log10(acc / frames);
  };
  const flat = noiseOf('tpdf'), shaped = noiseOf('shaped');
  // TPDF at 16 bits: error power 3 × (1/12) LSB², i.e. −96.3 + 4.8 − 0 ≈ −93.3 dBFS RMS (re 32767).
  const want = 10 * Math.log10(0.25) - 20 * Math.log10(32767);
  assert.ok(Math.abs(rmsDb(flat) - want) < 0.3, `TPDF error ${rmsDb(flat).toFixed(2)} dBFS, expected ${want.toFixed(2)}`);
  const ear = band(shaped, 2000, 5000) - band(flat, 2000, 5000);
  const top = band(shaped, 17000, 21000) - band(flat, 17000, 21000);
  assert.ok(ear < -10, `2-5 kHz noise moved by ${ear.toFixed(1)} dB`);
  assert.ok(top > 10, `and went to the top of the band: ${top.toFixed(1)} dB`);
  // 24-bit ignores the request: there is nothing down there to shape.
  assert.deepEqual(quantizeStereo(tone, tone, 24, 'shaped').qL, quantizeStereo(tone, tone, 24, 'tpdf').qL);
});

test('WAV: 32-bit float export with tags, and text Windows can read', async () => {
  const s = song(0.5);
  const tags = { title: 'Tïtle – “quoted”', artist: 'Björk', album: 'Albüm', catalog: 'JW-014', comment: 'hello', isrc: 'AUJMW2600001', trackNumber: 3, trackTotal: 9 };
  const f = Buffer.from((await encodeAudio(s.l, s.r, 44100, { format: 'wav', bitDepth: 32, mp3Kbps: 320, tags })).data);
  assert.equal(f.readUInt16LE(20), 3, 'IEEE float');
  assert.equal(f.readUInt32LE(24), 44100);
  assert.equal(f.readUInt32LE(4), f.length - 8, 'RIFF size covers the tag chunks');
  assert.equal(f.readFloatLE(58 + 100 * 8), s.l[100]);
  // INFO in Windows-1252: ï is one byte (0xEF), the en dash 0x96, the curly quotes 0x93/0x94.
  const info = f.indexOf('INAM', 0, 'latin1');
  assert.ok(info > 0);
  const title = f.subarray(info + 8, info + 8 + f.readUInt32LE(info + 4) - 1);
  assert.deepEqual([...title], [...Buffer.from('T\xeftle \x96 \x93quoted\x94', 'latin1')]);
  // Catalogue and comment joined with plain ASCII.
  const cmt = f.indexOf('ICMT', 0, 'latin1');
  assert.equal(f.toString('latin1', cmt + 8, cmt + 8 + f.readUInt32LE(cmt + 4) - 1), 'CAT. JW-014 - hello');
  // And the full set again as ID3, cover or no cover.
  assert.ok(f.indexOf('id3 ', 0, 'latin1') > 0, 'id3 chunk present');
  assert.ok(f.indexOf('TSRC', 0, 'latin1') > 0, 'ISRC frame present');
  // Text with no Windows-1252 form falls back to UTF-8.
  const j = Buffer.from((await encodeAudio(s.l, s.r, 48000, { format: 'wav', bitDepth: 16, mp3Kbps: 320, tags: { title: '日本' } })).data);
  const jt = j.indexOf('INAM', 0, 'latin1');
  assert.equal(j.toString('utf8', jt + 8, jt + 8 + j.readUInt32LE(jt + 4) - 1), '日本');
});

test('FLAC and MP3 at 44.1 kHz', { skip: !hasFfmpeg }, async () => {
  const s = song(2, 120, 44100);
  for (const format of ['flac', 'mp3'] as const) {
    const out = await encodeAudio(s.l, s.r, 44100, { format, bitDepth: 16, mp3Kbps: 256, tags: { title: 'x', isrc: 'AUJMW2600001' } });
    const file = join(dir, `r441.${format}`);
    writeFileSync(file, Buffer.from(out.data));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate:format=duration:format_tags', '-of', 'json', file]);
    const info = JSON.parse(probe.stdout.toString());
    assert.equal(info.streams[0].sample_rate, '44100', format);
    assert.ok(Math.abs(Number(info.format.duration) - 2) < 0.08, `${format} duration ${info.format.duration}`);
    const isrc = info.format.tags.ISRC ?? info.format.tags.TSRC ?? info.format.tags.isrc;
    assert.equal(isrc, 'AUJMW2600001', `${format} ISRC`);
  }
});

// ── AIFF in ───────────────────────────────────────────────────────────
/** An AIFF (or AIFF-C) file of `frames` stereo frames, written the long way round. */
function aiffFile(codec: 'NONE' | 'sowt' | 'fl32', bits: number, fs: number, l: Float32Array, r: Float32Array, ssndFirst = false): ArrayBuffer {
  const frames = l.length;
  const bytes = codec === 'fl32' ? 4 : bits / 8;
  const aifc = codec !== 'NONE';
  const comm = Buffer.alloc(8 + (aifc ? 24 : 18));
  comm.write('COMM', 0, 'latin1');
  comm.writeUInt32BE(aifc ? 24 : 18, 4);
  comm.writeInt16BE(2, 8);
  comm.writeUInt32BE(frames, 10);
  comm.writeInt16BE(bits, 14);
  // 80-bit extended: exponent and a 64-bit mantissa with its top bit set.
  const exp = Math.floor(Math.log2(fs));
  comm.writeUInt16BE(16383 + exp, 16);
  comm.writeBigUInt64BE(BigInt(Math.round(fs * 2 ** (63 - exp))), 18);
  if (aifc) { comm.write(codec, 26, 'latin1'); comm.writeUInt16BE(0, 30); }
  const ssnd = Buffer.alloc(16 + frames * 2 * bytes);
  ssnd.write('SSND', 0, 'latin1');
  ssnd.writeUInt32BE(8 + frames * 2 * bytes, 4);
  const full = 2 ** (bits - 1);
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < 2; ch++) {
      const x = ch === 0 ? l[i] : r[i];
      const o = 16 + (i * 2 + ch) * bytes;
      const q = Math.max(-full, Math.min(full - 1, Math.round(x * full)));
      if (codec === 'fl32') ssnd.writeFloatBE(x, o);
      else if (bytes === 2) { if (codec === 'sowt') ssnd.writeInt16LE(q, o); else ssnd.writeInt16BE(q, o); }
      else if (bytes === 3) ssnd.writeIntBE(q, o, 3);
      else ssnd.writeInt32BE(q, o);
    }
  }
  const body = ssndFirst ? [ssnd, comm] : [comm, ssnd];
  const head = Buffer.alloc(12);
  head.write('FORM', 0, 'latin1');
  head.writeUInt32BE(4 + comm.length + ssnd.length, 4);
  head.write(aifc ? 'AIFC' : 'AIFF', 8, 'latin1');
  const all = Buffer.concat([head, ...body]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

test('AIFF: every PCM flavour reads back as the samples that were written', () => {
  const s = song(0.5, 120, 44100, 3);
  for (const [codec, bits, tol] of [['NONE', 16, 2 ** -15], ['NONE', 24, 2 ** -23], ['NONE', 32, 2 ** -24], ['sowt', 16, 2 ** -15], ['fl32', 32, 0]] as const) {
    const file = aiffFile(codec, bits, 44100, s.l, s.r, codec === 'sowt');
    assert.deepEqual(aiffFormat(file), { sampleRate: 44100, bitDepth: bits });
    const a = decodeAiff(file)!;
    assert.ok(a, `${codec}/${bits} decodes`);
    assert.equal(a.sampleRate, 44100);
    assert.equal(a.channels.length, 2);
    assert.equal(a.channels[0].length, s.l.length);
    let worst = 0;
    for (let i = 0; i < s.l.length; i++) {
      worst = Math.max(worst, Math.abs(a.channels[0][i] - s.l[i]), Math.abs(a.channels[1][i] - s.r[i]));
    }
    assert.ok(worst <= tol, `${codec}/${bits}: off by ${worst}`);
  }
});

test('AIFF: other rates, a file cut short, and what it will not take', () => {
  const s = song(0.2, 120, 96000, 4);
  assert.equal(decodeAiff(aiffFile('NONE', 24, 96000, s.l, s.r))!.sampleRate, 96000);
  assert.equal(aiffFormat(aiffFile('NONE', 16, 22050, s.l, s.r))!.sampleRate, 22050);
  // Cut off mid-data: what is there still plays.
  const whole = aiffFile('NONE', 16, 96000, s.l, s.r);
  const cut = decodeAiff(whole.slice(0, whole.byteLength - 4000))!;
  assert.equal(cut.channels[0].length, s.l.length - 1000);
  // Not AIFF, a compressed AIFF-C, nothing at all.
  assert.equal(decodeAiff(new ArrayBuffer(4)), null);
  assert.equal(decodeAiff(new TextEncoder().encode('RIFF....WAVEfmt ').buffer as ArrayBuffer), null);
  const ulaw = Buffer.from(aiffFile('sowt', 16, 44100, s.l, s.r));
  ulaw.write('ulaw', ulaw.indexOf('sowt'), 'latin1');
  assert.equal(decodeAiff(ulaw.buffer.slice(ulaw.byteOffset, ulaw.byteOffset + ulaw.length) as ArrayBuffer), null);
});
