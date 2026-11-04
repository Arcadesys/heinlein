import {test, expect, type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const raw = '---\r\ntitle: Synthetic draft\r\n---\r\n# The Salt Ledger\r\n\r\nA *quiet* **harbor** — 🦊.\n\n- Rope\n- Tar\n\n> Nobody signs twice.\n\n[map](https://example.test/map) ![harbor](https://example.test/tracker.png)\n\n<script>alert("never runs")</script>\n\n```js\nconst x = 1;\n```\n';
const editor = (page: Page) => page.locator('.standalone-editor .cm-content');
const reader = (page: Page) => page.getByRole('region', {name: 'Draft reading view', exact: true});
const toggle = (page: Page, name: string) => page.getByRole('group', {name: 'Document view'}).getByRole('button', {name, exact: true});
const saved = (page: Page) => page.evaluate(() => [...(window as any).draftFixture.records.values()][0].text as string);

test('standalone Reading formats safely, preserves source bytes and returns to editing and durable storage', async ({page}, info) => {
  const errors: string[] = [], external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  page.on('request', request => {if (!request.url().startsWith('http://127.0.0.1')) external.push(request.url());});
  await page.addInitScript(text => {
    const key = 'synthetic-standalone-acceptance-v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify([{schemaVersion: 1, id: 'draft-seed', revision: 1, label: null, text, textHash: `synthetic-${text}`, state: 'active', updatedAt: 1, placements: []}]));
  }, raw);
  await page.goto('/tests/browser/standalone.html');
  await expect(page).toHaveTitle('Standalone drafts — synthetic acceptance');
  await expect(editor(page)).toBeFocused();
  if (await page.locator('.navigation-toggle').getAttribute('aria-expanded') === 'true') await page.keyboard.press('ControlOrMeta+\\');
  await expect(toggle(page, 'Source')).toHaveAttribute('aria-pressed', 'true');
  const before = await saved(page);
  await toggle(page, 'Reading').click();
  await expect(reader(page)).toBeVisible();
  await expect(editor(page)).toBeHidden();
  await expect(toggle(page, 'Reading')).toBeFocused();
  await expect(reader(page).getByRole('heading', {name: 'The Salt Ledger'})).toBeVisible();
  await expect(reader(page).locator('em')).toHaveText('quiet');
  await expect(reader(page).locator('strong')).toHaveText('harbor');
  await expect(reader(page).getByRole('listitem')).toHaveCount(2);
  await expect(reader(page).locator('blockquote')).toContainText('Nobody signs twice.');
  await expect(reader(page).locator('pre.md-code code')).toContainText('const x = 1;');
  await expect(reader(page).locator('.md-link')).toHaveText('map (https://example.test/map)');
  await expect(reader(page).locator('.md-image')).toContainText('Image not loaded: harbor');
  await expect(reader(page)).toContainText('<script>alert("never runs")</script>');
  await expect(reader(page)).not.toContainText('title: Synthetic draft');
  expect(await reader(page).locator('script,img,a,iframe,svg').count()).toBe(0);
  expect(await saved(page)).toBe(before);
  expect(await page.evaluate(() => (window as any).draftFixture.calls.map((call: any) => call.kind))).toEqual(['list', 'open']);
  expect((await new AxeBuilder({page}).include('.standalone-page').withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({path: `/tmp/heinlein-markdown-${info.project.name}.png`, fullPage: true});

  await toggle(page, 'Source').click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.insertText('Unsaved **ending**.');
  await toggle(page, 'Reading').click();
  await expect(reader(page).locator('strong').last()).toHaveText('ending');
  await page.getByRole('button', {name: 'Keep on this Mac', exact: true}).click();
  await expect.poll(() => saved(page)).toBe(`${raw}Unsaved **ending**.`);
  await page.reload();
  await expect(editor(page)).toContainText('Unsaved **ending**.');
  await expect(toggle(page, 'Source')).toHaveAttribute('aria-pressed', 'true');
  expect(await saved(page)).toBe(`${raw}Unsaved **ending**.`);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});

test('Reading reflows at 200 percent and keeps keyboard controls and dialog return usable', async ({page}, info) => {
  await page.goto('/tests/browser/standalone.html');
  await expect(editor(page)).toBeFocused();
  await page.keyboard.insertText('# Readable draft\n\nA **clear** paragraph — 🦊.');
  if (await page.locator('.navigation-toggle').getAttribute('aria-expanded') === 'true') await page.keyboard.press('ControlOrMeta+\\');
  for (let i = 0; i < 5; i++) await page.keyboard.press(process.platform === 'darwin' ? 'Meta+=' : 'Control+=');
  await expect(page.locator('html')).toHaveAttribute('data-zoom', '200');
  await toggle(page, 'Reading').focus();
  await page.keyboard.press('Enter');
  await expect(reader(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await reader(page).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  for (const button of await page.getByRole('group', {name: 'Document view'}).getByRole('button').all()) {
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  }
  await page.getByText('Draft actions', {exact: true}).click();
  await page.locator('.standalone-actions').getByRole('button', {name: 'Drafts', exact: true}).click();
  await page.getByRole('button', {name: 'Back to writing', exact: true}).click();
  await expect(reader(page)).toBeFocused();
  await toggle(page, 'Source').focus();
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeFocused();
  await page.keyboard.insertText('More ');
  await toggle(page, 'Reading').click();
  await expect(reader(page)).toContainText('More');
  await reader(page).getByRole('heading').scrollIntoViewIfNeeded();
  await page.screenshot({path: `/tmp/heinlein-markdown-200-${info.project.name}.png`, fullPage: true});
});
