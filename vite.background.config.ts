import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: fromRoot('./src/background/index.ts'),
      formats: ['iife'],
      name: 'PageStudyBackground',
      fileName: () => 'background.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        extend: true,
      },
    },
  },
});
