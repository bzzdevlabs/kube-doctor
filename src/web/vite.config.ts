import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [preact()],
  build: {
    outDir: fileURLToPath(new URL('../../dist/web', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // No inline scripts/styles: the server's Content-Security-Policy forbids them.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:7420', changeOrigin: true } },
  },
});
