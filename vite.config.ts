/// <reference types="vitest/config" />
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

/**
 * Serves `fixtures/` at `<base>fixtures/` in dev and copies it into the build,
 * so the mock data stays in one place (the tests read it from there too).
 */
function fixtures(): Plugin {
  return {
    name: 'marcia-fixtures',
    configureServer(server) {
      server.middlewares.use(`${server.config.base}fixtures`, (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!));
        const file = join(FIXTURES, rel);
        if (!file.startsWith(FIXTURES + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      if (options.dir) cpSync(FIXTURES, join(options.dir, 'fixtures'), { recursive: true });
    },
  };
}

// GitHub Pages serves the site from /<repo>/; CI sets BASE_PATH for that build.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), tailwindcss(), fixtures()],
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
