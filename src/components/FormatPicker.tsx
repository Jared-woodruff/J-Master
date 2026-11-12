// The delivery format, shared by EXPORT and BATCH: container, then what
// that container can vary (depth or bitrate), the sample rate, and, for a
// 16-bit file, how the last bit is dithered.
import { useStore } from '../state/store';
import { EXPORT_RATES, type ExportFormat } from '../audio/encode';

const FORMATS: { id: ExportFormat; label: string; title: string }[] = [
  { id: 'wav', label: 'WAV', title: 'Uncompressed PCM: what distributors and CD plants ask for' },
  { id: 'flac', label: 'FLAC', title: 'Lossless, about half the size of WAV, with tags and cover art' },
  { id: 'mp3', label: 'MP3', title: 'Lossy, plays everywhere · constant bitrate' },
  { id: 'opus', label: 'OPUS', title: 'Lossy, the best quality per bit · Ogg Opus, always 48 kHz' },
];

export function FormatPicker({ disabled, compact = false }: { disabled: boolean; compact?: boolean }) {
  const format = useStore((s) => s.exportFormat);
  const bitDepth = useStore((s) => s.exportBitDepth);
  const rate = useStore((s) => s.exportRate);
  const dither = useStore((s) => s.exportDither);
  const mp3Kbps = useStore((s) => s.exportMp3Kbps);
  const opusKbps = useStore((s) => s.exportOpusKbps);
  const setExportFormat = useStore((s) => s.setExportFormat);
  const setExportBitDepth = useStore((s) => s.setExportBitDepth);
  const setExportRate = useStore((s) => s.setExportRate);
  const setExportDither = useStore((s) => s.setExportDither);
  const setExportMp3Kbps = useStore((s) => s.setExportMp3Kbps);
  const setExportOpusKbps = useStore((s) => s.setExportOpusKbps);

  const lossless = format === 'wav' || format === 'flac';
  const k = compact ? '' : 'K';
  const seg = <T extends string | number>(
    label: string, value: T, options: { id: T; label: string; title?: string }[], onPick: (v: T) => void,
  ) => (
    <div className="seg grow" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.id)} className={value === o.id ? 'on' : ''} aria-pressed={value === o.id}
          disabled={disabled} title={o.title} onClick={() => onPick(o.id)}>{o.label}</button>
      ))}
    </div>
  );

  return (
    <>
      {seg('Format', format, FORMATS, setExportFormat)}
      {lossless && seg('Bit depth', bitDepth, [
        { id: 16 as const, label: compact ? '16' : '16 BIT', title: '16-bit: CD and most stores · dithered' },
        { id: 24 as const, label: compact ? '24' : '24 BIT', title: '24-bit: the usual delivery master' },
        ...(format === 'wav'
          ? [{ id: 32 as const, label: compact ? '32F' : '32 FLOAT', title: '32-bit float WAV: for more work in a DAW · nothing is rounded or dithered' }]
          : []),
      ], setExportBitDepth)}
      {format === 'mp3' && seg('Bitrate', mp3Kbps, [
        { id: 320 as const, label: `320${k}` }, { id: 256 as const, label: `256${k}` }, { id: 192 as const, label: `192${k}` },
      ], setExportMp3Kbps)}
      {format === 'opus' && seg('Bitrate', opusKbps, [
        { id: 256 as const, label: `256${k}` }, { id: 192 as const, label: `192${k}` }, { id: 128 as const, label: `128${k}` },
      ], setExportOpusKbps)}
      {!compact && <span className="fmtbreak" />}
      {format !== 'opus' && seg('Sample rate', rate, EXPORT_RATES.map((r) => ({
        id: r,
        label: r === 44100 ? '44.1K' : '48K',
        title: r === 44100
          ? '44.1 kHz: CD, and what most stores list · converted by the app’s own filter before the loudness solve, so the ceiling holds on the samples you ship'
          : '48 kHz: the engine’s own rate, and video’s',
      })), setExportRate)}
      {lossless && bitDepth === 16 && seg('Dither', dither, [
        { id: 'tpdf' as const, label: 'TPDF', title: 'Flat dither: the safe default, right for anything that will be processed again' },
        { id: 'shaped' as const, label: 'SHAPED', title: 'Noise-shaped dither: moves the noise up where the ear is least sensitive, about 10 dB quieter where it matters · for the final file only' },
      ], setExportDither)}
    </>
  );
}
