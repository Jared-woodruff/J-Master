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
bit-identical. The oversampled stages (CHARACTER, AIR RESTORE, CLIP) rest
when they have nothing to do, and they too decide that per sample: each
keeps a dry delay line of its own latency, so resting is a pure delay, and
waking primes the oversampler from that line so the first working sample
carries on from the resting ones. Keep it that way when adding a stage:
anything decided "per block" breaks the contract, and `tests/dsp.test.ts`
will say so (it nulls a 128-block render against a 4096-block one).

### Signal flow

```
source fix (a silent side filled, an inverted side turned back)
→ staging gain (source → −18 LUFS nominal)
→ 18 Hz HPF → AIR RESTORE (a new top octave for band-limited sources)
→ tone tilt → shape contour → air shelf
→ match EQ (10-band reference correction)
→ advanced EQ (6 bands: shelves, bells, high-pass, low-pass; each on both
  channels, the MID only or the SIDE only)
→ LANES (bass / drums / vocal / air trims)
→ SMOOTH (dynamic high-band tamer)
→ CHARACTER (4× oversampled saturation)
→ DENSITY (glue compressor) → IMPACT (transient shaper)
→ WIDTH (tilted M/S, bass anchored) → balance trim
→ top and tail trim + fades → output gain
→ CLIP (optional peak clipper, 4× oversampled) → true-peak lookahead limiter
```

The chain's latency is the same at every setting (CHARACTER and AIR RESTORE
are 39 samples each whether working or resting, CLIP another 39 when it is
in, then the limiter's lookahead), and the REF path runs through the same
delays, so switching a stage or the reference never moves the music in
time. The trim and fades read the track position through a matching delay,
so a fade lands on the same samples at any latency.

Continuous parameters are slewed per 128-sample block (~15 ms) for a
zipperless console. The match/advanced EQ banks keep one biquad per band
for the chain's life and retune it in place when its spec changes, so a
drag never resets the other bands' filter state. A band is tuned by
`tuneBand()` in `src/audio/dsp/eqband.ts`, and the EQ drawer draws its
response from that same function: what is drawn is what is heard.

The 4× oversampler (`oversampler.ts`) is two halfband stages with a block
API (`up()` returns a 4× view, `down()` writes back) and a whole-sample
latency; it is flat to 20 kHz and gives the same samples at any block
size.

### Sample rates

The engine runs at 48 kHz. A file at any other rate is decoded at its own
rate (an `OfflineAudioContext` at the file's rate, so the browser converts
nothing) and brought to 48 kHz by the app's own converter,
`src/audio/dsp/resample.ts`: a polyphase Kaiser-windowed sinc with a 130 dB
stopband, flat to 20 kHz, no delay and no change of duration, the two
channels converted in parallel in the two workers. The same converter
delivers 44.1 kHz masters: the conversion happens BEFORE the loudness
solve, so the target and the true-peak ceiling are solved on the very
samples that ship.

Offline, the chain runs without its output limiter (`{ limiter: false }`):
there it would be transparent, and the loudness solve limits afterwards.
Each offline stage pads its input by its latency and reads from that
offset, so the master lines up with the source sample for sample.

### Loudness

`src/audio/dsp/loudness.ts` implements ITU-R BS.1770-4: K-weighting
derived for any rate as libebur128 does (at 48 kHz it equals the
standard's coefficient table), 400 ms gating blocks at 75 % overlap,
absolute −70 gate and relative −10 LU gate for integrated loudness, EBU
R128 LRA as Tech 3342 defines it (short-term values gated at −70 LUFS
absolute and at 20 LU under the mean of what passed that gate, then
p95 − p10), and true peak. The live meter in the
worklet never allocates: the last 3 s of hops sit in a ring and the
integrated value gates a 0.1 LU histogram.

True peak (`src/audio/dsp/limiter.ts`) is found at 8× with 48-tap
Kaiser-windowed sinc phases, accurate enough that the limiter holds its
ceiling within about 0.01 dB on programme band-limited to 20 kHz (the
24-tap detector it replaced let bright material through 0.25 to 0.44 dB
over). A sliding-maximum bound skips the interpolation wherever the
samples around a point can't reach the ceiling, which is most of a
track. The
limiter holds the required gain over its lookahead (sliding minimum),
releases it exponentially, then averages it over the lookahead, so every
attack is a ramp that is fully down when the peak leaves the delay.
Offline passes share a `TruePeakEnvelope`, which computes the exact
interpolation only where a cheap bound says the ceiling is in reach.

The export renderer solves loudness exactly: run the chain core once, then
*gain → clip → limit → measure* with secant steps (the limiter makes a dB
of gain worth less than a LU once it works), up to 8 passes, exit within
0.05 LU, keeping the closest. When more gain stops buying loudness (the
limiter and ceiling have nothing left to give) the solve stops early and
reports `reached: false` with where it landed, instead of crushing the
track toward a number it can't have; the UI says so before and after an
export. A source too quiet or short to measure (−70 LUFS) renders at unity
gain.

The same solve keeps the PREVIEW honest. Each time the console settles,
the engine renders the whole track in the batch worker (debounced, on a
copy of the source the worker keeps) and the live chain plays at the gain
that solve found: the export's own. Until it lands, a quick estimate from
the loudest excerpt carries. The solve's result is the `masterEstimate`
the UI shows (where an export would land, how hard the limiter works,
whether the target can be reached). Tracks over 20 minutes are solved only
while the OUT view is showing, or on export.

### Phase lessons (learned the measured way)

Two bugs during development are worth knowing about because they're classic:

1. **Don't split what you can shelve.** Extracting a band with a filter,
   scaling it and summing it back cancels near the crossover unless the
   split is phase-coherent, and even a subtractive split leaves the two
   halves' slopes fighting: the lanes and WIDTH each left a notch at their
   crossovers (WIDTH's side channel was 5.9 dB down at 140 Hz when
   widening). Both are now minimum-phase shelves and one wide bell: a trim
   moves its band and never moves another band the other way.
2. **The limiter eats naive measurements.** Transient boosts vanish from
   crest-factor measurements at normal loudness targets because the limiter
   catches exactly those peaks. Verify dynamics processing with limiter
   headroom.
3. **A decision per block is a different decision per block size.** SMOOTH
   once chose its cut per processing block, and CLIP's first draft slept
   and woke per block: preview and export differed. Decide per sample, or
   on a grid counted from the stream start.
4. **An oversampler is a delay.** Its two branches must line up to the
   sample (one out of line rolled the top octave off), and a stage that
   switches it in and out must delay its dry path by the same amount, or
   switching it is a click and a comb.

## Codecs

- **FLAC** (`src/audio/flac.ts`): RFC 9639 from scratch. Per frame, four
  channel assignments (L/R, L/S, R/S, M/S) are fully planned and the
  cheapest wins by exact bit count. Subframes choose between fixed
  predictors and LPC (Hann-windowed autocorrelation → Levinson–Durbin,
  order ≤ 12, precision-15 quantization with error feedback). Residuals use
  partitioned Rice with per-partition parameters found via mergeable
  Σ(u≫k) tables. STREAMINFO carries the MD5 of the audio (`src/audio/md5.ts`),
  so `flac -t` and archive tools can verify the file. Decoded bit-exact by
  ffmpeg in the test suite and by Chromium in the app.
- **Ogg Opus** (`src/audio/ogg-opus.ts`): Chromium's native WebCodecs
  `AudioEncoder` produces the packets; the RFC 7845 container (OpusHead from
  the encoder's own `decoderConfig.description`, OpusTags with metadata,
  page lacing, Ogg CRC-32) is written by hand. Zero dependencies. Opus is
  always 48 kHz; packets that fall wholly after the track's end are
  dropped so the final granule position never runs backwards.
- **WAV** (`src/audio/wav.ts`): 16 or 24-bit PCM, or 32-bit IEEE float
  (for more work in a DAW, and for a saved drift repair, which is still a
  source and can peak past full scale). Tags go in RIFF LIST/INFO in
  Windows-1252 when the text fits (so Explorer shows them right) and always
  in a full `id3 ` chunk as well. WAV and FLAC share one quantization pass
  so both lossless outputs of a render are bit-identical.
- **Dither** (`quantizeStereo()` in `flac.ts`): 16-bit output is dithered
  with TPDF, or TPDF through a 5-tap Lipshitz error filter that moves the
  noise out of the ear's most sensitive band. The noise is seeded, so the
  same render gives the same bytes every time.
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

- **analyze:** LUFS/LRA/true-peak/sample-peak, the loudest 400 ms and 3 s,
  L/R balance offset, the multi-resolution waveform peak pyramid, the
  short-term loudness lane, and the diagnosis measurements (side-bass
  ratio, windowed correlation, HF share, a silent or inverted side).
- **source checks** (`src/audio/analysis/source-checks.ts`): what the file
  says about how it was made. Bandwidth (a cliff in the long-term spectrum:
  where a lossy codec or a generator stopped), silence before and after the
  music, a start or end cut mid-sound, and flat tops (runs of identical
  samples at the file's own peak, counted on the samples as decoded, before
  any rate conversion smooths them). `src/state/diagnosis.ts` turns the
  measurements into the check sheet's rows and the fixes it offers.
- **tempo** (`src/audio/analysis/tempo.ts`): spectral-flux onset envelope
  → mean-removed autocorrelation, scored with a comb at fractional lags
  (the period and its multiples, the kick band weighted up) so a dotted or
  triplet relative of the beat never outscores the beat itself; the two
  octaves of a tempo are settled explicitly (how much of the pulse the
  kick carries at each, then a prior centred on 130 BPM); the whole-track
  read is sought near the tempo that 20 s windows vote for (a drifting
  tempo smears the whole-track peak); beat phase from squared
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

`src/state/store.ts` (zustand + persist) owns the console, transport
mirror, sheets, batch queue, history and project I/O. Its pure parts live
beside it and have no store in them: `console.ts` (the console as data,
and the cleaners), `diagnosis.ts` (the check sheet's rules), `files.ts`
(file names, CUE text, error wording), `storage.ts` (the settings
storage). Anything read from disk (a project, the saved settings) passes
through `cleanConsole()` and friends first: every value typed, clamped and
known.

- **Two layers.** The SOUND (macros, preset and its amount, target,
  ceiling, clip, advanced EQ, lane trims) is how you want masters to come
  out: it travels between tracks, into presets and A/B slots, and through
  restarts. The CORRECTIONS (balance, bass mono, channel repair, air
  restore, match fit, trim, fades) are fixes to one track's own faults:
  they reset when a track loads and never ride along in a slot, a preset
  or the saved settings. Batch tracks get the console's sound and only the
  fixes their own scan found (`trackParams()`).
- **Undo/redo** snapshots the whole console (both layers), collapses a
  continuous gesture into one step, clears when a track loads, and tags
  each step with the A/B slot it was made in: undoing a step made in the
  other slot switches back there first.
- **Projects** (`.jmaster`, version 2; version 1 still opens) embed the
  console, both slots, metadata, cover art (base64), the export format,
  the batch queue, album barcode and gap, the user presets the session
  refers to, a drift repair to re-run and the tempo reading. A project
  opened without its audio keeps its corrections aside until that track
  (by name) is loaded.
- **Preferences** persist via localStorage through `debouncedStorage()`:
  the store changes with every meter frame, so a hand-over whose persisted
  values are unchanged is dropped, and a real change is written once,
  400 ms later (and when the window closes).

## Electron shell

`electron/main.ts`: frameless window (its size and place remembered),
native dialogs, file association for `.jmaster`, and a single instance: a
project or an audio file given at launch (double-click, a drop on the
shortcut) waits in the main process until the window asks for it
(`takeOpenPath`), so none is lost to a window that wasn't listening yet.
CD images stream to disk (`writeFileNew` / `appendFile` / `patchFile`,
written as `.partial` and committed by rename; if the previous image is
open in another app, the new one takes a numbered name instead of being
thrown away). The renderer runs sandboxed with `contextIsolation`, no
`nodeIntegration` and no navigation; the preload exposes a narrow typed
bridge.

There is no application menu: on a frameless window it was invisible, but
its accelerators were live (Ctrl+W closed the app mid-render, Ctrl+R threw
the session away). The window tells the main process when it is rendering
(`setBusy`), and closing then asks first. The content security policy is
added at build time (`vite.config.ts`), because the dev server's React
refresh preamble is an inline script that policy refuses.

Every path the renderer hands over is checked. Local paths are fine;
network (UNC) and device paths only once the user chose them this session
(a dialog, a drop, the launch arguments), because Windows signs in to a
network path with the user's credentials and a shared project must not
trigger that. Saving into a folder never replaces an existing file: names
are numbered " (2)", " (3)"…

## Verification

`npm test` bundles `tests/*.test.ts` with esbuild and runs them under
node's own test runner (no framework to install; `npm test -- limiter`
runs the suites whose file name contains "limiter"). The suites run the
real code, not copies of it:

- **DSP and render** (`dsp`, `stages`, `render`, `resample`): synthetic
  signals with known ground truth through the real chain and the real
  export path. Preview blocks against export blocks, every stage's
  frequency response and latency, the loudness solve on every target, the
  ceiling under drive.
- **Worklet** (`worklet`): the real `AudioWorkletProcessor` class driven
  block by block: seeks, loops, the click, trim playback, the end of the
  track.
- **Codecs** (`codecs`): every writer read back by an independent decoder
  (ffmpeg, when it is installed; those cases are skipped without it), MD5
  reference vectors, dither statistics.
- **Analysis** (`analysis`, `checks`): tempo, drift, sections and the
  source checks on generated songs with exact answers.
- **State** (`store`, `settings`): the real store under node with browser
  globals stubbed and the engine's audio replaced by stand-ins
  (`tests/lib/store-harness.ts`): undo, A/B, projects, batch, saved
  settings from older versions.
- **UI maths** (`meters`, `wave-math`): the pure helpers behind the meters
  and the waveform.

`window.__jmaster` exposes `{ store, engine, chainParams, flac }` for the
other half: driving the real app, loading synthetic tracks with known
ground truth (exact BPM, known spectral content, deliberately broken
stereo) and measuring rendered output. Automated runs never press a save
or render button (they open a native dialog on whoever's screen it is).

The README media come from the same hook. `scripts/lib/drive-app.mjs`
launches the production build over CDP on a throwaway profile with audio
muted and operates it with real input (OS-style file drops, mouse moves,
clicks, drags, keys); `scripts/capture-screens.mjs` and
`scripts/capture-media.mjs` use it to shoot the screenshots and record the
GIFs while playing the demo track from `scripts/make-demo-song.mjs`.
