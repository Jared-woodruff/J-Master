# Changelog

## Unreleased
- **Fix: dropping a track onto the open screen made the UI flash until
  restart.** One drop was handled twice, loading the track in parallel and
  creating two audio engines whose meter frames fought over the playhead
  (it jumped between two positions about 90 times a second and play/pause
  flickered). Drops now have a single owner, the audio engine can only be
  created once, and loads run strictly in order with the most recent
  request winning.
- Fix: dropped tracks remember where they live again (Electron removed
  `File.path`), so they reach Recent Files and saved projects find their
  audio.
- Fix: loading a track while the previous one was still being analysed
  could hand it the previous track's tempo, grid, sections, or
  spectrogram.
- Fix: changing tracks in SPEC view left the spectrogram blank until the
  view was toggled.
- **Drop anywhere:** the loaded console shows a drop veil that says what
  will happen. Several tracks at once queue in BATCH (the first opens in
  the console if it's empty), a track dropped on MATCH becomes the
  reference, an image dropped on EXPORT or BATCH becomes the cover, and a
  drop over the diagnosis sheet simply loads.
- Loading shows the file name and phase instead of freezing, and a file
  that can't be decoded leaves the current track untouched.
- **Layout pass, measured at five window sizes.** EXPORT is a permanent
  button in the track strip (it sat below the fold at 1440×920 and
  smaller). OPEN / SAVE / BATCH moved to the title bar, so the strip fits
  on one line down to 1280 px, and short screens give the console more
  height so the loudness target stays in view at 1280×680.
- The waveform's view controls moved to a header row above the canvas.
  They no longer cover the fade-out handle (it can be dragged again at
  any zoom), and section labels no longer print through the source line.
- STEM LANES became a drawer beside EQ, and both show a lamp when their
  settings are active. Track specs wrap instead of clipping mid-word,
  knob captions fit whole, the spectrum has frequency labels, and toasts
  cap at three.

## 2.4.0
- Long track names, artists, and genres can no longer overflow any
  surface: the diagnosis and match dialogs clip or wrap their name
  lines, toasts cap their width and wrap, and every truncated name
  shows the full text on hover.
- **Cover art on export.** Add a front-cover image in the metadata block
  (click or drop; auto-scaled to a ≤1000 px JPEG) and it is embedded in
  every format: MP3 ID3 APIC, FLAC PICTURE block, Ogg Opus
  METADATA_BLOCK_PICTURE (the tags packet now spans Ogg pages as
  needed), and a WAV "id3 " chunk. Covers travel with .jmaster projects
  and apply to batch exports too.
- **Monitor matrix:** MONO / SIDE / L / R monitoring from the meters rack
  for mono-compatibility and image checks. Applied after the chain and
  before the meters (they read what you hear); never touches an export.
- **Type a value:** click any console knob's readout to enter an exact
  number.
- **Hold R** for a momentary reference compare; a tap still toggles.
- **Faster:** master-preview renders no longer copy the whole track on
  every adjustment (the source is primed into the render worker once per
  load); the waveform and spectrum repaint only when something actually
  changed, with theme colours cached instead of queried every frame.
  Idle CPU drops to near zero.
- **Responsive layout.** The console now re-flows instead of clipping on
  narrow windows: track-strip actions wrap onto extra lines, the lower
  deck stacks (console full width, presets and meters side by side
  below) under ~1060 px, the knob row sheds its hint captions and then
  folds to two rows of four as its panel tightens (container queries),
  fades and output stack, and informational text (waveform source line,
  status-bar mottos, title-bar labels) steps aside before any control
  does. Window minimum drops from 1120x720 to 720x560 so scaled laptop
  displays fit.
- **Motion polish:** dialogs and toasts rise in briefly, and every small
  control (transport, wave buttons, segments, platform grid, steppers,
  presets) presses down 1 px like a real switch. All of it respects the
  reduced-motion system setting.

## 2.3.0
- **Fix: SMOOTH and BALANCE were silent in the real-time preview.** Their
  slewed values were never advanced in the live chain, so the knobs (and
  the HARSH HIGHS / AUTO-CENTER diag fixes) only took effect in exports.
  Preview and export are numerically identical again.
- **GR·S meter:** live de-harsh gain reduction, above GR·C / GR·L.
- The diagnosis sheet now marks fixes the console already covers as
  APPLIED instead of re-offering them.
- **SPLIT compare view:** with OUT on, a SPLIT button stacks the source
  waveform above the processed master on a shared timeline, so the
  before/after difference is visible at a glance.
- Keyboard: arrow keys seek 5 s (Shift: 30 s), R toggles the
  loudness-matched reference, A switches the A/B snapshot slot.
- **Section loop:** L (or double-click the waveform) loops the detected
  section under the cursor, sample-seamless, for tweaking the console
  against one passage; LOOP button in the wave controls, region marked
  on the timeline.
- **Recent files** on the open screen (desktop app): the last six tracks
  reload with one click.
- Hovering the waveform shows the time and short-term loudness under the
  cursor; ? opens a keyboard cheat sheet (also KEYS in the status bar);
  the window title carries the track name.

## 2.2.2
- Broaden the messaging: J-Master masters output from any AI music
  generator (SUNO, Udio, Riffusion, local models) and any WAV at all,
  not just SUNO exports. Copy updated in the app and docs.

## 2.2.1
- Fix track-strip spec row colliding with the action buttons (dropped the
  redundant true-peak spec; overflow now clips instead of overlapping).
- Fix export-dialog audition hint overflowing the dialog.
- Windows ARM64 builds (`npm run dist:arm64`); artifact names now carry
  the architecture.

## 2.2.0
- **STEM LANES:** bass / drums / vocal / air component trims (±3 dB),
  phase-coherent subtractive extraction.
- **Album / CD assembly:** 44.1 kHz/16-bit image WAV (frame-aligned,
  streamed to disk) + CUE with CD-TEXT, per-track ISRC, album UPC; batch
  queue reordering.
- **Codec audition:** loop the loudest section, A/B encoded vs lossless.

## 2.1.0
- **Reference matching:** capped ±6 dB 10-band correction toward a loaded
  reference, plus loudness target and width adoption.
- **AUTO-MASTER:** analysis-driven preset choice + fixes with a full
  reasoning report.
- **Advanced EQ:** 6-band parametric drawer with draggable handles over the
  live spectrum.
- **Dynamics report:** PLR, EBU R128 LRA, per-platform delivery table.

## 2.0.0
- `.jmaster` **project files** (file association, double-click open).
- **Undo/redo** across the whole console.
- **Batch pre-scan:** per-track diagnosis and fixes in the queue.
- **Master preview overlay** (OUT): rendered waveform + loudness vs source.
- **Export history** with reveal-in-folder.
- **Ogg Opus export:** native WebCodecs encoder, in-house RFC 7845 muxer.

## 1.7.0
- Presets expanded to 30 genres; rack filter + overflow-safe rows.

## 1.6.0
- **Track diagnosis:** AI-music pathology check sheet with measured values,
  one-click fixes, AUTO-FIX option; bass-mono processor; balance moved
  post-width so corrections act on the delivered image.

## 1.5.0
- Stem-aware **tilted widener**; short-term **loudness lane**;
  **section detection** with bar anchoring; **A/B snapshot slots**.

## 1.4.0
- **Tempo detection**, bar/beat **GRID**, **CLICK** metronome.
- **SMOOTH** macro (dynamic de-harsh); **BALANCE** + AUTO-CENTER.
- Settings persistence.

## 1.3.0
- FLAC **LPC prediction** (order ≤ 12); **spectrogram** view;
  per-track preset overrides in batch.

## 1.2.0
- FLAC **stereo decorrelation + partitioned Rice**; **LIM Δ** delta monitor;
  release **metadata tags** (RIFF INFO / Vorbis comment / ID3v2.3).

## 1.1.0
- Waveform **zoom/pan** with peak pyramid; before/after **spectrum overlay**;
  **FLAC + MP3** export; **batch album** processing.

## 1.0.0
- The console: eight-macro chain, BS.1770-4 metering, exact loudness solve,
  true-peak limiting, fades, genre presets, streaming targets,
  24-bit/48 kHz WAV export, PLATE/PAPER themes, Windows x64 packaging.
