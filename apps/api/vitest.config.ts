import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    // Database tests share one test database, so run files one at a time.
    fileParallelism: false,
  },
});
