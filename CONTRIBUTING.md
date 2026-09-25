# Contributing to J-Master

Thanks for the interest. A few ground rules keep this codebase what it is.

## The one rule that matters

**Every DSP claim gets measured.** If your change says it boosts, cuts,
detects, or preserves something, prove it with numbers before opening the
PR. The app ships a scripting hook for exactly this: open DevTools and drive
`window.__jmaster` (`store`, `engine`, `chainParams()`). The pattern used
throughout development: synthesize a signal with known ground truth, render
it through the real chain, measure the output. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) → *Verification harness*, and
the phase-coherence war stories in the same file before touching any
parallel band processing.

## Practicalities

- `npm run dev` for the browser-hosted renderer, `npm run dev:app` for the
  full Electron shell. `npx tsc --noEmit` must pass.
- DSP lives in `src/audio/dsp/` and runs in both the worklet and the render
  worker; rebuild bundles with `npm run audio:build` after touching it.
- Keep the design language: paper/graphite/signal-orange, square corners,
  hairlines, mono spec labels, no gradients, no shadows, no emoji. When in
  doubt, look at an existing panel.
- Preview and export must stay numerically consistent (the WYSIWYG
  contract). Anything that processes audio in only one of the two paths
  will be declined.
- One feature per PR, with the measurement in the description.

## License

Contributions are accepted under GPL-3.0 (see [LICENSE](LICENSE)).
Copyright © 2026 JMW Software and Jamware Records.
