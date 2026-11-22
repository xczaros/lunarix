import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  build: {
    outDir: resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
    chunkSizeWarningLimit: 8000,
    sourcemap: false,
    assetsInlineLimit: 0
  },
  worker: {
    format: 'es'
  },
  optimizeDeps: {
    include: ['monaco-editor']
  }
});
