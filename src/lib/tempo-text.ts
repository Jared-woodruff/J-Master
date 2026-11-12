// Spec-sheet wording for tempo and drift, shared by the track strip, the
// diagnosis sheet and the waveform.
import type { TempoDrift } from '../audio/engine';

/** m:ss, floored like the transport's timecode. */
export function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A tempo as a file name or a toast says it: "138", "138.5". */
export function bpmText(bpm: number): string {
  const r = Math.round(bpm * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** "138.0 → 145.9 BPM" */
export function driftRange(d: TempoDrift): string {
  return `${d.refBpm.toFixed(1)} → ${d.endBpm.toFixed(1)} BPM`;
}

/** How far a fixed grid slides, in time and in beats: "1.57 S · 3.7 BEATS". */
export function slipText(d: TempoDrift, bpm: number): string {
  const time = d.maxSlipSec >= 1 ? `${d.maxSlipSec.toFixed(2)} S` : `${Math.round(d.maxSlipSec * 1000)} MS`;
  const beats = (d.maxSlipSec * bpm) / 60;
  return `${time} · ${beats >= 1 ? beats.toFixed(1) : beats.toFixed(2)} BEAT${beats >= 0.995 && beats < 1.005 ? '' : 'S'}`;
}

/** Signed change from the reference: "+7.9 BPM (+5.7%)". */
export function driftDelta(d: TempoDrift, bpm: number): string {
  const delta = bpm - d.refBpm;
  const pct = (delta / d.refBpm) * 100;
  const sign = delta >= 0 ? '+' : '−';
  return `${sign}${Math.abs(delta).toFixed(1)} BPM (${sign}${Math.abs(pct).toFixed(1)}%)`;
}
