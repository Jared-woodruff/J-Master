// Export encoding dispatch: WAV (PCM + RIFF INFO), FLAC (lossless + Vorbis
// comments), MP3 (lamejs + ID3v2.3). Runs inside the render worker.
// WAV and FLAC share one dithered quantization pass, so the two lossless
// formats of the same render carry bit-identical samples.
import { encodeWavFromInt, WavInfoTags } from './wav';
import { encodeFlacFromInt, quantizeStereo, FlacTags } from './flac';
import { buildId3v23, Id3Tags } from './id3';
import { encodeOggOpus, OpusTagsInput } from './ogg-opus';
import { Mp3Encoder } from '@breezystack/lamejs';

export type ExportFormat = 'wav' | 'flac' | 'mp3' | 'opus';

export interface TrackTags {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  genre?: string;
  catalog?: string;
  comment?: string;
  trackNumber?: number;
  trackTotal?: number;
}

export interface EncodeOptions {
  format: ExportFormat;
  bitDepth: 16 | 24;         // wav + flac
  mp3Kbps: 192 | 256 | 320;  // mp3
  opusKbps?: 128 | 192 | 256; // opus
  tags?: TrackTags;
}

export interface Encoded {
  data: ArrayBuffer;
  ext: string;
  mime: string;
}

export async function encodeAudio(
  L: Float32Array,
  R: Float32Array,
  sampleRate: number,
  opts: EncodeOptions,
): Promise<Encoded> {
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
        track: trackStr,
      };
      const { qL, qR } = quantizeStereo(L, R, opts.bitDepth);
      return {
        data: encodeWavFromInt(qL, qR, sampleRate, opts.bitDepth, wavTags),
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
      if (t?.comment) flacTags.COMMENT = t.comment;
      if (trackStr) flacTags.TRACKNUMBER = `${t!.trackNumber}`;
      if (t?.trackTotal) flacTags.TRACKTOTAL = `${t.trackTotal}`;
      const { qL, qR } = quantizeStereo(L, R, opts.bitDepth);
      return {
        data: encodeFlacFromInt(qL, qR, sampleRate, opts.bitDepth, flacTags),
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
      if (t?.comment) opusTags.COMMENT = t.comment;
      if (t?.trackNumber) opusTags.TRACKNUMBER = `${t.trackNumber}`;
      const data = await encodeOggOpus(L, R, sampleRate, opts.opusKbps ?? 192, opusTags);
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
        track: trackStr,
      };
      const audio = encodeMp3(L, R, sampleRate, opts.mp3Kbps);
      const tag = id3Tags ? buildId3v23(id3Tags) : new Uint8Array(0);
      const out = new Uint8Array(tag.length + audio.byteLength);
      out.set(tag, 0);
      out.set(new Uint8Array(audio), tag.length);
      return { data: out.buffer, ext: 'mp3', mime: 'audio/mpeg' };
    }
  }
}

function joinComment(t: TrackTags): string | undefined {
  const parts: string[] = [];
  if (t.catalog) parts.push(`CAT. ${t.catalog}`);
  if (t.comment) parts.push(t.comment);
  return parts.length > 0 ? parts.join(' · ') : undefined;
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
