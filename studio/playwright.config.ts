import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', testMatch: '**/*.pw.ts', outputDir: process.env.TMPDIR ? `${process.env.TMPDIR}/heinlein-theme-browser-results` : '/tmp/heinlein-theme-browser-results', fullyParallel: false, workers: 1, timeout: 30_000,
  use: {baseURL: 'http://127.0.0.1:1434', trace: 'retain-on-failure'},
  projects: [{name: 'desktop', use: {viewport: {width: 1280, height: 900}}}, {name: 'narrow', use: {viewport: {width: 320, height: 740}}}],
  webServer: {command: 'npm run dev -- --port 1434', url: 'http://127.0.0.1:1434', reuseExistingServer: false},
});
