import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Renderer build. Electron loads dist/index.html in production;
// in dev (or browser preview) Vite serves it at localhost.
export default defineConfig({
  plugins: [react()],
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
  },
});
