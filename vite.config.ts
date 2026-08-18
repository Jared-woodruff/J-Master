import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer build. Electron loads dist/index.html in production;
// in dev (or browser preview) Vite serves it at localhost.
export default defineConfig({
  plugins: [react()],
  base: './',
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
