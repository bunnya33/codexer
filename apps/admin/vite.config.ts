import { defineConfig } from 'vite';

export default defineConfig({
  base: '/admin/',
  server: { port: 5174, proxy: { '/v1': { target: process.env.CODEXER_RELAY_URL || 'http://127.0.0.1:8787', changeOrigin: true } } },
  build: { outDir: 'dist', emptyOutDir: true },
});
