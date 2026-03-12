import { defineConfig } from 'vite';

export default defineConfig({
  base: '/fluffy-rotary-phone/sender/',
  build: {
    outDir: '../../dist/sender',
    emptyOutDir: true
  }
});
