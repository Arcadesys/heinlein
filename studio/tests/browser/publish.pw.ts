import {test, expect, type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
// Synthetic host only: publishBook records the request; no publisher, files or network.
async function open(page: Page) {
  const nav = page.getByRole('button', {name: 'Navigation', exact: true}); if (await nav.isVisible()) await nav.click();
  await page.getByRole('button', {name: 'Publish book…', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Publish book'}); await expect(dialog).toBeVisible(); return dialog;
}
test('@smoke Publish builds the designed book from the live manuscript, then is one click', async ({page}, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/tests/browser/library-app.html?export&unified&publish');
  let dialog = await open(page);
  await expect(dialog.getByLabel('Book title')).toHaveValue('Synthetic book');
  for (const name of ['PDF (print-ready book)', 'EPUB (ebook)', 'DOCX (Word)']) await expect(dialog.getByLabel(name)).toBeChecked();
  await expect(dialog.getByLabel('HTML (web page)')).not.toBeChecked();
  await dialog.getByLabel('Author').fill('Synthetic Author');
  await dialog.getByLabel('Approve book design and imprint branding').check();
  expect((await new AxeBuilder({page}).include('dialog').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({path: info.outputPath('publish-dialog.png')});
  await dialog.getByRole('button', {name: 'Publish…'}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/Published 3 files to “Synthetic book — published/)).toBeVisible();
  // Second time everything is remembered, so Publish… is the only click in the dialog.
  dialog = await open(page);
  await dialog.getByRole('button', {name: 'Publish…'}).click();
  await expect(dialog).toHaveCount(0);
  const publishes = await page.evaluate(() => (window as any).publishFixture.publishes);
  expect(publishes).toHaveLength(2);
  expect(publishes[1]).toMatchObject({title: 'Synthetic book', author: 'Synthetic Author', formats: ['pdf', 'epub', 'docx'], brandingApproved: true});
  expect(publishes[0].text.indexOf('ALPHA-BEGIN')).toBeLessThan(publishes[0].text.indexOf('OMEGA-END'));
  expect(publishes[0].text).not.toContain('REFERENCE-ONLY');
  expect(errors).toEqual([]);
});
