import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `shelved/` holds the game, which is not built and whose tests resolve
    // `@keydate/*` through a config that moved with it. Running them here would
    // fail for reasons that have nothing to do with the apps being worked on.
    exclude: ['**/node_modules/**', 'shelved/**'],
  },
});
