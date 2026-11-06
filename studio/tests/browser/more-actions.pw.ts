import {expect, test} from '@playwright/test';

test('@smoke More actions lists labelled commands without header fragments', async ({page}) => {
  await page.goto('/tests/browser/document-tabs.html');
  await page.waitForFunction(() => document.documentElement.dataset.tabsReady === 'true');
  await page.getByRole('button', {name: 'More actions'}).click();
  const dialog = page.getByRole('dialog', {name: 'More actions'});
  await expect(dialog).toBeVisible();
  // Breadcrumb separators and the divider rule are pill-only decoration.
  for (const node of await dialog.locator('.pill-muted, .pill-rule').all()) await expect(node).toBeHidden();
  const words = dialog.locator('.pill-words');
  await expect(words).toBeVisible();
  expect(await words.evaluate(el => getComputedStyle(el, '::before').content)).toContain('Current scene');
  const palette = dialog.getByRole('button', {name: 'Open command palette'});
  await expect(palette).toBeVisible();
  expect(await palette.evaluate(el => getComputedStyle(el, '::before').content)).toContain('Jump to scene');
});
