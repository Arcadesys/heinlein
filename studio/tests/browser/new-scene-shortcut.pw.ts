import {test, expect, type Page, type Locator} from '@playwright/test';
const activate = async (target: Locator) => { await target.focus(); await target.page().keyboard.press('Enter'); };
const editor = (page: Page) => page.getByRole('textbox', {name: 'Markdown editor', exact: true});
const state = (page: Page) => page.evaluate(() => (window as any).projectFixture.state());
const content = (s: any) => JSON.stringify({documents: s.documents, manuscripts: s.manuscripts, drafts: s.drafts});
async function openScene(page: Page) {
  await page.goto('/tests/browser/projects.html?movement-demo');
  await page.waitForFunction(() => document.documentElement.dataset.demoReady === 'true');
  await activate(page.getByRole('button', {name: '2. Arrival', exact: true}));
  await expect(editor(page)).toContainText('Arrival');
  await editor(page).focus();
}
for (const high of [false, true]) test(`project New stays in context through guards and approval, contrast=${high}`, async ({page}, info) => {
  await openScene(page);
  if (high) {
    await activate(page.getByRole('button', {name: /^Appearance/}));
    await activate(page.getByRole('button', {name: 'High contrast', exact: true}));
    await page.keyboard.press('Escape');
  }
  for (let i = 0; i < 8 && await page.locator('html').getAttribute('data-zoom') !== '200'; i++) await page.keyboard.press('Control+=');
  await editor(page).focus();
  const before = await state(page), original = before.documents['local-a']['ms/arrival.md'];
  const requests = await page.evaluate(() => (window as any).projectFixture.requests.filter((r: any) => r.action === 'activate').length);
  for (const chord of ['Control+n', 'Meta+n']) {
    await page.keyboard.press(chord);
    const form = page.getByRole('dialog', {name: 'Add scene', exact: true});
    await expect(form).toBeVisible();
    await expect(form.getByLabel('Scene title', {exact: true})).toBeFocused();
    await expect(form.getByRole('combobox', {name: 'Chapter (optional)', exact: true})).toHaveValue('group-opening');
    await page.keyboard.press(chord);
    expect(await page.evaluate(() => {const e = new KeyboardEvent('keydown', {key:'n', ctrlKey:true, repeat:true, bubbles:true, cancelable:true});document.activeElement!.dispatchEvent(e);return e.defaultPrevented;})).toBe(true);
    await expect(page.getByRole('dialog', {name: 'Add scene', exact: true})).toHaveCount(1);
    await expect(form.getByLabel('Scene title', {exact: true})).toBeFocused();
    expect(content(await state(page))).toBe(content(before));
    const box = await form.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await form.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect((await form.getByRole('button', {name:'Cancel', exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({path: info.outputPath(`add-scene-${chord.startsWith('Meta') ? 'cmd' : 'ctrl'}.png`)});
    await activate(form.getByRole('button', {name:'Cancel', exact:true}));
    await expect(editor(page)).toBeFocused();
    expect(content(await state(page))).toBe(content(before));
  }
  // Opening the form has no save/create authority. A refused guarded preview
  // keeps dirty writing and source files in this project.
  await page.evaluate(() => (window as any).projectFixture.setFailSave(true));
  await page.keyboard.insertText('Kept — ');
  await page.keyboard.press('Control+n');
  let form = page.getByRole('dialog', {name: 'Add scene', exact: true});
  await activate(form.getByRole('button', {name:'Preview new scene', exact:true}));
  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toContainText('Kept — ');
  await expect(page.getByRole('dialog', {name:'Review manuscript change'})).toHaveCount(0);
  expect(content(await state(page))).toBe(content(before));
  await page.evaluate(() => (window as any).projectFixture.setFailSave(false));
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(async () => (await state(page)).documents['local-a']['ms/arrival.md']).toBe('Kept — ' + original);
  await page.keyboard.press('Meta+n');
  form = page.getByRole('dialog', {name:'Add scene', exact:true});
  await form.getByLabel('Scene title', {exact:true}).focus();
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('Shortcut scene');
  await activate(form.getByRole('button', {name:'Preview new scene', exact:true}));
  let review = page.getByRole('dialog', {name:'Review manuscript change', exact:true});
  await expect(review).toBeVisible();
  expect((await state(page)).manuscripts['local-a'].scenes).toHaveLength(before.manuscripts['local-a'].scenes.length);
  await activate(review.getByRole('button', {name:'Cancel', exact:true}));
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press('Control+n');
  form = page.getByRole('dialog', {name:'Add scene', exact:true});
  await form.getByLabel('Scene title', {exact:true}).focus();
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('Shortcut scene');
  await activate(form.getByRole('button', {name:'Preview new scene', exact:true}));
  review = page.getByRole('dialog', {name:'Review manuscript change', exact:true});
  await activate(review.getByRole('button', {name:'Apply change', exact:true}));
  await expect(editor(page)).toBeFocused(); await expect(editor(page)).toHaveText('');
  const after = await state(page), scene = after.manuscripts['local-a'].scenes.find((s:any) => s.title === 'Shortcut scene');
  expect(scene.groupId).toBe('group-opening'); expect(after.documents['local-a'][scene.path]).toBe('');
  expect(after.manuscripts['local-a'].scenes).toHaveLength(before.manuscripts['local-a'].scenes.length + 1);
  expect(after.documents['local-a']['ms/arrival.md']).toBe('Kept — ' + original);
  expect(after.drafts).toEqual(before.drafts);
  await expect(page.locator('.project-switcher')).toContainText('Novel A');
  await expect(page.locator('.standalone-page')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).projectFixture.requests.filter((r:any) => r.action === 'activate').length)).toBe(requests);
  expect(await page.evaluate(() => (window as any).projectFixture.externalCalls)).toEqual([]);
});
test('project without initialized manuscript reveals explicit setup without writing', async ({page}) => {
  await page.goto('/tests/browser/projects.html?library');
  await activate(page.getByRole('button', {name:'Open Novel A', exact:true}));
  const before = await state(page);
  await page.keyboard.press('Control+n');
  await expect(page.getByRole('button', {name:'Create ms manuscript', exact:true})).toBeVisible();
  await expect(page.getByText('Create a manuscript before adding chapters or scenes.', {exact:true})).toBeVisible();
  await expect(page.getByRole('button', {name:'Add scene', exact:true})).toBeDisabled();
  await expect(page.getByRole('dialog', {name:'Add scene', exact:true})).toHaveCount(0);
  expect(content(await state(page))).toBe(content(before));
  expect(await page.evaluate(() => (window as any).projectFixture.draftingCalls)).toEqual([]);
  await expect(page.locator('.standalone-page')).toHaveCount(0);
});
test('standalone Ctrl/Cmd+N still keeps writing and opens a focused blank draft', async ({page}) => {
  await page.goto('/tests/browser/projects.html');
  await expect(editor(page)).toBeFocused();
  await page.keyboard.insertText('Standalone kept — text');
  await page.keyboard.press('Control+n');
  await expect(editor(page)).toHaveText(''); await expect(editor(page)).toBeFocused();
  await page.keyboard.insertText('Second standalone'); await page.keyboard.press('Meta+n');
  await expect(editor(page)).toHaveText(''); await expect(editor(page)).toBeFocused();
  const s = await state(page);
  expect(s.drafts.map((d:any) => d.text)).toEqual(['Standalone kept — text', 'Second standalone']);
  expect(await page.evaluate(() => (window as any).projectFixture.externalCalls)).toEqual([]);
});
