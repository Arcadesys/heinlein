import {test, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('Markdown answers retain semantic formatting, focus and enlarged narrow reflow', async ({page}) => {
  await page.goto('/tests/browser/markdown.html');
  await page.getByRole('textbox', {name: 'Your drafting question'}).fill('Give advice.');
  await page.getByRole('button', {name: 'Send to OpenAI', exact: true}).click();
  const answer = page.getByRole('region', {name: 'Answer 1', exact: true});
  await expect(answer.getByRole('heading', {name: 'Reading advice'})).toBeVisible();
  await expect(answer.locator('strong')).toHaveText('Keep the voice');
  await expect(answer.getByRole('listitem')).toHaveCount(2);
  await expect(answer.getByRole('table')).toBeVisible();
  await answer.focus(); await expect(answer).toBeFocused();
  await page.keyboard.press('Tab'); await expect(answer.getByRole('link')).toBeFocused();
  await expect(answer.getByRole('link')).toHaveCSS('text-decoration-line', 'underline');
  await expect(answer.getByRole('link')).toHaveCSS('outline-style', 'solid');
  await expect(answer.getByRole('link')).toHaveCSS('outline-width', '3px');
  await page.evaluate(() => {document.documentElement.style.fontSize = '200%';});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await answer.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  const scan = await new AxeBuilder({page}).include('.rendered-markdown').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(scan.violations).toEqual([]);
});
