import {expect, test} from '@playwright/test';

async function open(page: import('@playwright/test').Page) {
  await page.goto('/tests/browser/document-tabs.html');
  await page.waitForFunction(() => document.documentElement.dataset.tabsReady === 'true');
}

test('@smoke Saved is in the top bar at every width', async ({page}) => {
  await open(page);
  const saved = page.locator('.status-pill > .pill-save');
  await expect(saved).toBeVisible();
  await expect(saved).toHaveText('Saved');
  // The old file path and byte count is no longer announced on every open.
  await expect(page.locator('.status')).not.toContainText(/bytes/);
});

test('a status message neither moves the writing nor blocks a control', async ({page}) => {
  await open(page);
  const prose = () => page.evaluate(() => Math.round(document.querySelector('.cm-line')!.getBoundingClientRect().top));
  const before = await prose();
  for (const error of [false, true]) {
    await page.locator('.status').evaluate((el, error) => {
      el.classList.remove('quiet');
      el.classList.toggle('error', error);
      el.textContent = 'Synthetic status message. '.repeat(12);
    }, error);
    await expect(page.locator('.status')).toBeVisible();
    expect(await prose()).toBe(before);
    // It is inert to the pointer, so it can never block a control it floats over.
    expect(await page.locator('.status').evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
    // It sits at the bottom, clear of the tab and toolbar rows above the writing.
    const box = (await page.locator('.status').boundingBox())!;
    expect(box.y).toBeGreaterThan(page.viewportSize()!.height / 2);
    const tab = page.getByRole('tab').first();
    const point = await tab.evaluate(el => {const r = el.getBoundingClientRect();return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;});
    expect(point).toBe(true);
  }
});
