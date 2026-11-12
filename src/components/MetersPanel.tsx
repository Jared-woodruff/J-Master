// The metering rack. Loudness (momentary, short-term, integrated, with the
// peak-to-loudness ratios and the running range), true peak per side with a
// latched maximum and an over count, gain reduction stage by stage, stereo
// correlation across the band and below 150 Hz, and an analyser well with
// three views: spectrum, vectorscope, loudness against track position.
//
// Meter frames arrive about 47 times a second. None of them goes through
// React: the bars and figures are written straight to the DOM by `paint`,
// and the canvases read the engine and the store inside their own draw
// loops. React renders the rack itself and what changes rarely (the view,
// the target, the monitor matrix).
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useStore, normPreviewGainDb } from '../state/store';
import { engine, type MeterFrame } from '../audio/engine';
import { PLATFORMS } from '../audio/dsp/params';
import { OVER_MARGIN_DB, levelText } from '../lib/meter-math';
import { book } from './meters/book';
import { Spectrum } from './meters/Spectrum';
import { Scope } from './meters/Scope';
import { LoudnessHistory } from './meters/LoudnessHistory';
import '../styles/meters.css';

// ── scales ────────────────────────────────────────────────────────────
const LUFS_MIN = -36;
const TP_MIN = -30;
const TP_MAX = 3;
const GR_MAX = 12;

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);
const lufs01 = (v: number): number => clamp01((v - LUFS_MIN) / -LUFS_MIN);
const tp01 = (v: number): number => clamp01((v - TP_MIN) / (TP_MAX - TP_MIN));
/** Square-root scale: the first decibel of reduction is the one worth seeing. */
const gr01 = (v: number): number => Math.sqrt(clamp01(v / GR_MAX));
/** Where 3 dB and 6 dB sit on that scale, for the notches. */
const GR_NOTCHES = [gr01(3) * 100, gr01(6) * 100];

const grText = (v: number): string => (v < 0.05 ? '0.0' : `-${v.toFixed(1)}`);
const ratioText = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '--.-');

// Distinct normalization behaviours: -14 turn-down (Spotify, YouTube) and
// Apple's -16.
const NORM_PLATFORMS = [
  { id: null, label: 'OFF', short: 'OFF', name: '' },
  { id: 'spotify', label: 'SPOTIFY', short: 'SPOT', name: 'Spotify' },
  { id: 'apple', label: 'APPLE', short: 'APPLE', name: 'Apple Music' },
  { id: 'youtube', label: 'YOUTUBE', short: 'YT', name: 'YouTube' },
] as const;

const MONITOR_MODES = [
  { id: 'stereo', label: 'ST' },
  { id: 'mono', label: 'MONO' },
  { id: 'side', label: 'SIDE' },
  { id: 'left', label: 'L' },
  { id: 'right', label: 'R' },
] as const;

const VIEWS = [
  { id: 'spectrum', label: 'SPECTRUM', title: 'Live spectrum: the master against the loudness-matched source' },
  { id: 'scope', label: 'SCOPE', title: 'Vectorscope: mono is a vertical line, width spreads it sideways, phase trouble leans horizontal' },
  { id: 'loudness', label: 'LOUDNESS', title: 'The loudness of what you have played, where in the track you heard it, against the target' },
] as const;

// ── the glass: what paint writes to ───────────────────────────────────
/**
 * The rack's live elements by name, and the last thing written to each, so
 * a frame that changes nothing costs nothing.
 */
class Glass {
  private readonly els = new Map<string, HTMLElement>();
  private readonly last = new Map<string, string>();
  private readonly binders = new Map<string, (el: HTMLElement | null) => void>();

  /** A ref callback for `key`: the same function every render, so React only calls it on mount and unmount. */
  bind(key: string): (el: HTMLElement | null) => void {
    let fn = this.binders.get(key);
    if (!fn) {
      fn = (el) => {
        if (el) this.els.set(key, el); else this.els.delete(key);
        // A new element has none of what was written to the last one.
        for (const id of [...this.last.keys()]) if (id.startsWith(`${key}\n`)) this.last.delete(id);
      };
      this.binders.set(key, fn);
    }
    return fn;
  }

  private put(key: string, slot: string, value: string, write: (el: HTMLElement, v: string) => void): void {
    const el = this.els.get(key);
    if (!el) return;
    const id = `${key}\n${slot}`;
    if (this.last.get(id) === value) return;
    this.last.set(id, value);
    write(el, value);
  }

  /** A fill, 0 to 1 of its track (negative runs the other way from its origin). */
  scale(key: string, v: number): void {
    this.put(key, 't', `scaleX(${v.toFixed(4)})`, (el, s) => { el.style.transform = s; });
  }

  /** A tick, 0 to 1 along its track. */
  shift(key: string, v: number): void {
    this.put(key, 't', `translateX(${(v * 100).toFixed(2)}%)`, (el, s) => { el.style.transform = s; });
  }

  text(key: string, s: string): void {
    this.put(key, 'x', s, (el, v) => { el.textContent = v; });
  }

  state(key: string, s: string): void {
    this.put(key, 's', s, (el, v) => { el.dataset.state = v; });
  }
}

/** Which source the book was last set up for (the panel can remount on the same one). */
let bookSource: unknown;

/**
 * One meter frame onto the glass. Bars and ticks move every frame; the
 * figures change a dozen times a second, which is as fast as they can be read.
 */
function paint(g: Glass, m: MeterFrame | null, figures: boolean): void {
  const ceilingDb = useStore.getState().ceilingDb;
  const live = !!m && !m.idle;

  g.scale('m', m ? lufs01(m.momentary) : 0);
  g.scale('s', m ? lufs01(m.shortTerm) : 0);
  g.scale('i', m ? lufs01(m.integrated) : 0);

  const peak = (key: string, now: number, held: number) => {
    g.scale(key, tp01(now));
    g.shift(`${key}-hold`, tp01(held));
    g.state(`${key}-hold`, held <= TP_MIN ? 'off' : held > ceilingDb + OVER_MARGIN_DB ? 'over' : 'on');
  };
  peak('tpl', m ? m.peakLDb : -200, book.holdL.value);
  peak('tpr', m ? m.peakRDb : -200, book.holdR.value);

  const reduction = (key: string, now: number, held: number) => {
    g.scale(key, gr01(now));
    g.shift(`${key}-hold`, gr01(held));
    g.state(`${key}-hold`, held < 0.05 ? 'off' : 'on');
  };
  reduction('grs', m ? m.deharshGrDb : 0, book.holdSmooth.value);
  reduction('grc', m ? m.compGrDb : 0, book.holdComp.value);
  reduction('grk', m ? m.clipGrDb : 0, book.holdClip.value);
  reduction('grl', m ? m.limiterGrDb : 0, book.holdLimit.value);

  const corr = m ? Math.max(-1, Math.min(1, m.correlation)) : 0;
  const corrLow = m ? Math.max(-1, Math.min(1, m.correlationLow)) : 0;
  g.scale('corr', corr);
  g.state('corr', corr < 0 ? 'neg' : 'pos');
  g.scale('corrlow', corrLow);
  g.state('corrlow', corrLow < 0 ? 'neg' : 'pos');

  if (!figures) return;
  g.text('m-val', m ? levelText(m.momentary) : '--.-');
  g.text('s-val', m ? levelText(m.shortTerm) : '--.-');
  g.text('i-val', m ? levelText(m.integrated) : '--.-');
  g.text('psr-val', ratioText(book.psr));
  g.text('plr-val', ratioText(book.plr));
  g.text('lra-val', ratioText(book.lra));

  g.text('tp-val', levelText(Math.max(book.holdL.value, book.holdR.value), -99));
  const overs = book.overs.count;
  g.text('tp-max', levelText(book.tpMax, -99));
  g.text('tp-overs', `${overs} OVER`);
  g.state('tp-latch', overs > 0 ? 'over' : live ? 'run' : 'rest');

  g.text('grs-val', grText(book.holdSmooth.value));
  g.text('grc-val', grText(book.holdComp.value));
  g.text('grk-val', grText(book.holdClip.value));
  g.text('grl-val', grText(book.holdLimit.value));

  g.text('corr-val', m ? corr.toFixed(2) : '-.--');
  g.text('corrlow-val', m ? corrLow.toFixed(2) : '-.--');
  g.state('corr-note', book.lowPhaseWarn ? 'warn' : 'rest');
  g.text('corr-note', book.lowPhaseWarn ? 'LOW END OUT OF PHASE · CANCELS IN MONO' : '');
}

// ── rows ──────────────────────────────────────────────────────────────
function Row({ g, k, label, title, mark, hold, neutral, notches }: {
  g: Glass; k: string; label: string; title: string;
  /** A fixed mark on the track (the target, the ceiling), percent. */
  mark?: number;
  hold?: boolean;
  neutral?: boolean;
  notches?: number[];
}) {
  return (
    <div className="mx-row" title={title}>
      <span className="mx-label">{label}</span>
      <div className="mx-track">
        <div className={`mx-fill${neutral ? ' neutral' : ''}`} ref={g.bind(k)} />
        {notches?.map((n) => <i key={n} className="mx-notch" style={{ left: `${n}%` }} />)}
        {mark !== undefined && <i className="mx-mark" style={{ left: `${mark}%` }} />}
        {hold && <div className="mx-hold" data-state="off" ref={g.bind(`${k}-hold`)} />}
      </div>
      <span className="mx-val" ref={g.bind(`${k}-val`)} />
    </div>
  );
}

function CorrRow({ g, k, label, title, thin }: { g: Glass; k: string; label: string; title: string; thin?: boolean }) {
  return (
    <div className={`mx-row${thin ? ' thin' : ''}`} title={title}>
      <span className="mx-label">{label}</span>
      <div className="mx-track">
        <i className="mx-mark" style={{ left: '50%' }} />
        <div className="mx-fill corr" data-state="pos" ref={g.bind(k)} />
      </div>
      <span className="mx-val" ref={g.bind(`${k}-val`)} />
    </div>
  );
}

function Stat({ g, k, label, title }: { g: Glass; k: string; label: string; title: string }) {
  return (
    <div className="mx-stat" title={title}>
      <span className="k">{label}</span>
      <span className="v" ref={g.bind(`${k}-val`)} />
    </div>
  );
}

/** Where the export will land, in words (the flag on the graph says the same). */
function Landing() {
  const est = useStore((s) => s.masterEstimate);
  const pending = useStore((s) => s.previewPending);
  const target = useStore((s) => s.targetLufs);
  if (!est) {
    return (
      <div className="mx-landing">
        {pending ? 'WORKING OUT WHERE THE EXPORT LANDS…' : 'THE EXPORT IS MEASURED AS IT RENDERS'}
      </div>
    );
  }
  if (!est.measured) {
    return <div className="mx-landing warn">TOO QUIET TO MEASURE · THE EXPORT LEAVES AT UNITY GAIN</div>;
  }
  if (!est.reached) {
    return (
      <div className="mx-landing warn">
        {target.toFixed(1)} LUFS IS OUT OF REACH UNDER THIS CEILING · THE EXPORT LANDS AT {est.lufs.toFixed(1)}
      </div>
    );
  }
  return (
    <div className="mx-landing">
      EXPORT LANDS AT <b>{est.lufs.toFixed(1)} LUFS</b> · {est.truePeakDb.toFixed(1)} dBTP · LRA {est.lra.toFixed(1)} LU
    </div>
  );
}

export function MetersPanel() {
  const source = useStore((s) => s.source);
  const targetLufs = useStore((s) => s.targetLufs);
  const ceilingDb = useStore((s) => s.ceilingDb);
  const clipMode = useStore((s) => s.clipMode);
  const monitor = useStore((s) => s.monitor);
  const setMonitor = useStore((s) => s.setMonitor);
  const normPreview = useStore((s) => s.normPreview);
  const setNormPreview = useStore((s) => s.setNormPreview);
  const normGainDb = useStore(normPreviewGainDb);
  const meterView = useStore((s) => s.meterView);
  const setMeterView = useStore((s) => s.setMeterView);
  const spectrumSlope = useStore((s) => s.spectrumSlope);
  const setSpectrumSlope = useStore((s) => s.setSpectrumSlope);
  // The target the export can't reach is said here too, whatever view is up.
  const short = useStore((s) => (s.masterEstimate && s.masterEstimate.measured && !s.masterEstimate.reached
    ? s.masterEstimate.lufs : null));
  const [g] = useState(() => new Glass());

  // A new track: nothing measured on the last one belongs to it.
  useEffect(() => {
    if (bookSource !== source) {
      bookSource = source;
      book.setSource(source?.durationSec ?? 0);
    }
    paint(g, useStore.getState().meters, true);
  }, [source, g]);

  // Every meter frame: into the book, then onto the glass.
  useEffect(() => {
    let n = 0;
    let wasIdle: boolean | null = null;
    let hooked = false;
    const off = engine.onMeters((m) => {
      const st = useStore.getState();
      book.frame(m, {
        nowSec: performance.now() / 1000,
        sampleRate: engine.sampleRate,
        ceilingDb: st.ceilingDb,
        keepStartSec: Math.max(0, st.trimStartSec),
      });
      if (!hooked) {
        // For scripting and the verification harness, beside the store and engine.
        const hook = (window as unknown as { __jmaster?: Record<string, unknown> }).__jmaster;
        if (hook) { hook.meterBook = book; hooked = true; }
      }
      if (document.visibilityState === 'hidden') return;
      const figures = (n++ & 3) === 0 || m.idle !== wasIdle;
      wasIdle = m.idle;
      paint(g, m, figures);
    });
    paint(g, useStore.getState().meters, true);
    return () => { off(); };
  }, [g]);

  // A ceiling moved while paused: the ticks past it change colour now, not at the next frame.
  useEffect(() => { paint(g, useStore.getState().meters, true); }, [ceilingDb, clipMode, g]);

  const resetPeaks = () => {
    book.resetPeaks();
    paint(g, useStore.getState().meters, true);
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = VIEWS.findIndex((v) => v.id === meterView);
    let to = -1;
    if (e.key === 'ArrowRight') to = (i + 1) % VIEWS.length;
    else if (e.key === 'ArrowLeft') to = (i + VIEWS.length - 1) % VIEWS.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = VIEWS.length - 1;
    if (to < 0) return;
    // The arrows belong to the tabs here, not to the transport.
    e.preventDefault();
    e.stopPropagation();
    setMeterView(VIEWS[to].id);
    (e.currentTarget.children[to] as HTMLElement | undefined)?.focus();
  };

  const tabId = `mx-tab-${meterView}`;

  return (
    <div className="panel panel-meters">
      <div className="panel-head">
        <span className="title">Meters</span>
        <span className="spec">BS.1770-4 · R128</span>
      </div>
      <div className="meters-body mx">
        <div className="mx-mon">
          <div className="seg mon-seg" role="group" aria-label="Monitor matrix">
            {MONITOR_MODES.map((mode) => (
              <button
                key={mode.id}
                className={monitor === mode.id ? 'on' : ''} aria-pressed={monitor === mode.id}
                title={mode.id === 'stereo'
                  ? 'Monitor the stereo master'
                  : `Monitor ${mode.id === 'mono' ? 'the mono fold-down' : mode.id === 'side' ? 'the side signal only' : `the ${mode.id} channel only`} (never exported)`}
                onClick={() => setMonitor(mode.id)}
              >{mode.label}</button>
            ))}
            <span className="spec monlabel">MON</span>
          </div>
          <div className="seg mon-seg" role="group" aria-label="Hear it as a streaming platform plays it">
            {NORM_PLATFORMS.map((p) => {
              const plat = p.id ? PLATFORMS.find((x) => x.id === p.id) : null;
              const turn = plat ? Math.min(0, plat.targetLufs - targetLufs) : 0;
              return (
                <button
                  key={p.label}
                  className={normPreview === p.id ? 'on' : ''} aria-pressed={normPreview === p.id}
                  title={plat
                    ? `Hear it as ${p.name} plays it: ${turn < 0 ? `turned down ${Math.abs(turn).toFixed(1)} dB to ${plat.targetLufs} LUFS` : 'plays as mastered'} · playback only, never exported`
                    : 'Hear the master at its own level'}
                  onClick={() => setNormPreview(p.id)}
                  aria-label={p.id ? p.name : 'Off'}
                ><span className="mx-long">{p.label}</span><span className="mx-short">{p.short}</span></button>
              );
            })}
            <span className="spec monlabel" title="Loudness-normalization preview">NORM</span>
          </div>
        </div>
        {normPreview && (
          <div className="spec normnote">
            {normGainDb < -0.05
              ? <>PLAYBACK TURNED DOWN <span style={{ color: 'var(--text-accent)' }}>{Math.abs(normGainDb).toFixed(1)} DB</span></>
              : 'PLAYS AS MASTERED AT THIS TARGET'}
          </div>
        )}

        <div className="mx-cols">
          <div className="mx-bars">
            <section className="mx-block" aria-label="Loudness, LUFS">
              <div className="mx-head">
                <span className="mx-name">LOUDNESS</span>
                {short !== null ? (
                  <span className="mx-aside warn"
                    title="The target can't be had under this ceiling: the export lands short of it. Lower the target, raise the ceiling, or add density.">
                    LANDS {short.toFixed(1)} OF {targetLufs.toFixed(1)}
                  </span>
                ) : (
                  <span className="mx-aside">TARGET {targetLufs.toFixed(1)} LUFS</span>
                )}
              </div>
              <Row g={g} k="m" label="M" title="Momentary: the last 400 ms" mark={lufs01(targetLufs) * 100} />
              <Row g={g} k="s" label="S" title="Short-term: the last 3 s" mark={lufs01(targetLufs) * 100} />
              <Row g={g} k="i" label="I" title="Integrated: everything played since playback began" mark={lufs01(targetLufs) * 100} />
              <div className="mx-stats">
                <Stat g={g} k="psr" label="PSR"
                  title="Peak to short-term loudness, dB: how far the peaks of the last 3 s stand over their loudness. Lower is denser." />
                <Stat g={g} k="plr" label="PLR"
                  title="Peak to loudness, dB: the loudest true peak over the integrated loudness of this pass" />
                <Stat g={g} k="lra" label="LRA"
                  title="Loudness range, LU (EBU Tech 3342), of what has played so far: the spread between its quiet and loud passages" />
              </div>
            </section>

            <section className="mx-block" aria-label="True peak, dBTP">
              <div className="mx-head">
                <span className="mx-name">TRUE PEAK</span>
                <button className="mx-latch" data-state="rest" ref={g.bind('tp-latch')} onClick={resetPeaks}
                  title={`Loudest true peak since playback began, and how many times it went over the ${ceilingDb.toFixed(1)} dBTP ceiling · click to reset`}>
                  <span className="lamp" aria-hidden="true" />
                  <span>MAX <b ref={g.bind('tp-max')} /></span>
                  <span className="mx-overs" ref={g.bind('tp-overs')} />
                </button>
              </div>
              <div className="mx-row dual"
                title="True peak of each side: left above, right below, each with a tick holding where it last reached. The figure is the higher of the two.">
                <span className="mx-label">L·R</span>
                <div className="mx-track">
                  <div className="mx-fill top" ref={g.bind('tpl')} />
                  <div className="mx-fill bottom" ref={g.bind('tpr')} />
                  <i className="mx-mark" style={{ left: `${tp01(ceilingDb) * 100}%` }} />
                  <div className="mx-hold top" data-state="off" ref={g.bind('tpl-hold')} />
                  <div className="mx-hold bottom" data-state="off" ref={g.bind('tpr-hold')} />
                </div>
                <span className="mx-val" ref={g.bind('tp-val')} />
              </div>
            </section>

            <section className="mx-block" aria-label="Gain reduction, dB">
              <Row g={g} k="grs" label="SMOOTH" hold neutral notches={GR_NOTCHES}
                title="Gain reduction, dB: what SMOOTH is taking off the harsh band. Notches at 3 and 6 dB, full scale 12." />
              <Row g={g} k="grc" label="COMP" hold neutral notches={GR_NOTCHES}
                title="Gain reduction, dB: what the compressor (DENSITY) is taking off. Notches at 3 and 6 dB, full scale 12." />
              {clipMode !== 'off' && (
                <Row g={g} k="grk" label="CLIP" hold neutral notches={GR_NOTCHES}
                  title="Gain reduction, dB: what the clipper is shaving off the peaks ahead of the limiter. Notches at 3 and 6 dB, full scale 12." />
              )}
              <Row g={g} k="grl" label="LIMIT" hold neutral notches={GR_NOTCHES}
                title="Gain reduction, dB: what the limiter is taking off to hold the ceiling. Notches at 3 and 6 dB, full scale 12." />
            </section>

            <section className="mx-block tight" aria-label="Stereo correlation">
              <CorrRow g={g} k="corr" label="Φ" title="Correlation across the band: +1 is mono, 0 is wide, below 0 the sides fight each other" />
              <CorrRow g={g} k="corrlow" label="Φ LOW" thin
                title="Correlation below 150 Hz: under 0, the bass cancels when the master is played in mono" />
              {/* Only there when it has something to say (in words, not just a colour). */}
              <div className="mx-note" data-state="rest" ref={g.bind('corr-note')} />
            </section>
          </div>

          <div className="mx-view">
            <div className="seg tabseg mx-tabs" role="tablist" aria-label="Analyser view" onKeyDown={onTabKey}>
              {VIEWS.map((v) => (
                <button
                  key={v.id} role="tab" id={`mx-tab-${v.id}`}
                  aria-selected={meterView === v.id} aria-controls={meterView === v.id ? `mx-panel-${v.id}` : undefined}
                  tabIndex={meterView === v.id ? 0 : -1}
                  className={meterView === v.id ? 'on' : ''}
                  title={v.title}
                  onClick={() => setMeterView(v.id)}
                >{v.label}</button>
              ))}
            </div>
            {meterView === 'spectrum' ? <Spectrum labelledBy={tabId} />
              : meterView === 'scope' ? <Scope labelledBy={tabId} />
              : <LoudnessHistory labelledBy={tabId} />}
            {meterView === 'spectrum' ? (
              <div className="mx-foot">
                <span className="mx-keys">
                  <span className="mx-key"><i className="bar" />OUT</span>
                  <span className="mx-key"><i className="line" />SRC</span>
                  <span className="mx-key"><i className="cap" />PEAK</span>
                </span>
                <button className="mx-chip" aria-pressed={spectrumSlope} onClick={() => setSpectrumSlope(!spectrumSlope)}
                  title="Tilt the display 4.5 dB an octave around 1 kHz, so a balanced mix reads level">
                  <span className="lamp" aria-hidden="true" />SLOPE
                </button>
              </div>
            ) : meterView === 'scope' ? (
              <div className="mx-foot">
                <span className="mx-keys"><span className="mx-key">MID UP · SIDE ACROSS · AUTO GAIN</span></span>
              </div>
            ) : (
              <>
                <div className="mx-foot">
                  <span className="mx-keys">
                    <span className="mx-key" title="Short-term loudness (3 s) of what has played"><i className="cap" />S</span>
                    <span className="mx-key" title="Momentary loudness (400 ms) of what has played"><i className="line" />M</span>
                    <span className="mx-key" title="The source's own short-term curve, moved to the target's level: what the chain did to the dynamics"><i className="dim" />SOURCE SHAPE</span>
                  </span>
                </div>
                <Landing />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
