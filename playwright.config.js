import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { channel: 'chrome', viewport: { width: 1440, height: 1080 }, screenshot: 'only-on-failure' },
  reporter: 'list'
});
