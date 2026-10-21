import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// In development the API runs on :3000 and is reached through /api so the browser sees one origin.
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['source'] },
  build: {
    target: 'es2022',
    // The demo build is published as one self-contained page, so keep it to a single script.
    ...(process.env.VITE_DEMO === 'true' ? { rollupOptions: { output: { inlineDynamicImports: true } } } : {}),
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', rewrite: (path) => path.replace(/^\/api/, '') } },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
});
