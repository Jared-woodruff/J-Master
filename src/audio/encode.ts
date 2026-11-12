// Export encoding dispatch: WAV (PCM or 32-bit float, RIFF INFO + ID3),
// FLAC (lossless + Vorbis comments), MP3 (lamejs + ID3v2.3), Ogg Opus.
// Runs inside the render worker.
// WAV and FLAC share one dithered quantization pass, so the two lossless
// formats of the same render carry bit-identical samples.
import { encodeWavFromInt, encodeWavFloat, WavInfoTags } from './wav';
import { encodeFlacFromInt, quantizeStereo, FlacTags, type DitherKind } from './flac';
import { buildId3v23, Id3Tags } from './id3';
import { encodeOggOpus, OpusTagsInput } from './ogg-opus';
import { resample } from './dsp/resample';
import { Mp3Encoder } from '@breezystack/lamejs';
import { withInfoFrame } from './mp3-info';

export type ExportFormat = 'wav' | 'flac' | 'mp3' | 'opus';
export type { DitherKind } from './flac';
/** 32 is IEEE float, WAV only: nothing quantized, nothing dithered. */
export type ExportBitDepth = 16 | 24 | 32;
/** Rates a master can be delivered at (the engine itself runs at 48 kHz). */
export type ExportRate = 44100 | 48000;
export const EXPORT_RATES: ExportRate[] = [44100, 48000];

export interface TrackTags {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  genre?: string;
  catalog?: string;
  comment?: string;
  /** International Standard Recording Code, 12 characters. */
  isrc?: string;
  trackNumber?: number;
  trackTotal?: number;
  /** Front-cover art, embedded per format (APIC / PICTURE block /
      METADATA_BLOCK_PICTURE / WAV "id3 " chunk). */
  picture?: { mime: string; data: Uint8Array; width?: number; height?: number };
}

export interface EncodeOptions {
  format: ExportFormat;
  bitDepth: ExportBitDepth;  // wav (16/24/32f) + flac (16/24)
  mp3Kbps: 192 | 256 | 320;  // mp3
  opusKbps?: 128 | 192 | 256; // opus
  /** Rate to deliver at (default: the engine's). Opus is always 48 kHz. */
  sampleRate?: ExportRate;
  /** 16-bit only: plain TPDF, or noise-shaped. */
  dither?: DitherKind;
  tags?: TrackTags;
}

export interface Encoded {
  data: ArrayBuffer;
  ext: string;
  mime: string;
}

/** The bit depth a format will really be written at (FLAC has no float). */
export function effectiveBitDepth(opts: Pick<EncodeOptions, 'format' | 'bitDepth'>): ExportBitDepth {
  if (opts.format === 'flac' && opts.bitDepth === 32) return 24;
  return opts.bitDepth;
}

/** The rate a format will really be delivered at. */
export function effectiveRate(opts: Pick<EncodeOptions, 'format' | 'sampleRate'>, engineRate = 48000): number {
  if (opts.format === 'opus') return 48000;
  return opts.sampleRate ?? engineRate;
}

/**
 * Per-render cache of dithered integer samples by bit depth and dither.
 * Passing the same cache to every encode of one render keeps its WAV and
 * FLAC bit-identical (one quantization, not one per file).
 */
export type QuantCache = Map<string, { qL: Int32Array; qR: Int32Array }>;

function quantized(L: Float32Array, R: Float32Array, bitDepth: 16 | 24, dither: DitherKind, cache?: QuantCache) {
  const key = `${bitDepth}:${bitDepth === 16 ? dither : 'tpdf'}`;
  const hit = cache?.get(key);
  if (hit) return hit;
  const q = quantizeStereo(L, R, bitDepth, dither);
  cache?.set(key, q);
  return q;
}

/**
 * Encodes a master. `sampleRate` is the rate L and R are AT; a format that
 * can't carry it (Opus is 48 kHz by definition) is converted on the way.
 */
export async function encodeAudio(
  L: Float32Array,
  R: Float32Array,
  sampleRate: number,
  opts: EncodeOptions,
  cache?: QuantCache,
): Promise<Encoded> {
  const depth = effectiveBitDepth(opts);
  // The PCM writers pack 16- and 24-bit samples, the float writer 32; any
  // other depth would produce headers that disagree with the data.
  if ((opts.format === 'wav' || opts.format === 'flac') && depth !== 16 && depth !== 24 && depth !== 32) {
    throw new Error(`unsupported bit depth ${opts.bitDepth}`);
  }
  const dither = opts.dither ?? 'tpdf';
  const t = opts.tags;
  const trackStr = t?.trackNumber
    ? t.trackTotal ? `${t.trackNumber}/${t.trackTotal}` : `${t.trackNumber}`
    : undefined;

  switch (opts.format) {
    case 'wav': {
      const wavTags: WavInfoTags | undefined = t && {
        title: t.title,
        artist: t.artist,
        album: t.album,
        year: t.year,
        genre: t.genre,
        comment: joinComment(t),
        rawComment: t.comment,
        catalog: t.catalog,
        isrc: t.isrc,
        track: trackStr,
        picture: t.picture,
      };
      if (depth === 32) {
        return { data: encodeWavFloat(L, R, sampleRate, wavTags), ext: 'wav', mime: 'audio/wav' };
      }
      const { qL, qR } = quantized(L, R, depth, dither, cache);
      return {
        data: encodeWavFromInt(qL, qR, sampleRate, depth, wavTags),
        ext: 'wav', mime: 'audio/wav',
      };
    }
    case 'flac': {
      const flacTags: FlacTags = {};
      if (t?.title) flacTags.TITLE = t.title;
      if (t?.artist) flacTags.ARTIST = t.artist;
      if (t?.album) flacTags.ALBUM = t.album;
      if (t?.year) flacTags.DATE = t.year;
      if (t?.genre) flacTags.GENRE = t.genre;
      if (t?.catalog) flacTags.CATALOGNUMBER = t.catalog;
      if (t?.isrc) flacTags.ISRC = t.isrc;
      if (t?.comment) flacTags.COMMENT = t.comment;
      if (trackStr) flacTags.TRACKNUMBER = `${t!.trackNumber}`;
      if (t?.trackTotal) flacTags.TRACKTOTAL = `${t.trackTotal}`;
      const { qL, qR } = quantized(L, R, depth as 16 | 24, dither, cache);
      return {
        data: encodeFlacFromInt(qL, qR, sampleRate, depth as 16 | 24, flacTags, t?.picture),
        ext: 'flac', mime: 'audio/flac',
      };
    }
    case 'opus': {
      const opusTags: OpusTagsInput = {};
      if (t?.title) opusTags.TITLE = t.title;
      if (t?.artist) opusTags.ARTIST = t.artist;
      if (t?.album) opusTags.ALBUM = t.album;
      if (t?.year) opusTags.DATE = t.year;
      if (t?.genre) opusTags.GENRE = t.genre;
      if (t?.catalog) opusTags.CATALOGNUMBER = t.catalog;
      if (t?.isrc) opusTags.ISRC = t.isrc;
      if (t?.comment) opusTags.COMMENT = t.comment;
      if (t?.trackNumber) opusTags.TRACKNUMBER = `${t.trackNumber}`;
      if (t?.trackTotal) opusTags.TRACKTOTAL = `${t.trackTotal}`;
      // Opus codes at 48 kHz whatever it is handed; a master at another
      // rate is converted here, with the app's own filter.
      const oL = sampleRate === 48000 ? L : resample(L, sampleRate, 48000);
      const oR = sampleRate === 48000 ? R : resample(R, sampleRate, 48000);
      const data = await encodeOggOpus(oL, oR, 48000, opts.opusKbps ?? 192, opusTags, t?.picture);
      return { data, ext: 'opus', mime: 'audio/ogg' };
    }
    case 'mp3': {
      const id3Tags: Id3Tags | undefined = t && {
        title: t.title,
        artist: t.artist,
        album: t.album,
        year: t.year,
        genre: t.genre,
        comment: t.comment,
        catalog: t.catalog,
        isrc: t.isrc,
        track: trackStr,
        picture: t.picture,
      };
      // The Info frame says where the music starts and ends inside the
      // encoder's padding, so the file decodes to the samples that went in.
      const audio = withInfoFrame(new Uint8Array(encodeMp3(L, R, sampleRate, opts.mp3Kbps)), L.length).data;
      const tag = id3Tags ? buildId3v23(id3Tags) : new Uint8Array(0);
      const out = new Uint8Array(tag.length + audio.byteLength);
      out.set(tag, 0);
      out.set(audio, tag.length);
      return { data: out.buffer, ext: 'mp3', mime: 'audio/mpeg' };
    }
  }
}

/**
 * Catalogue number and comment in one line, for a tag format with a single
 * comment field. Plain ASCII between them: the INFO chunk it goes into has
 * no declared encoding, and a middle dot there showed as "Â·" in Explorer.
 */
function joinComment(t: TrackTags): string | undefined {
  const parts: string[] = [];
  if (t.catalog) parts.push(`CAT. ${t.catalog}`);
  if (t.comment) parts.push(t.comment);
  return parts.length > 0 ? parts.join(' - ') : undefined;
}

function encodeMp3(L: Float32Array, R: Float32Array, sampleRate: number, kbps: number): ArrayBuffer {
  const enc = new Mp3Encoder(2, sampleRate, kbps);
  const n = L.length;
  const CHUNK = 1152;
  const l16 = new Int16Array(CHUNK);
  const r16 = new Int16Array(CHUNK);
  const parts: Uint8Array[] = [];
  for (let s = 0; s < n; s += CHUNK) {
    const len = Math.min(CHUNK, n - s);
    for (let i = 0; i < len; i++) {
      l16[i] = clamp16(L[s + i]);
      r16[i] = clamp16(R[s + i]);
    }
    const part = enc.encodeBuffer(l16.subarray(0, len), r16.subarray(0, len));
    if (part.length > 0) parts.push(new Uint8Array(part));
  }
  const tail = enc.flush();
  if (tail.length > 0) parts.push(new Uint8Array(tail));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out.buffer;
}

function clamp16(v: number): number {
  const s = Math.round(v * 32767);
  return s > 32767 ? 32767 : s < -32768 ? -32768 : s;
}
