import {test, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('library renders nested sheets with keyboard focus and labelled controls', async ({page}) => {
  await page.goto('/tests/browser/library.html');
  const group = page.getByRole('button',{name:'Group',exact:true}); await group.focus(); await page.keyboard.press('Enter');
  if ((await page.viewportSize())!.width <= 1000) {
    await expect(page.locator('.sheets-heading')).toBeFocused();
    await expect(page.getByRole('button',{name:'Back to library'})).toBeVisible();
  } else await expect(group).toBeFocused();
  await expect(page.locator('.scene-open')).toHaveText(['1. Second','2. First']);
  await expect(page.getByLabel('Select Second')).toBeVisible();
  const axe = await new AxeBuilder({page}).include('.drafting-panel').analyze(); expect(axe.violations).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth); expect(overflow).toBe(false);
});
