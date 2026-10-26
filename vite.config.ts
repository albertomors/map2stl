import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

// The dev server appends what the app posts to /__dev-log/<name> to debug/<name>.jsonl
// (src/dev-log.ts): records from real use, to tune the app's estimates.
function devLog(): Plugin {
  return {
    name: 'dev-log',
    configureServer(server) {
      server.middlewares.use('/__dev-log/', (req, res) => {
        const name = (req.url ?? '').replace(/^\//, '');
        if (!/^[a-z0-9-]+$/.test(name)) {
          res.statusCode = 400;
          return res.end();
        }
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          mkdirSync('debug', { recursive: true });
          appendFileSync(`debug/${name}.jsonl`, body.trim() + '\n');
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  // MapLibre's worker is an ES module that imports a shared chunk.
  worker: { format: 'es' },
  // The app's version, for bug reports.
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [devLog()],
});
