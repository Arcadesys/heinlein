import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('insert, describe and read an illustration without replacing selected prose', async ({ page }) => {
  await page.goto('/tests/browser/document-tabs.html?titled&illustrations');
  await page.waitForFunction(() => document.documentElement.dataset.tabsReady === 'true');
  await page.evaluate(() => {
    const f = (window as any).documentFixture;
    f.theme(true);
    document.documentElement.dataset.zoom = '200';
    f.view().dispatch({ selection: { anchor: 0, head: 3 } });
  });
  const text = () => page.evaluate(() => (window as any).documentFixture.view().state.doc.toString());
  const before = await text();
  async function open() {
    await page.getByRole('button', { name: 'Document actions', exact: true }).click();
    await page.getByRole('button', { name: 'Editing actions', exact: true }).click();
    await page.getByRole('button', { name: 'Insert image…' }).click();
    return page.getByRole('dialog', { name: 'Insert illustration' });
  }
  const dialog = await open();
  await expect(dialog).toContainText('After selected prose');
  await expect(dialog.getByLabel('Image description')).toBeFocused();
  expect((await new AxeBuilder({ page }).include('.illustration-dialog').analyze()).violations).toEqual(
    []
  );
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.keyboard.press('Escape');
  expect(await text()).toBe(before);
  await page.evaluate(() => ((window as any).imageProbe.cancelPick = true));
  await open();
  await expect(dialog).toHaveCount(0);
  expect(await text()).toBe(before);
  await page.evaluate(() => ((window as any).imageProbe.cancelPick = false));
  await open();
  await dialog.getByLabel('Image description').fill('A town map');
  await dialog.getByRole('button', { name: 'Insert image', exact: true }).press('Enter');
  expect(await text()).toBe(
    before.slice(0, 3) + '![A town map](../assets/images/example.png)' + before.slice(3)
  );
  expect(await page.evaluate(() => (window as any).imageProbe.sends)).toBe(0);
  await page.keyboard.press('Meta+z');
  expect(await text()).toBe(before);
  await page.keyboard.press('Meta+Shift+z');
  await page.getByRole('button', { name: 'Reading', exact: true }).click();
  await expect(page.getByRole('img', { name: 'A town map' })).toHaveJSProperty('naturalWidth', 1);
});

test('AI stays optional and stale insertion keeps the draft', async ({ page }) => {
  await page.goto('/tests/browser/document-tabs.html?titled&illustrations');
  await page.waitForFunction(() => document.documentElement.dataset.tabsReady === 'true');
  async function open() {
    await page.getByRole('button', { name: 'Document actions', exact: true }).click();
    await page.getByRole('button', { name: 'Editing actions', exact: true }).click();
    await page.getByRole('button', { name: 'Insert image…' }).click();
  }
  await open();
  const dialog = page.getByRole('dialog', { name: 'Insert illustration' });
  const draft = dialog.getByRole('button', { name: 'Draft description with AI' });
  await page.evaluate(() => {
    (window as any).imageProbe.failure = true;
  });
  await draft.click();
  await expect(dialog.getByRole('status')).toContainText('Offline');
  await page.evaluate(() => {
    (window as any).imageProbe.failure = false;
  });
  await draft.click();
  await expect(dialog.getByLabel('Image description')).toHaveValue('A river west of the town.');
  await page.evaluate(() => {
    (window as any).documentFixture.view().dispatch({ changes: { from: 0, insert: 'Newer. ' } });
  });
  await dialog.getByRole('button', { name: 'Choose new insertion point' }).click();
  await dialog
    .getByLabel('Select a new position')
    .evaluate((e: HTMLTextAreaElement) => e.setSelectionRange(7, 7));
  await dialog.getByRole('button', { name: 'Use selected position' }).click();
  await dialog.getByRole('button', { name: 'Insert image', exact: true }).click();
  expect(
    await page.evaluate(() => (window as any).documentFixture.view().state.doc.toString())
  ).toContain('Newer. ![A river west of the town.]');
  await open();
  await page.evaluate(() => {
    (window as any).imageProbe.delay = 300;
  });
  await draft.click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).imageProbe.commits)).toBe(1);
});

test('historical illustration shows its proposed relocated link before a restore', async ({ page }) => {
  await page.goto('/tests/browser/document-tabs.html?titled&history');
  await page.waitForFunction(() => document.documentElement.dataset.tabsReady === 'true');
  await page.evaluate(() => {
    const f = (window as any).documentFixture;
    f.fixture.core.sceneVersions = async () => [
      { savedAt: 5, hash: 'image', sourcePath: 'ms/part/old.md' }
    ];
    f.fixture.core.readSceneVersion = async () =>
      'Opening.\r\n![Map](../../assets/images/river.png)\r\nAn unchanged bridge.\nA newer ending.';
  });
  await page.getByRole('button', { name: 'Document actions', exact: true }).click();
  await page.getByRole('button', { name: 'Editing actions', exact: true }).click();
  await page.getByRole('button', { name: 'Scene history…' }).click();
  await page.getByRole('button', { name: 'Restore this passage' }).click();
  const review = page.getByRole('dialog', { name: 'Review insertion' });
  await expect(review.getByLabel('Text to insert')).toHaveValue('![Map](../assets/images/river.png)\n');
  expect(
    await page.evaluate(() => (window as any).documentFixture.view().state.doc.toString())
  ).not.toContain('river.png');
  await review.getByRole('button', { name: 'Confirm insertion' }).click();
  expect(
    await page.evaluate(() => (window as any).documentFixture.view().state.doc.toString())
  ).toContain('![Map](../assets/images/river.png)');
});
