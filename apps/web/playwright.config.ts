import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    {name: 'desktop', use: {viewport: {width: 1280, height: 800}}},
    {name: 'mobile', use: {viewport: {width: 390, height: 844}}},
  ],
});
