import { defineConfig } from 'vite';

export default defineConfig({
  base: '/fluffy-rotary-phone/receiver/',
  build: {
    outDir: '../../dist/receiver',
    emptyOutDir: true
  }
});
