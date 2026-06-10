import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const benchDir = dirname(fileURLToPath(import.meta.url));

/**
 * Standalone vitest config for the benchmark's metric tests ONLY.
 * Kept separate from rag-api/vitest.config.ts (whose `include` is scoped to
 * src/**) so these tests neither run as part of nor break the main suite.
 *
 *   cd rag-api && npx vitest run --config bench/vitest.config.ts
 */
export default defineConfig({
  root: benchDir,
  // Keep Vite's cache out of bench/ so no node_modules/.vite artifact is created here.
  cacheDir: '../node_modules/.vite/bench',
  test: {
    globals: true,
    environment: 'node',
    include: ['*.test.ts'],
  },
});
