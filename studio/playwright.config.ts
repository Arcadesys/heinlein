import {defineConfig} from '@playwright/test';
const portText = process.env.HEINLEIN_BROWSER_PORT ?? '1434';
const port = Number(portText);
if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('HEINLEIN_BROWSER_PORT must be an integer from 1024 to 65535');
}
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests/browser', testMatch: '**/*.pw.ts', outputDir: process.env.RUNNER_TEMP ? `${process.env.RUNNER_TEMP}/heinlein-theme-browser-results` : process.env.TMPDIR ? `${process.env.TMPDIR}/heinlein-theme-browser-results` : '/tmp/heinlein-theme-browser-results', fullyParallel: false, workers: 1, timeout: 30_000,
  use: {baseURL, trace: 'retain-on-failure'},
  projects: [{name: 'desktop', use: {viewport: {width: 1280, height: 900}}}, {name: 'narrow', use: {viewport: {width: 320, height: 740}}}],
  webServer: {command: `npm run dev -- --port ${port} --strictPort`, url: baseURL, reuseExistingServer: false},
});
