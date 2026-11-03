import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Server replaces this HTML prefix at runtime; one build supports /sys or another base path.
export default defineConfig({ root: resolve('dashboard'), base: '/__OCC_BASE_PATH__/',
  plugins: [{ name: 'occ-runtime-config', transformIndexHtml: { order: 'post', handler: () => [
    { tag: 'script', attrs: { src: '/__OCC_BASE_PATH__/config.js' }, injectTo: 'head-prepend' },
  ] } }],
  build: { outDir: 'dist', emptyOutDir: true } });
