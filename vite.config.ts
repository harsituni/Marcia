/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import cesium from 'vite-plugin-cesium';

// GitHub Pages serves the site at the root of https://trymarcia.work/ (public/CNAME);
// CI sets BASE_PATH for that build. A plain <user>.github.io/<repo>/ deploy would need BASE_PATH=/<repo>/.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), tailwindcss(), cesium()],
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
