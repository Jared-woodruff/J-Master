# J-Master architecture

A technical map of the codebase for contributors. The product intent, a
mastering console where what you hear is exactly what renders, drives every
structural decision here.

## The WYSIWYG contract

There is one DSP implementation, in `src/audio/dsp/`, and it runs in two
places:

- **Real time:** `src/audio/worklet/processor.ts`, an `AudioWorkletProcessor`
  that *is* the playback source: it holds the full song, tracks the playhead
  sample-accurately, runs the `MasterChain`, applies the MON monitor matrix
  (mono fold / side solo / single channel) after the chain and *before*
  metering so the meters read what you hear, handles sample-seamless section
  looping, mixes the metronome click in after the meter taps, and posts
  meter frames (~46 Hz) to the UI. The monitor matrix exists only in this
  file; the chain never reads it, so it can never reach a render.
- **Offline:** `src/audio/render/render-worker.ts`, a worker that runs the
  identical chain for exports, previews, calibration and analysis. Exports
  and the OUT preview share one function, `renderMaster()` in
  `src/audio/render/master.ts`, so the preview is the export.

Both are bundled by `scripts/build-audio.mjs` (esbuild) into
`public/audio/`, from the same sources. Any DSP change automatically applies
to both paths.

Block size must never change the sound: the preview runs 128-sample blocks
and the export 4096. Every stage is sample-by-sample, or (SMOOTH) decides on
a fixed 32-sample grid counted from the stream start, so the two are
bit-identical. Keep it that way when adding a stage: anything smoothed "per
block" breaks the contract.

### Signal flow

```
staging gain (source → −18 LUFS nominal)
→ 18 Hz HPF → tone tilt → shape contour → air shelf
→ match EQ (10-band reference correction)
→ advanced EQ (6-band parametric)
→ STEM LANES (bass / drums / vocal / air component trims)
→ SMOOTH (dynamic high-band tamer)
→ CHARACTER (4× oversampled saturation)
→ DENSITY (glue compressor) → IMPACT (transient shaper)
→ WIDTH (tilted M/S, bass anchored) → balance trim
→ fades → output gain → true-peak lookahead limiter
```

Continuous parameters are slewed per 128-sample block (~15 ms) for a
zipperless console. The match/advanced EQ banks keep one biquad per band
for the chain's life and retune it in place when its spec changes, so a
drag never resets the other bands' filter state.

Offline, the chain runs without its output limiter (`{ limiter: false }`):
there it would be transparent, and the loudness solve limits afterwards.
Each offline stage pads its input by its latency and reads from that
offset, so the master lines up with the source sample for sample.

### Loudness

`src/audio/dsp/loudness.ts` implements ITU-R BS.1770-4: K-weighting
derived for any rate as libebur128 does (at 48 kHz it equals the
standard's coefficient table), 400 ms gating blocks at 75 % overlap,
absolute −70 gate and relative −10 LU gate for integrated loudness, EBU
R128 LRA (gated short-term p95 − p10), and true peak. The live meter in the
worklet never allocates: the last 3 s of hops sit in a ring and the
integrated value gates a 0.1 LU histogram.

True peak (`src/audio/dsp/limiter.ts`) is found at 8× with 24-tap
Kaiser-windowed sinc phases: at most 0.07 dB under-read to 16 kHz. The
limiter holds the required gain over its lookahead (sliding minimum),
releases it exponentially, then averages it over the lookahead, so every
attack is a ramp that is fully down when the peak leaves the delay.
Offline passes share a `TruePeakEnvelope`, which computes the exact
interpolation only where a cheap bound says the ceiling is in reach.

The export renderer solves loudness exactly: run the chain core once, then
*gain → limit → measure* with secant steps (the limiter makes a dB of gain
worth less than a LU once it works), up to 8 passes, exit within 0.05 LU,
keeping the closest. A source too quiet or short to measure (−70 LUFS)
renders at unity gain. The preview can't do a full solve per knob-turn, so
the engine renders the loudest 6 s excerpt through the chain (debounced)
and derives a calibration delta; preview loudness tracks the eventual
export within ~0.3 LU.

### Phase lessons (learned the measured way)

Two bugs during development are worth knowing about because they're classic:

1. **Parallel band extraction must be phase-coherent.** Extracting "air"
   with a 4th-order highpass and summing it back *cancels* near cutoff
   (~180° rotation). The stem lanes use subtractive splits
   (`air = x − LP(x)`) which are exact reconstructions at unity.
2. **The limiter eats naive measurements.** Transient boosts vanish from
   crest-factor measurements at normal loudness targets because the limiter
   catches exactly those peaks. Verify dynamics processing with limiter
   headroom.

## Codecs

- **FLAC** (`src/audio/flac.ts`): RFC 9639 from scratch. Per frame, four
  channel assignments (L/R, L/S, R/S, M/S) are fully planned and the
  cheapest wins by exact bit count. Subframes choose between fixed
  predictors and LPC (Hann-windowed autocorrelation → Levinson–Durbin,
  order ≤ 12, precision-15 quantization with error feedback). Residuals use
  partitioned Rice with per-partition parameters found via mergeable
  Σ(u≫k) tables. Verified bit-exact against Chromium's decoder.
- **Ogg Opus** (`src/audio/ogg-opus.ts`): Chromium's native WebCodecs
  `AudioEncoder` produces the packets; the RFC 7845 container (OpusHead from
  the encoder's own `decoderConfig.description`, OpusTags with metadata,
  page lacing, Ogg CRC-32) is written by hand. Zero dependencies.
- **WAV** (`src/audio/wav.ts`): PCM with TPDF dither and RIFF LIST/INFO
  tags. WAV and FLAC share one quantization pass so both lossless outputs of
  a render are bit-identical. A drift repair saves as 32-bit IEEE float
  instead: it is still a source, and a stretch can peak past full scale.
- **MP3:** lamejs (LGPL), with an in-house ID3v2.3 writer (`src/audio/id3.ts`).

Front-cover art is embedded natively per container: an ID3v2.3 APIC frame
for MP3 (and, wrapped in an `id3 ` RIFF chunk, for WAV), an RFC 9639
PICTURE metadata block for FLAC, and the same PICTURE payload base64-encoded
into an Opus METADATA_BLOCK_PICTURE comment. When the art pushes the
OpusTags packet past a single Ogg page (65,025 body bytes), the muxer
splits it across pages with continuation flags and granule −1, per the Ogg
framing spec.

## Analysis

All in the render worker (`render-worker.ts`):

- **analyze:** LUFS/LRA/true-peak/sample-peak, L/R balance offset, the
  multi-resolution waveform peak pyramid, the short-term loudness lane, and
  the diagnosis measurements (side-bass ratio, windowed correlation,
  HF share).
- **tempo** (`src/audio/analysis/tempo.ts`): spectral-flux onset envelope
  → autocorrelation with octave weighting and parabolic refinement, sought
  near the tempo that 20 s windows vote for (a drifting tempo smears the
  whole-track peak and can let a dotted rhythm win); beat phase from squared
  low-band onsets (kick/bass own the downbeat); section detection via
  checkerboard novelty on 8-band features, each change moved to the
  sharpest half-second turn near it (a riser draws the 2 s novelty early),
  snapped to bars; bar phase chosen so bars start on section boundaries.
  Everything is measured on the music alone: columns more than 60 dB below
  the loudest are silence, silence at the ends is cut away before the tempo
  work and becomes its own SILENCE section, and windows that touch silence
  don't set the novelty threshold. No periodicity at all means bpm 0 (the
  sections still stand).
- **tempo over time:** a tempo curve (12 s windows every second: beat lag
  first, then refined on the four-beat lag), beats tracked through it by
  dynamic programming (after Ellis 2007, stiff enough to hold the beat
  through drumless passages) on the same kick-led onsets, and the best fixed
  grid through those beats. A steady track adopts that grid (within ~11 ms
  of every true beat on the generated fixtures). A track is **drifting**
  when its curve moves at least 0.35% and either the beats slide an eighth
  of a beat (or 60 ms) off the best fixed grid or the curve moves 1% or
  more; drift regions are measured against the tempo the track sets out at.
  A drifting track's GRID and CLICK follow the tracked beats (the worklet
  takes them in a `beats` message).
- **repair** (`src/audio/analysis/repair.ts`): drift repair, a time stretch
  onto one steady tempo with the pitch left alone (generated tracks drift
  in tempo only). The warp comes from the tempo curve, not the tracked
  beats, which jitter too much to steer a stretch: the curve is smoothed
  with a Gaussian-weighted local line (a plain average would bend a ramp at
  the ends of the song), integrated into a running beat count, and each
  output sample maps to the source sample whose count puts it on the target
  grid. A phase vocoder plays the source along that warp, both channels in
  one complex FFT. Phases come from phase gradient heap integration (Průša
  & Holighaus 2017): bins are visited loudest first across this frame and
  the last, a spectral peak carries on at its own frequency (measured from
  both channels' phase advance, so side-only content tracks as well as
  mid), and every other bin takes its rotation from a louder neighbour, so
  partials stay locked and a transient, loud only in the new frame, keeps
  its shape. One rotation per bin serves both channels, so the stereo image
  can't move. No single frame length suits a mix, so a linear-phase split
  at 700 Hz (8191-tap windowed sinc; the bands sum back exactly) is heard
  through 4096-point frames below (bass partials a few hertz apart stay
  apart) and 2048 above (drum attacks stay sharp), but the phases come from
  one field: a heap over the full signal's 4096-point bins below 700 Hz and
  its 2048-point bins above, analysed at the same frame centres every 512
  samples and joined at the split. Both bands synthesize with it, so a note
  on the split adds back in phase (with a field per band it came back at a
  random level, down to silence). At unity the output is the input
  (−145 dB) from the first sample. The limit is resolution: two partials
  closer than about 30 Hz (two low bass notes at once) share bins even at
  4096 points, and one of them can waver (24.5 cents and −1.4 dB on a
  55 + 82.5 Hz test). The stretch, and the analysis of its result, run in
  a worker of their own, terminated when it lands, is cancelled or a new
  track loads, so a load never queues behind it. Every take change (a
  load, a repair, a revert) happens in one synchronous step after its
  analysis, so nothing ever sees half of one take: the engine keeps the
  decoded file and its analysis for an instant REVERT, and each repair's
  warp to map the playhead and loop onto the new take. Batch and album
  renders of the loaded track take the repair, and wait for one in flight.
- **profile:** 30-band average spectrum + side/mid ratio, used by reference
  matching and AUTO-MASTER's genre heuristics.
- **preview:** full-chain render reduced to overlay peaks + loudness lane.
  The source is primed into the batch worker on the first preview request
  (and released when a new track loads), so repeated previews send only
  parameters instead of a full-track copy per adjustment.
- **spectrogram:** STFT 2048/1024 mapped to 256 log-frequency bands.

The batch worker is a second instance of the same script with request-id
multiplexing, so long album renders never block preview calibration.

## State

`src/state/store.ts` (zustand + persist). One store owns the console,
transport mirror, dialogs, batch queue, history and project I/O. Anything
read from disk (a project, the saved settings) passes through
`cleanConsole()` and friends first: every value typed, clamped and known.

- **ConsoleState** is the serialization unit: macros, targets, balance,
  bass-mono, fades, match EQ, advanced EQ, stem trims. Undo/redo snapshots
  it (gesture-collapsed, cleared when a track loads), A/B slots swap its
  sound (outside undo), `.jmaster` project files embed it, and batch items
  derive theirs in `trackParams()`: the console's sound, their own balance
  fix and no fades.
- Preferences (theme, views, export settings, metadata, A/B slots, export
  history, recent files) persist via localStorage. Front-cover art lives in
  the session and in `.jmaster` files (base64), never in localStorage.

## Electron shell

`electron/main.ts`: frameless window, native dialogs, file association for
`.jmaster` (single-instance, argv handoff), streamed file writes for CD
images (`writeFileNew` / `appendFile` / `patchFile`, written as `.partial`
and committed by rename), reveal-in-folder. The renderer runs sandboxed with
`contextIsolation`, no `nodeIntegration` and no navigation; the preload
exposes a narrow typed bridge.

Every path the renderer hands over is checked. Local paths are fine;
network (UNC) and device paths only once the user chose them this session
(a dialog, a drop, the launch arguments), because Windows signs in to a
network path with the user's credentials and a shared project must not
trigger that. Saving into a folder never replaces an existing file: names
are numbered " (2)", " (3)"…

## Verification harness

`window.__jmaster` exposes `{ store, engine, chainParams, flac }`. The
development flow drives the real app through it: loading synthetic tracks
with known ground truth (exact BPM, known spectral content, deliberately
broken stereo) and measuring rendered output.

The README media come from the same hook. `scripts/lib/drive-app.mjs`
launches the production build over CDP on a throwaway profile with audio
muted and operates it with real input (OS-style file drops, mouse moves,
clicks, drags, keys); `scripts/capture-screens.mjs` and
`scripts/capture-media.mjs` use it to shoot the screenshots and record the
GIFs while playing the demo track from `scripts/make-demo-song.mjs`.
