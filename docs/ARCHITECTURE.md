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
  identical chain for exports, previews, calibration and analysis.

Both are bundled by `scripts/build-audio.mjs` (esbuild) into
`public/audio/`, from the same sources. Any DSP change automatically applies
to both paths.

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
zipperless console. The match/advanced EQ banks are static biquads rebuilt
only when their spec strings change.

### Loudness

`src/audio/dsp/loudness.ts` implements ITU-R BS.1770-4: K-weighting
(the exact shelf + highpass), 400 ms gating blocks at 75 % overlap, absolute
−70 gate and relative −10 LU gate for integrated loudness, EBU R128 LRA
(gated short-term p95 − p10), and 4× polyphase true-peak estimation.

The export renderer solves loudness exactly: run the chain core once, then
iterate *gain → limit → measure* (up to 4 passes, exit at 0.15 LU error).
The preview can't do a full solve per knob-turn, so the engine renders the
loudest 6 s excerpt through the chain (debounced) and derives a calibration
delta; preview loudness tracks the eventual export within ~0.3 LU.

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
  a render are bit-identical.
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
- **tempo:** spectral-flux onset envelope → autocorrelation with octave
  weighting and parabolic refinement; beat phase from squared low-band
  onsets (kick/bass own the downbeat); section detection via checkerboard
  novelty on 8-band features, snapped to bars; bar phase chosen so bars
  start on section boundaries.
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
transport mirror, dialogs, batch queue, history and project I/O:

- **ConsoleState** is the serialization unit: macros, targets, balance,
  bass-mono, fades, match EQ, advanced EQ, stem trims. Undo/redo snapshots
  it (gesture-collapsed), A/B slots swap it, `.jmaster` project files embed
  it, and batch items override parts of it.
- Preferences (theme, views, export settings, metadata, A/B slots, export
  history, recent files) persist via localStorage. Front-cover art lives in
  the session and in `.jmaster` files (base64), never in localStorage.

## Electron shell

`electron/main.ts`: frameless window, native dialogs, file association for
`.jmaster` (single-instance, argv handoff), streamed file writes for CD
images (`writeFileNew` / `appendFile` / `patchFile`), reveal-in-folder.
The renderer runs with `contextIsolation` and no `nodeIntegration`; the
preload exposes a narrow typed bridge.

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
