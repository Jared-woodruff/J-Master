// A tempo analysis re-read at double or half time. Which of two octaves is
// "the" tempo is a matter of feel (a 174 BPM break and its 87 BPM
// half-time are the same music), so when the analysis picks the other one
// the grid can simply be switched. Pure.
import type { TempoInfo } from '../audio/engine';

export function scaleTempo(t: TempoInfo, factor: 2 | 0.5): TempoInfo {
  if (!(t.bpm > 0)) return t;
  let beats: number[];
  let downbeat: number;
  if (factor === 2) {
    // A beat between every two.
    beats = [];
    for (let i = 0; i < t.beats.length; i++) {
      beats.push(t.beats[i]);
      if (i + 1 < t.beats.length) beats.push((t.beats[i] + t.beats[i + 1]) / 2);
    }
    downbeat = t.downbeat * 2;
  } else {
    // Every other beat, keeping the ones the bar lines sit on.
    const start = t.downbeat % 2;
    beats = t.beats.filter((_, i) => i >= start && (i - start) % 2 === 0);
    downbeat = Math.floor((t.downbeat - start) / 2) % 4;
  }
  const s = (v: number) => v * factor;
  return {
    ...t,
    bpm: s(t.bpm),
    beats,
    downbeat,
    curve: t.curve ? { ...t.curve, bpm: t.curve.bpm.map((v) => (Number.isFinite(v) ? s(v) : v)) } : null,
    drift: t.drift
      ? {
          ...t.drift,
          refBpm: s(t.drift.refBpm), endBpm: s(t.drift.endBpm), minBpm: s(t.drift.minBpm), maxBpm: s(t.drift.maxBpm),
          regions: t.drift.regions.map((r) => ({ ...r, peakBpm: s(r.peakBpm) })),
        }
      : null,
  };
}
