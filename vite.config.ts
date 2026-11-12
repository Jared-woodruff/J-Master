import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The built app runs under a strict policy: its own files and nothing else.
// It is added at build time only, because the dev server's React refresh
// preamble is an inline script, which this policy (rightly) refuses.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspAtBuild(): Plugin {
  return {
    name: 'jmaster-csp',
    apply: 'build',
    transformIndexHtml: () => [{
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
      injectTo: 'head-prepend',
    }],
  };
}

// Renderer build. Electron loads dist/index.html in production;
// in dev (or browser preview) Vite serves it at localhost.
export default defineConfig({
  plugins: [react(), cspAtBuild()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version as string),
  },
  server: {
    port: 5183,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    target: 'chrome120',
    assetsInlineLimit: 0,
    // One bundle, loaded from disk: there is no network to split it for.
    chunkSizeWarningLimit: 1200,
  },
});
