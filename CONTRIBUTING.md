# Contributing to J-Master

Thanks for the interest. A few ground rules keep this codebase what it is.

## The one rule that matters

**Every DSP claim gets measured.** If your change says it boosts, cuts,
detects, or preserves something, prove it with numbers before opening the
PR, and leave the proof behind as a test. `npm test` runs the suite in
`tests/` (node's own runner, no framework; `npm test -- limiter` runs the
suites whose file name contains "limiter"). The pattern used throughout:
synthesize a signal with known ground truth (`tests/lib/signals.ts`), run it
through the real chain or the real export path, measure the output. For
anything that needs the running app there is a scripting hook: open DevTools
and drive `window.__jmaster` (`store`, `engine`, `chainParams()`). See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) → *Verification*, and the phase
lessons in the same file before touching any band processing.

## Practicalities

- `npm run dev` for the browser-hosted renderer, `npm run dev:app` for the
  full Electron shell. `npm run typecheck` and `npm test` must pass (CI runs
  both, and the build).
- State changes get a test too: `tests/store.test.ts` runs the real store
  under node (`tests/lib/store-harness.ts`).
- Never let an automated run press a save or render button: it opens a
  native dialog on someone's screen.
- DSP lives in `src/audio/dsp/` and runs in both the worklet and the render
  worker; rebuild bundles with `npm run audio:build` after touching it.
- Keep the design language: paper/graphite/signal-orange, square corners,
  hairlines, mono spec labels, no gradients, no shadows, no emoji. When in
  doubt, look at an existing panel.
- Preview and export must stay numerically consistent (the WYSIWYG
  contract). Anything that processes audio in only one of the two paths, or
  decides anything per processing block, will be declined.
- One feature per PR, with the measurement in the description.

## License

Contributions are accepted under GPL-3.0 (see [LICENSE](LICENSE)).
Copyright © 2026 JMW Software and Jamware Records.
