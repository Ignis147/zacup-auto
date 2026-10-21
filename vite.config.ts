import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base соответствует пути репозитория на GitHub Pages: https://USERNAME.github.io/zacup-auto/
export default defineConfig({
  base: '/zacup-auto/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
