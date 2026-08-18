// Bundles the AudioWorklet processor and the offline render worker into
// public/audio/. Both share the DSP sources in src/audio/dsp, guaranteeing
// the preview chain and the exported master are numerically identical.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('public/audio', { recursive: true });

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: ['src/audio/worklet/processor.ts'],
  outfile: 'public/audio/jmaster-processor.js',
});

await build({
  ...common,
  entryPoints: ['src/audio/render/render-worker.ts'],
  outfile: 'public/audio/jmaster-render-worker.js',
});
