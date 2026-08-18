# Changelog

## 2.2.1
- Fix track-strip spec row colliding with the action buttons (dropped the
  redundant true-peak spec; overflow now clips instead of overlapping).
- Fix export-dialog audition hint overflowing the dialog.
- Windows ARM64 builds (`npm run dist:arm64`); artifact names now carry
  the architecture.

## 2.2.0
- **STEM LANES:** bass / drums / vocal / air component trims O±3 dB),
  phase-coherent subtractive extraction.
- **Album / CD assembly:** 44.1 kHz/16-bit image WAV Oframe-aligned,
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
- **Track diagnosis:** SUNO-pathology check sheet with measured values,
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
  release **metadata tags** ORIFF INFO / Vorbis comment / ID3v2.3).

## 1.1.0
- Waveform **zoom/pan** with peak pyramid; before/after **spectrum overlay**;
  **FLAC + MP3** export; **batch album** processing.

## 1.0.0
- The console: eight-macro chain, BS.1770-4 metering, exact loudness solve,
  true-peak limiting, fades, genre presets, streaming targets,
  24-bit/48 kHz WAV export, PLATE/PAPER themes, Windows x64 packaging.
