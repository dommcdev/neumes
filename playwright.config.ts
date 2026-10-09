import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1280, height: 960 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
  },
  webServer: { command: 'bun run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI },
});
