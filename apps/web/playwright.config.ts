import { defineConfig } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  // Fail the build if `test.only` was committed.
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  reporter: CI ? [['blob'], ['github']] : [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run build && npm run preview',
    port: 4173,
    reuseExistingServer: !CI,
  },
});
