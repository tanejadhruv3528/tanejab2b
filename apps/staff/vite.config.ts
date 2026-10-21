import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Staff console and rider screens. In development the API runs on :3000 and is reached through /api.
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['source'] },
  build: { target: 'es2022' },
  server: {
    port: 5174,
    proxy: { '/api': { target: 'http://localhost:3000', rewrite: (path) => path.replace(/^\/api/, '') } },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
});
