# Changelog

## 3.0.0
The biggest release so far: a full review of every part of the app (about
ninety findings, fixed), a rebuilt signal path where it was costing sound,
and a long list of new tools. Projects and settings from 2.x open as they
were.

### New
- **The master is solved while you work.** Each time the console settles,
  the whole track is rendered in the background and playback runs at the
  gain that render found: the export's own. The OUTPUT box says where an
  export will land (LANDS −14.0 LUFS · −1.0 dBTP) before you render
  anything, and says so plainly when a target can't be reached under the
  ceiling instead of crushing the track toward it.
- **CLIP.** An optional peak clipper ahead of the limiter, SOFT or HARD,
  4× oversampled. It takes the tallest peaks so the limiter doesn't have to
  pump for them: on the test song at a −9 LUFS target the limiter's deepest
  reduction drops by more than 3 dB, at the same loudness and ceiling.
- **AIR RESTORE.** Most generators (and every MP3) stop short of 20 kHz.
  The check sheet now finds where a source stops (BANDWIDTH), and RESTORE
  grows a new top octave from the band below it, starting exactly at the
  cut. Off, it is a pure delay.
- **Top and tail.** Trim brackets on the waveform (drag, or `[` and `]` at
  the playhead) cut dead air from either end. Fades run from the trim
  points, a cut with no fade gets a 3 ms edge instead of a click, and the
  export holds only what is kept.
- **A fuller check sheet.** Five new rows: CHANNELS (a silent side, or one
  side out of phase, each with a one-click fix), BANDWIDTH, TOP & TAIL
  (dead air, with a trim offered), EDGES (a file that starts or ends
  mid-sound, with a fade offered) and PEAKS (flat tops: clipping that
  happened before the file got here). Fixes that change the music itself
  (a fade-out) are offered unticked.
- **Preset AMOUNT.** Dial a preset in from none of it to 150%. Pin the
  presets you use to the top of the rack, and walk the rack with the arrow
  keys, hearing each as you reach it.
- **A deeper EQ.** Each of the six bands can now be a shelf, a bell, a
  high-pass or a low-pass, and can act on both channels, the MID only or
  the SIDE only. A band inspector under the graph takes typed frequency,
  gain and Q. The curve is drawn from the same filters the chain runs, with
  MID and SIDE drawn apart once a band treats them apart.
- **Command palette.** `Ctrl+K` lists every action by name with its key;
  type a few letters and press Enter.
- **Meters, rebuilt.** Per-channel true peak with a latched maximum and an
  over-ceiling counter, PSR, PLR and live LRA, gain reduction for every
  stage that reduces (CLIP included), a second correlation meter for the
  bass alone (where a mono fold-down loses its low end), a real spectrum
  analyser (dB scale, peak hold, the source behind the master, a slope
  option, a hover readout with note names) and a loudness history drawn
  against the track, with the target and where the export will land.
- **Loop anything.** Shift+drag on the waveform, or drag along the ruler,
  loops any stretch. Loop edges drag, and snap to beats and sections.
  FOLLOW keeps the playhead in view and steps aside while you look around.
- **Delivery formats.** Masters at 44.1 or 48 kHz; 16-bit, 24-bit or
  32-bit float WAV; TPDF or noise-shaped dither for 16-bit. A 44.1 kHz
  master is converted before the loudness solve, so the target and the
  ceiling are solved on the samples that ship.
- **A report for every master.** REPORT saves a one-page spec sheet beside
  the export and opens it: what was measured, what the console did, how
  each platform will play it, and the waveform and loudness of the file.
- **Lossy exports are checked after encoding.** An MP3 or Opus file is
  decoded again and its true peak measured, because codecs overshoot: the
  export says when the encoded file peaks over your ceiling.
- **Double and half time.** `÷2` and `×2` beside the BPM re-read the tempo
  an octave away; the grid, the click and a drift repair follow.
- **AUTO is more careful.** It applies every fix the check sheet ticked,
  judges brightness only up to where a band-limited source stops, and
  dials the preset back (to 60 or 80%) on a source that arrives already
  dense.
- **Batch.** Every track gets the console's sound and only its own fixes;
  a file can't be queued twice; tracks can be removed one at a time; the
  run shows overall progress; a track added mid-run is scanned when it
  ends. CD images are mastered straight to 44.1 kHz / 16-bit by the app's
  own converter and dither.
- **Gapless MP3.** MP3 exports carry an Info frame, so they decode to
  exactly the samples that went in: no 1105 samples of lead-in, no padded
  tail, an exact length. The codec audition stays in step with the master
  because of it.
- **AIFF.** AIFF and AIFF-C files load (the browser's decoder doesn't take
  them, so the app reads them itself): 8 to 32-bit, little-endian and float
  variants.
- **Tags.** ISRC is written to every format, FLAC files carry the MD5 of
  their audio, and WAV tags read correctly in Windows Explorer.
- **The window.** It remembers its size and place, asks before closing
  mid-render, and opens an audio file dropped on its shortcut.

### Sound (measured on the real DSP)
- **Sample-rate conversion is the app's own.** A 44.1 kHz file used to be
  converted by the browser on load. It is now decoded at its own rate and
  converted by a polyphase windowed-sinc filter: flat to 20 kHz, images
  and aliases more than 120 dB down, no delay, the same length.
- **The limiter holds its ceiling on bright material.** The true-peak
  detector let dense top end through by 0.25 to 0.44 dB. It now holds the
  ceiling within 0.01 dB on programme band-limited to 20 kHz.
- **The 4× oversampler is flat to 20 kHz** (it was 1.5 dB down there), so
  CHARACTER no longer costs any top end. Its first step is as small as any
  other (the knob used to jump as it left zero).
- **The lanes and WIDTH no longer notch.** Each split the signal into
  bands and summed them back, which left a dip at every crossover (WIDTH's
  side channel was 5.9 dB down at 140 Hz when widening). Both now use
  shelves: a trim moves its band and nothing else.
- **DENSITY** compresses the first hit after silence like any other, and
  its make-up gain comes in with the knob instead of all at once.
- **Every stage has the same latency at every setting**, and REF runs
  through the same delays, so switching a stage or the reference never
  moves the music in time.
- **Loudness range** follows EBU Tech 3342 exactly (the relative gate sat
  on the wrong mean).
- **Tempo** is scored so a dotted or triplet relative of the beat can't
  outscore the beat, and fast tracks settle on one octave instead of
  something between two.

### Fixed
- Playback ran 0.8 to 2 LU quieter than the export at loud targets (its
  gain was an estimate that left out what the limiter takes); it now plays
  at the export's own gain (see above).
- The OUT preview's loudness solve had no pass limit (the counter only
  advanced while progress was being reported) and could run away on a
  target it couldn't reach. Every solve is now capped, and stops early
  when more gain stops buying loudness.
- One track's fixes (balance, bass mono, match curve, fades) rode along to
  the next track through A/B slots, saved settings and batch renders.
- Undo after switching A/B applied one slot's history to the other.
- A second file dropped while one was loading could leave the console on
  one track and the audio on another.
- Settings from an older version were thrown away whole on a version
  change, and the saved settings were rewritten 46 times a second while
  the app was open.
- Opening a project over a loaded reference re-fitted its match curve; a
  damaged cover image left a project half-open; a project that named
  itself as its audio opened itself for ever.
- Ctrl+W, Ctrl+R and the other hidden menu shortcuts closed or reloaded
  the app mid-render.
- A CD image that couldn't replace the previous one (open in a player)
  was deleted after the whole render; it now takes a numbered name.
- Opus files could end with a granule position that ran backwards.
- A steady song with drumless passages could be flagged as drifting (and a
  repair would then stretch its breakdowns); a source with one side out of
  phase showed an empty waveform; the loudness lane was drawn about a
  second late; noise or a held tone could be given sections and a tempo.
- The metronome dropped or doubled a click at some block edges; a seek
  could let through a moment of the place just left.
- Knobs: a drag could stick, Shift mid-drag made the value jump, typed
  values with a comma decimal were misread, Esc committed a typed value,
  and Shift+wheel did nothing on the lane trims.
- Holding Space, L or A re-triggered them; Ctrl+O, Ctrl+Z and Ctrl+Y acted
  behind an open sheet; the window couldn't be moved or closed while a
  sheet was up.
- The export sheet kept the previous track's typed file name.
- The wheel turned knobs and zoomed the waveform while scrolling past them
  on a small window.
- On a narrow window the console scrolled inside a page that also
  scrolled; panels now take their natural height and the page scrolls as
  one. A 1366 × 768 laptop shows the whole console.
- Amber text on the PAPER theme was close to unreadable.

### Under the hood
- `npm test`: 165 tests on the real DSP, export path, worklet, codecs,
  analysis and state, run by node's own test runner, and in CI.
- The capture and test scripts open the app without taking the keyboard
  focus.
- The store's pure parts (the console as data, the check sheet's rules,
  file naming and CUE text, the settings storage) are modules of their
  own.

## 2.7.0
- **Drift repair.** A drifting track can now be fixed, not just flagged.
  REPAIR DRIFT in the check sheet stretches the whole track onto one steady
  tempo: where the song sets out, its average, or any tempo you type. Pitch
  and stereo image stay exactly where they were. Before anything runs, the
  dialog shows the new length, how far any part of the song will stretch,
  and the beats on the new grid. The repair then plays, masters and exports
  in place of the file (batch and album renders of the loaded track too),
  the grid and CLICK go back to one fixed tempo, REVERT brings the file
  back, SAVE WAV writes the repair as a 32-bit float WAV, and a project
  re-runs the repair when it opens (on the same file only). The file on
  disk is never touched.
- How it holds up: the warp is built from the tempo curve integrated into
  a beat count (tracked beats jitter too much to steer a stretch), and the
  audio is heard through two frame lengths, long below 700 Hz so bass
  partials don't beat and short above so drum attacks stay sharp, with one
  set of phases across both, so a note on the split comes back whole.
  On the drift demo (110.0 → 114.2 BPM) every true beat lands within 9 ms
  of a steady 110 BPM grid (95th percentile) and the repair re-measures as
  a steady 110.0 BPM; a steady song "repaired" to its own tempo comes back
  unchanged (−145 dB).
- Fix: a source that peaks past full scale (a float file, or a repair) no
  longer spills over the edge of its waveform lane.

## 2.6.0
- **Tempo drift detection.** Generated tracks often speed up or slow down
  as they play. Every load now measures the tempo through the song, and a
  track that drifts is flagged: the track strip shows its range in amber
  (for example 138.0 → 145.9 BPM), the check sheet adds TEMPO STABILITY
  with a drift chart, where the drift begins, how far it goes and how far
  a fixed grid slides off the beat, and a BPM lane on the waveform, with
  an amber band on the time ruler, shades exactly the part of the song that
  drifts. SHOW ON WAVEFORM frames it, and hovering reads the local tempo.
- A drifting track's GRID and CLICK follow its tracked beats instead of a
  fixed grid that would slide off them.
- Tighter grids for steady tracks too: the BPM and grid now come from beats
  tracked through the whole song, reading 110.01 on a 110.00 BPM track
  (was 110.18) and landing within 11 ms of every beat (was up to 87 ms off
  by the end).
- Fix: a drifting track with a dotted rhythm could have its tempo read 4/3
  too fast. Short windows now vote on the tempo before the whole track is
  read.
- Fix: with LOOP on, the CLICK could drop the loop's first beat at every
  wrap (or accent the wrong one). Clicks now follow the looped audio.

### Sound (measured on the real DSP)
- **CHARACTER no longer dulls the top end.** The 4× oversampler's
  decimator had one branch a sample pair out of line, which rolled off
  every preset with CHARACTER above zero (28 of 30): −2.5 dB at 10 kHz,
  −6.2 dB at 15 kHz. It is now flat to 15 kHz (−0.01 dB). Presets sound
  brighter on top than before; that brightness was always meant to be
  there.
- **SMOOTH renders exactly as it previews.** It decided its cut once per
  processing block, and the export's blocks are 32 times longer than the
  preview's, so the two differed audibly (−31 dB residual at SMOOTH 1).
  It now decides on a fixed grid, and preview and export are
  bit-identical at any setting. It also lets go in silence instead of
  sitting at full cut after a quiet intro.
- **Loudness reads true.** The K-weighting now matches BS.1770-4
  coefficient for coefficient (the EBU 1 kHz reference reads −22.99 LUFS,
  was −23.25), so masters no longer land 0.1–0.4 LU hot on a compliant
  meter.
- **The true-peak ceiling holds.** The limiter's gain is now fully down
  when a peak arrives, and peaks are found at 8× oversampling: real
  material pushed 12 dB into a −1.0 dBTP ceiling measures −0.97 to
  −0.99 dBTP at 16× (was about −0.7).
- **Loud targets land.** The loudness solve learns how the limiter pushes
  back instead of stepping blindly: −7 to −14 LUFS targets all land within
  0.05 LU (a −8 target could fall 0.7 LU short). Checked with ffmpeg's EBU
  R128 meter: −11.5 LUFS and −1.0 dBTP on ROCK's −11.5 / −1.0.
- Exports line up with the source sample for sample and keep their last
  5 ms (two limiter delays were never compensated).
- The OUT preview is the export: both run the same render, so what OUT
  shows is exactly what RENDER writes.
- Dragging an advanced EQ band no longer thumps the other bands.
- Fades no longer click when a loop wraps inside the fade.
- Renders are faster despite the finer peak detection: a 5-minute track
  with ROCK went from 11.5 s to 9.3 s, and from 3.9 s to 1.5 s flat.

### Safety
- **Fix: REF could leak into exports.** A tap of R latches the untouched
  source, and a render made while it was latched came out unprocessed
  (only normalized). REF and LIM Δ are listening aids and never render.
- **Fix: a failed save froze EXPORT.** A render error or a file that
  couldn't be written (open in a player, a blocked folder, a full disk)
  left the sheet stuck at SAVING 98% until restart. It now says why and
  recovers.
- **Nothing is overwritten.** Batch masters, ALSO SAVE copies and every
  other file saved into a folder get " (2)", " (3)"… instead of replacing
  what's there (an ALSO SAVE MP3 could replace its own source). A CD image
  is written beside its final name and only replaces the previous image
  once complete.
- **A shared project can't reach out over the network.** Paths in a
  `.jmaster` file that point at another machine are never opened by
  themselves (Windows would sign in there with your credentials); network
  paths you choose yourself work as before. The app window can no longer
  be navigated away, and it runs sandboxed.
- Projects and saved settings are checked value by value, so a newer,
  older or hand-edited file can't put NaN or an unknown setting into the
  chain.

### Workflow
- Esc closes the open sheet (never mid-render). Console keys rest while a
  sheet is open, Ctrl+A or Ctrl+L no longer act as A or L, and Home on a
  focused knob resets the knob, not the song.
- Batch and album tracks no longer take the loaded track's balance
  correction and fades; each starts centred and takes its own fixes.
- MASTER ALL on a finished queue masters it again with the current
  console (it used to report success and render nothing).
- AUTO is one undo step: UNDO ALL OF IT now also undoes the preset it
  chose and the genre tag.
- A/B slots keep the advanced EQ, match EQ, stem trims and bass mono, and
  switching slots no longer lands in undo history.
- Undo history belongs to a track and starts fresh when another loads.
- A loaded MATCH reference re-fits its curve to each new track.
- The DIAG width fix only ever narrows.
- The codec audition stops when EXPORT closes, when the format changes,
  or when playback starts.
- A typed export name keeps itself when the format changes and always
  gets the right extension; ALSO SAVE copies are named after the file you
  actually saved.
- A project opened without its audio keeps pointing at it (a save doesn't
  lose the track) and restores its balance when you load it.

### Analysis
- **Silence is silence.** Leading or trailing silence no longer skews the
  tempo or wipes out section changes (a 40 s silent tail used to hide all
  of them): tempo is measured on the music alone, and long silences show
  as SILENCE sections.
- Silence, blips and drones report no tempo ("— BPM") instead of a made-up
  200.9 BPM, and GRID and CLICK stand down.
- A riser or build-up no longer pulls a section boundary a bar early.
- Surround files fold down to stereo properly (5.1 was mastered from its
  front left and right only).
- MP3, FLAC, Ogg and M4A show their real sample rate (was always 48 kHz).
- NaN or infinite samples in a float WAV are silenced (and reported)
  instead of silencing the whole preview.
- A source too quiet or short to measure is rendered at unity gain rather
  than blown up to the target.
- Silent audio reads "< −70 LUFS" and "−∞ dBTP" instead of −70.0 / −200.0.

### Formats
- Opus files keep their exact length (they lost their last 6.5 ms) and
  their timing stamps follow RFC 7845.
- CD: the CUE sheet is Latin-1 with an ASCII image name that every burner
  can find; quotes in titles no longer break it; 12-digit UPC-A barcodes
  are accepted and every code's check digit is verified; invalid ISRCs
  are left out and reported; CD limits (99 tracks, 4 s each, 79:57) are
  checked before the render starts.

### Look and feel
- Small windows: the lower deck keeps a usable height and the whole
  workspace scrolls, the start screen no longer pushes the status bar off
  short windows, and the track strip can't be covered by the waveform.
- OUTPUT puts its units in the captions, so numbers never wrap.
- PAPER: the waveform and meter wells keep their dark-theme lines and
  text, and toasts are dark plates that stand off the page.
- Dialog subtitles and batch names end in an ellipsis (with the full text
  as a tooltip) instead of crossing the frame; failed batch rows say why.
- Recent files are left-aligned rows with their folder; long paths keep
  their end in view.
- The waveform and spectrum repaint after a resize; MATCH shows its curve
  when reopened; the advanced EQ idles when nothing moves.
- Shift+wheel pans both ways; trackpads pan and zoom smoothly; a wheel
  over a knob turns only the knob.
- Keyboard and screen readers: sheets take focus and give it back, the
  console behind them goes inert, toggles report their state, icon buttons
  have names, and tooltips keep descriptions readable.

## 2.5.0
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
- **Hear it as the platforms play it.** A NORM row under MON turns
  playback down exactly as Spotify, Apple Music or YouTube would at your
  loudness target, so a louder master and a more dynamic one can be
  compared at the level listeners actually hear. Playback only: the
  meters keep reading the master and exports are untouched.
- **ALSO SAVE in EXPORT.** Tick extra formats and they are encoded from
  the same render and saved beside the master, for example a WAV for
  distribution plus an MP3 for sharing: one loudness solve, one pass. A
  WAV and FLAC from the same render are bit-identical.
- Fix: the save dialog offered a "WAV audio" file type for every format;
  it now matches the format being exported.
- Knobs light up while you hold them, and the keys sheet covers typing a
  value and dropping files.
- **Vectorscope.** A SCOPE tab beside SPECTRUM plots the stereo image:
  mono content is a vertical line, width spreads it sideways, and phase
  trouble leans toward horizontal. Phosphor-style persistence and auto
  gain keep quiet passages readable.
- Fix: the meters rack squashed its rows when space ran short, clipping
  text and the spectrum. It now scrolls instead, and fits without
  scrolling at the default window size.
- **Your own presets.** + SAVE in the preset rack stores the console
  (macros, target, ceiling, genre) under your name; your presets list
  above the genres, persist between sessions, and can be picked per
  track in BATCH. Saving under an existing name updates it, and deleting
  takes a second click to confirm.
- Tweaking a preset no longer makes the rack forget it: the row you
  started from stays lit, marked MODIFIED, with a REVERT button.
- **Tooltips in the Jamware style** replace the slow native ones app-wide,
  with keyboard shortcuts shown as key caps. They also appear on keyboard
  focus, and hovering a macro knob now explains what it does.
- Fix: the window's Minimize button held keyboard focus from startup (a
  stray focus ring, and Enter would minimize). Focus now starts on OPEN
  FILE.
- STEM LANES became a drawer beside EQ, and both show a lamp when their
  settings are active. Track specs wrap instead of clipping mid-word,
  knob captions fit whole, the spectrum has frequency labels, and toasts
  cap at three.
- **A new README.** Animated banners set in the app's own typefaces, GIFs
  of the features recorded from the running app, and fresh screenshots.
  All of it regenerates from scripts that drive the production build with
  real input on a throwaway profile, playing a synthesized demo track.

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
