import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tests run against TypeScript source, not `dist/`.
 *
 * Aliasing the workspace packages here means `npm test` needs no build step and
 * can never pass against stale compiled output — the two failure modes that
 * make a monorepo test suite untrustworthy.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@keydate/protocol': path.resolve(here, 'packages/protocol/src/index.ts'),
      '@keydate/netcode': path.resolve(here, 'packages/netcode/src/index.ts'),
      '@keydate/sim': path.resolve(here, 'packages/sim/src/index.ts'),
      '@keydate/table-games': path.resolve(here, 'packages/games/table-games/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'packages/games/*/src/**', 'apps/server/src/**'],
      reporter: ['text', 'lcov'],
    },
  },
});
