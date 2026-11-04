import {test, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('library renders a nested Group › Scene tree with keyboard focus and labelled controls', async ({page}) => {
  await page.goto('/tests/browser/library.html');
  await expect(page.locator('.scene-open')).toHaveText(['Second','First']);
  await expect(page.locator('.tree-toggle')).toHaveText(['Group','Nested']);
  const group = page.locator('[data-expand-group="g"]'); await group.focus(); await page.keyboard.press('Enter');
  await expect(group).toBeFocused(); await expect(group).toHaveAttribute('aria-expanded','false');
  await expect(page.locator('.scene-open')).toHaveCount(0);
  const axe = await new AxeBuilder({page}).include('.drafting-panel').analyze(); expect(axe.violations).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth); expect(overflow).toBe(false);
});
