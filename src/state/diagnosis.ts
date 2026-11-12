// The check sheet's rules: from what was measured at load to the rows it
// shows and the fixes it offers. Pure: no store, no engine.
//
// The rule that shapes all of it: a fix is never applied silently. Each is
// offered with the number that prompted it, and the ones that add or take
// away music (the fade-out) arrive unticked.
import type { SourceDiagnostics, SourceChecks, TempoInfo } from '../audio/engine';
import type { SourceFix } from '../audio/dsp/params';
import { FULL_BAND_HZ } from '../audio/analysis/source-checks';
import { driftRange, mmss } from '../lib/tempo-text';

export type DiagAction =
  | { type: 'bassMono' }
  | { type: 'width'; value: number }
  | { type: 'balance' }
  | { type: 'smooth'; value: number }
  | { type: 'sourceFix'; mode: SourceFix }
  | { type: 'restoreAir'; hz: number; amount: number }
  | { type: 'trim'; startSec: number; endSec: number }
  | { type: 'fadeIn'; sec: number }
  | { type: 'fadeOut'; sec: number };

export interface DiagIssue {
  id: string;
  label: string;
  /** Measured value, spec-sheet style. */
  spec: string;
  /** What APPLY will do. */
  fixLabel: string;
  action: DiagAction;
  checked: boolean;
}

export interface DiagCheck {
  label: string;
  spec: string;
  pass: boolean;
}

export const TEMPO_CHECK = 'TEMPO STABILITY';

export interface DriftRepair {
  targetBpm: number;
  /** The drift it removed: the tempo the file set out at and ended on. */
  fromBpm: number;
  toBpm: number;
  originalDurationSec: number;
}

/** Silence before the music longer than this is dead air… */
const HEAD_TRIM_SEC = 0.5;
/** …and after it, longer than this (a reverb tail can hang for a second or two). */
const TAIL_TRIM_SEC = 2;
/** A trim leaves this much room before the first sound and after the last. */
const HEAD_ROOM_SEC = 0.05;
const TAIL_ROOM_SEC = 0.5;
/** How much of AIR RESTORE the check sheet offers: the new band 14 dB under the octave it grows from. */
const RESTORE_OFFER = 0.4;

/** Derives AI-music pathology issues + the full check sheet from measurements. */
export function deriveDiagnosis(
  d: SourceDiagnostics,
  balanceOffsetDb: number,
  c: SourceChecks | null | undefined,
  durationSec: number,
): { issues: DiagIssue[]; checks: DiagCheck[] } {
  const issues: DiagIssue[] = [];
  const checks: DiagCheck[] = [];

  // ── the channels themselves, first: the stereo checks mean nothing on a
  // file with a dead or inverted side ────────────────────────────────────
  const inverted = !d.deadChannel && d.corrMean < -0.5;
  const channelFault = !!d.deadChannel || inverted;
  if (d.deadChannel) {
    const dead = d.deadChannel.toUpperCase();
    const live = d.deadChannel === 'right' ? 'left' : 'right';
    checks.push({ label: 'CHANNELS', spec: `${dead} SIDE IS SILENT`, pass: false });
    issues.push({
      id: 'channels', label: 'ONE SIDE SILENT', spec: `NOTHING ON THE ${dead}`,
      fixLabel: `${live.toUpperCase()} ON BOTH SIDES`,
      action: { type: 'sourceFix', mode: live }, checked: true,
    });
  } else if (inverted) {
    checks.push({ label: 'CHANNELS', spec: `OUT OF PHASE · CORR ${d.corrMean.toFixed(2)}`, pass: false });
    issues.push({
      id: 'channels', label: 'ONE SIDE INVERTED', spec: `CORR ${d.corrMean.toFixed(2)} · MONO CANCELS`,
      fixLabel: 'TURN THE RIGHT SIDE OVER',
      action: { type: 'sourceFix', mode: 'flip' }, checked: true,
    });
  } else {
    checks.push({ label: 'CHANNELS', spec: 'BOTH SIDES · IN PHASE', pass: true });
  }

  const bassBad = !channelFault && d.sideBassRelDb > -12;
  checks.push({
    label: 'BASS PLACEMENT',
    spec: channelFault ? 'NOT JUDGED · CHANNELS FIRST' : `SIDE ${d.sideBassRelDb.toFixed(1)} dB VS MID · <140 HZ`,
    pass: !bassBad,
  });
  if (bassBad) {
    issues.push({
      id: 'bassmono', label: 'BASS IN SIDES',
      spec: `SIDE LOW ${d.sideBassRelDb.toFixed(1)} dB VS MID`,
      fixLabel: 'MONO BELOW 140 HZ',
      action: { type: 'bassMono' }, checked: true,
    });
  }

  const widthBad = !channelFault && (d.corrWorst < 0.15 || d.corrMean < 0.5);
  checks.push({
    label: 'WIDTH STABILITY',
    spec: channelFault ? 'NOT JUDGED · CHANNELS FIRST' : `CORR MEAN ${d.corrMean.toFixed(2)} · WORST ${d.corrWorst.toFixed(2)}`,
    pass: !widthBad,
  });
  if (widthBad) {
    const suggested = d.corrWorst < 0 || d.corrMean < 0.35 ? 0.85 : 0.92;
    issues.push({
      id: 'width', label: 'UNSTABLE WIDTH',
      spec: `CORR MEAN ${d.corrMean.toFixed(2)} · WORST ${d.corrWorst.toFixed(2)}`,
      fixLabel: `WIDTH ${Math.round(suggested * 100)}%`,
      action: { type: 'width', value: suggested }, checked: true,
    });
  }

  const leanBad = !channelFault && Math.abs(balanceOffsetDb) >= 0.3;
  checks.push({
    label: 'IMAGE BALANCE',
    spec: channelFault ? 'NOT JUDGED · CHANNELS FIRST'
      : Math.abs(balanceOffsetDb) < 0.05 ? 'CENTRED'
      : `${balanceOffsetDb >= 0 ? 'R' : 'L'} ${Math.abs(balanceOffsetDb).toFixed(1)} dB HOT`,
    pass: !leanBad,
  });
  if (leanBad) {
    issues.push({
      id: 'balance', label: 'IMAGE LEAN',
      spec: `${balanceOffsetDb >= 0 ? 'RIGHT' : 'LEFT'} ${Math.abs(balanceOffsetDb).toFixed(1)} dB HOT`,
      fixLabel: 'AUTO-CENTER',
      action: { type: 'balance' }, checked: true,
    });
  }

  const harshBad = d.harshRelDb > -10;
  checks.push({
    label: 'HF TEXTURE',
    spec: `>4.5 KHZ ${d.harshRelDb.toFixed(1)} dB REL`,
    pass: !harshBad,
  });
  if (harshBad) {
    const suggested = d.harshRelDb > -7 ? 0.5 : 0.3;
    issues.push({
      id: 'smooth', label: 'HARSH HIGHS',
      spec: `>4.5 KHZ ${d.harshRelDb.toFixed(1)} dB REL`,
      fixLabel: `SMOOTH ${Math.round(suggested * 100)}%`,
      action: { type: 'smooth', value: suggested }, checked: true,
    });
  }

  if (!c) return { issues, checks };

  // ── how the file was made ─────────────────────────────────────────────
  const cut = c.cutoffHz;
  const limited = cut !== null && cut < FULL_BAND_HZ;
  const khz = (hz: number) => (hz / 1000).toFixed(1);
  checks.push({
    label: 'BANDWIDTH',
    spec: limited ? `STOPS AT ${khz(cut!)} KHZ · ${Math.round(c.cutoffDropDb)} dB CLIFF` : 'FULL · TO 20 KHZ',
    pass: !limited,
  });
  if (limited) {
    issues.push({
      id: 'air', label: 'TOP END MISSING',
      spec: `NOTHING ABOVE ${khz(cut!)} KHZ`,
      fixLabel: `RESTORE AIR ABOVE ${khz(cut!)} KHZ`,
      action: { type: 'restoreAir', hz: cut!, amount: RESTORE_OFFER }, checked: true,
    });
  }

  const trimHead = c.headSilenceSec > HEAD_TRIM_SEC;
  const trimTail = c.tailSilenceSec > TAIL_TRIM_SEC;
  checks.push({
    label: 'TOP & TAIL',
    spec: c.headSilenceSec < 0.05 && c.tailSilenceSec < 0.05 ? 'NO DEAD AIR'
      : `${c.headSilenceSec.toFixed(1)} S SILENT BEFORE · ${c.tailSilenceSec.toFixed(1)} S AFTER`,
    pass: !(trimHead || trimTail),
  });
  if (trimHead || trimTail) {
    const startSec = trimHead ? +Math.max(0, c.headSilenceSec - HEAD_ROOM_SEC).toFixed(3) : 0;
    const endSec = trimTail ? +Math.min(durationSec, durationSec - c.tailSilenceSec + TAIL_ROOM_SEC).toFixed(3) : 0;
    issues.push({
      id: 'trim', label: 'DEAD AIR',
      spec: [trimHead ? `${c.headSilenceSec.toFixed(1)} S BEFORE` : '', trimTail ? `${c.tailSilenceSec.toFixed(1)} S AFTER` : '']
        .filter(Boolean).join(' · '),
      fixLabel: `TRIM TO ${mmss(startSec)} – ${mmss(endSec || durationSec)}`,
      action: { type: 'trim', startSec, endSec }, checked: true,
    });
  }

  checks.push({
    label: 'EDGES',
    spec: c.abruptStart && c.abruptEnd ? 'STARTS AND ENDS MID-SOUND'
      : c.abruptStart ? `STARTS MID-SOUND · ${c.startLevelDb.toFixed(0)} dBFS`
      : c.abruptEnd ? `ENDS MID-SOUND · ${c.endLevelDb.toFixed(0)} dBFS`
      : 'CLEAN IN · CLEAN OUT',
    pass: !(c.abruptStart || c.abruptEnd),
  });
  if (c.abruptStart) {
    issues.push({
      id: 'fadein', label: 'STARTS MID-SOUND',
      spec: `${c.startLevelDb.toFixed(0)} dBFS AT THE FIRST SAMPLE`,
      fixLabel: '10 MS FADE IN',
      action: { type: 'fadeIn', sec: 0.01 }, checked: true,
    });
  }
  if (c.abruptEnd) {
    const sec = +Math.max(0.5, Math.min(3, durationSec / 6)).toFixed(1);
    issues.push({
      id: 'fadeout', label: 'ENDS MID-SOUND',
      spec: `${c.endLevelDb.toFixed(0)} dBFS AT THE LAST SAMPLE`,
      fixLabel: `${sec.toFixed(1)} S FADE OUT`,
      // A fade changes the ending itself: offered, never assumed.
      action: { type: 'fadeOut', sec }, checked: false,
    });
  }

  checks.push({
    label: 'PEAKS',
    spec: c.clippedRuns > 0
      ? `${c.clippedRuns} FLAT TOP${c.clippedRuns > 1 ? 'S' : ''} · CLIPPED BEFORE IT GOT HERE`
      : 'NO FLAT TOPS',
    pass: c.clippedRuns < 5,
  });

  return { issues, checks };
}

/** The check-sheet row for the tempo analysis. */
export function tempoCheck(t: TempoInfo, repair: DriftRepair | null): DiagCheck {
  if (t.drift) {
    return {
      label: TEMPO_CHECK,
      spec: `DRIFTS ${driftRange(t.drift)} FROM ${mmss(t.drift.regions[0]?.startSec ?? 0)}`,
      pass: false,
    };
  }
  const vals = (t.curve?.bpm ?? []).filter(Number.isFinite);
  if (t.confidence < 0.25 || vals.length === 0) {
    return { label: TEMPO_CHECK, spec: 'NO CLEAR PULSE · NOT JUDGED', pass: true };
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return {
    label: TEMPO_CHECK,
    spec: `STEADY ${t.bpm.toFixed(1)} BPM · ${repair ? 'DRIFT REPAIRED' : `±${((hi - lo) / 2).toFixed(2)}`}`,
    pass: true,
  };
}

/** Whether a check-sheet fix is already covered by the console as it stands. */
export function fixApplied(
  i: DiagIssue,
  s: {
    macros: { width: number; smooth: number }; bassMono: boolean; balanceDb: number; sourceFix: SourceFix;
    airRestore: number; trimStartSec: number; trimEndSec: number; fadeInSec: number; fadeOutSec: number;
  },
  balanceOffsetDb: number,
): boolean {
  const a = i.action;
  switch (a.type) {
    case 'bassMono': return s.bassMono;
    case 'width': return s.macros.width <= a.value + 0.005;
    case 'smooth': return s.macros.smooth >= a.value - 0.005;
    case 'balance': {
      const wanted = Math.max(-3, Math.min(3, +(-balanceOffsetDb).toFixed(1)));
      return Math.abs(s.balanceDb - wanted) <= 0.05;
    }
    case 'sourceFix': return s.sourceFix === a.mode;
    case 'restoreAir': return s.airRestore > 0.001;
    case 'trim':
      return (a.startSec <= 0 || s.trimStartSec >= a.startSec - 0.01)
        && (a.endSec <= 0 || (s.trimEndSec > 0 && s.trimEndSec <= a.endSec + 0.01));
    case 'fadeIn': return s.fadeInSec >= a.sec - 1e-6;
    case 'fadeOut': return s.fadeOutSec >= Math.min(a.sec, 0.25);
  }
}
