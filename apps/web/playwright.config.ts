import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Keep browser timing stable on development machines
  workers: 2,
  use: {
    baseURL: process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    {name: 'desktop', use: {viewport: {width: 1280, height: 800}}},
    {name: 'mobile', use: {viewport: {width: 390, height: 844}}},
    {
      name: 'firefox',
      testMatch: '**/accessibility.spec.ts',
      use: {browserName: 'firefox', viewport: {width: 1280, height: 800}},
    },
    {
      name: 'webkit',
      testMatch: '**/accessibility.spec.ts',
      use: {browserName: 'webkit', viewport: {width: 1280, height: 800}},
    },
    {
      name: 'webkit-mobile',
      testMatch: '**/accessibility.spec.ts',
      use: {
        browserName: 'webkit',
        viewport: {width: 390, height: 844},
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
  ],
});
