import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

export default defineConfig({
  // MapLibre's worker is an ES module that imports a shared chunk.
  worker: { format: 'es' },
  // The app's version, for bug reports.
  define: { __APP_VERSION__: JSON.stringify(version) },
});
