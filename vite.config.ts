import { defineConfig } from 'vite';

export default defineConfig({
  // MapLibre's worker is an ES module that imports a shared chunk.
  worker: { format: 'es' },
});
