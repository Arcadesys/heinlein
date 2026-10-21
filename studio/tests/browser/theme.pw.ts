import {test, expect} from '@playwright/test';
test('normal renderer opens Appearance without native access', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', {name: 'Appearance', exact: false}).click();
  await expect(page.getByRole('dialog', {name: 'Appearance'}), JSON.stringify(errors)).toBeVisible();
  await page.getByRole('button', {name: 'Vibecode theme', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Vibecode your theme'})).toBeVisible();
  expect(await page.evaluate(() => 'themeFixtureRequests' in window)).toBe(false);
  expect(errors).toEqual([]);
});

import AxeBuilder from '@axe-core/playwright';
import {dark, light} from './tokens';
const storageKey = 'heinlein-studio-custom-theme-v1';
const rootBg = (page: import('@playwright/test').Page) => page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--bg').trim());
async function openThemes(page: import('@playwright/test').Page) {
  await page.getByRole('button', {name: 'Appearance', exact: false}).click();
  await page.getByRole('button', {name: 'Vibecode theme', exact: true}).click();
}
async function generate(page: import('@playwright/test').Page, aesthetic = 'Warm library') {
  await page.getByLabel('Describe your aesthetic', {exact: true}).fill(aesthetic);
  await page.getByRole('button', {name: 'Generate theme candidate', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Apply theme', exact: true})).toBeEnabled();
}
test('synthetic provider: review, keyboard, contrast, persistence, reset and reflow', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  // No paid provider calls, remote CSS or external assets are allowed in this smoke.
  const remote: string[] = [];
  await page.route('**/*', route => {if (new URL(route.request().url()).hostname !== '127.0.0.1') {remote.push(route.request().url()); return route.abort();} return route.continue();});
  await page.goto('/tests/browser/fixture.html');
  await expect(page.locator('.cm-content')).toContainText('Synthetic prose — exact words.');
  const source = await page.locator('.cm-content').textContent();
  await openThemes(page); await generate(page);
  expect(await rootBg(page)).toBe('#0a0a14');
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  await expect(page.getByText('Candidate preview — not saved', {exact: true})).toBeVisible();
  await expect(page.getByLabel('Theme CSS diff', {exact: true})).toContainText('− #0a0a14');
  expect(await page.locator('.theme-live-sample').evaluate(el => getComputedStyle(el).getPropertyValue('--bg').trim())).toBe(dark.bg);
  // Tab into the sample through actual keyboard events; focus remains visibly outlined.
  await page.getByLabel('Theme sample text', {exact: true}).focus(); await page.keyboard.press('Tab');
  await expect(page.getByRole('button', {name: 'Sample action', exact: true})).toBeFocused();
  const focus = await page.getByRole('button', {name: 'Sample action', exact: true}).evaluate(el => {const s = getComputedStyle(el); return {width: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor};});
  expect(focus.style).toBe('solid'); expect(parseFloat(focus.width)).toBeGreaterThanOrEqual(2); expect(focus.color).toBe('rgb(255, 204, 102)');
  await page.getByRole('button', {name: 'Hover or focus this control'}).hover();
  await expect(page.getByRole('button', {name: 'Hover or focus this control'})).toHaveCSS('background-color', 'rgb(34, 34, 34)');
  await page.getByRole('button', {name: 'Apply theme', exact: true}).focus(); await page.keyboard.press('Enter');
  expect(await rootBg(page)).toBe(dark.bg);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).accepted, storageKey)).toEqual(dark);
  // Full visible dialog is audited after applying both dark and light candidates.
  for (const aesthetic of ['Warm library', 'light paper']) {
    await generate(page, aesthetic); await page.getByRole('button', {name: 'Apply theme', exact: true}).click();
    const selection = await page.getByLabel('Theme sample text', {exact: true}).evaluate(el => {const s = getComputedStyle(el, '::selection'); return {fg: s.color, bg: s.backgroundColor};});
    expect(selection).toEqual(aesthetic === 'light paper' ? {fg: 'rgb(17, 17, 17)', bg: 'rgb(238, 238, 238)'} : {fg: 'rgb(255, 255, 255)', bg: 'rgb(34, 34, 34)'});
    for (const label of ['Theme sample text', 'Disabled sample action']) {
      const control = label === 'Theme sample text' ? page.getByLabel(label, {exact: true}) : page.getByRole('button', {name: label, exact: true});
      await control.scrollIntoViewIfNeeded();
      const sampleAudit = await new AxeBuilder({page}).include('.theme-live-sample').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(sampleAudit.violations.map(item => item.id)).toEqual([]);
    }
    await page.getByRole('button', {name: 'Apply theme', exact: true}).scrollIntoViewIfNeeded();
    const audit = await new AxeBuilder({page}).include('.settings-window').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(audit.violations.map(item => ({id: item.id, nodes: item.nodes.map(n => n.target)}))).toEqual([]);
    expect(await page.locator('.settings-window').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.locator('.settings-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const sampleSize = await page.getByLabel('Theme sample text', {exact: true}).evaluate(el => parseFloat(getComputedStyle(el).fontSize)); expect(sampleSize).toBeGreaterThanOrEqual(16);
  }
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', {name: 'Appearance'})).not.toBeVisible();
  await expect(page.getByRole('button', {name: 'Appearance', exact: false})).toBeFocused();
  await page.reload(); expect(await rootBg(page)).toBe(light.bg);
  expect(await page.locator('.cm-content').textContent()).toBe(source);
  await openThemes(page); await page.getByRole('button', {name: 'Revert accepted theme'}).click(); expect(await rootBg(page)).toBe(dark.bg);
  await page.getByRole('button', {name: 'Reset to baseline'}).click(); expect(await rootBg(page)).toBe('#0a0a14');
  await generate(page); await page.keyboard.press('Escape'); await page.reload(); expect(await rootBg(page)).toBe('#0a0a14');
  await openThemes(page); await generate(page); await page.getByRole('button', {name: 'Discard candidate'}).click(); expect(await rootBg(page)).toBe('#0a0a14');
  const requests = await page.evaluate(() => (window as unknown as {themeFixtureRequests: {context: string; history: unknown[]}[]}).themeFixtureRequests);
  expect(requests.every(r => r.context === '' && r.history.length === 0)).toBe(true);
  expect(remote).toEqual([]); expect(errors).toEqual([]);
});

test('synthetic failures and unavailable storage preserve accepted theme', async ({page}) => {
  await page.goto('/tests/browser/fixture.html'); await openThemes(page);
  await page.getByLabel('Describe your aesthetic', {exact: true}).fill('provider-failure');
  await page.getByRole('button', {name: 'Generate theme candidate', exact: true}).click();
  await expect(page.getByText('Synthetic empty-answer failure. No request retried.', {exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Apply theme', exact: true})).toBeDisabled(); expect(await rootBg(page)).toBe('#0a0a14');
  expect(await page.evaluate(() => (window as unknown as {themeFixtureRequests: unknown[]}).themeFixtureRequests.length)).toBe(1);
  await generate(page);
  await page.evaluate(key => {const original = Storage.prototype.setItem; Storage.prototype.setItem = function (name, value) {if (name === key) throw new DOMException('Synthetic storage full', 'QuotaExceededError'); original.call(this, name, value);};}, storageKey);
  await page.getByRole('button', {name: 'Apply theme', exact: true}).click();
  await expect(page.getByText('Synthetic storage full', {exact: true})).toBeVisible(); expect(await rootBg(page)).toBe('#0a0a14');
  await expect(page.getByRole('button', {name: 'Apply theme', exact: true})).toBeEnabled();
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
});
