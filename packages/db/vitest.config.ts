import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each suite boots an in-process PGlite (WASM Postgres) and runs the real
    // migrations in beforeAll. That takes a few seconds on an idle machine and
    // blew the 10s default on a CI runner while turbo ran other packages'
    // tasks in parallel.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
