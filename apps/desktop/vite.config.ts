import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('./src/renderer', import.meta.url)), base: './', build: { outDir: '../../dist/renderer', emptyOutDir: true } });
