import {test, expect, type Page, type Locator} from '@playwright/test';
const activate = async (target: Locator) => { await target.focus(); await target.page().keyboard.press('Enter'); };
const editor = (page: Page) => page.getByRole('textbox', {name: 'Markdown editor', exact: true});
const state = (page: Page) => page.evaluate(() => (window as any).projectFixture.state());
const content = (s: any) => JSON.stringify({documents: s.documents, manuscripts: s.manuscripts, drafts: s.drafts});
async function openScene(page: Page) {
  await page.goto('/tests/browser/projects.html?movement-demo');
  await page.waitForFunction(() => document.documentElement.dataset.demoReady === 'true');
  if(page.viewportSize()!.width<=1000)await page.getByRole('button',{name:'All sheets'}).click();
  await activate(page.getByRole('button', {name: '2. Arrival', exact: true}));
  await expect(editor(page)).toContainText('Arrival');
  await editor(page).focus();
}
for (const high of [false, true]) test(`project New preserves writing and creates a sheet, contrast=${high}`, async ({page}) => {
  await openScene(page);
  if(high){await page.getByRole('button',{name:'More actions'}).click();await page.getByRole('button',{name:/^Appearance/}).click();await page.getByRole('button',{name:'High contrast'}).click();await page.keyboard.press('Escape');await editor(page).focus();}
  const before=await state(page),original=before.documents['local-a']['ms/arrival.md'];
  for(const chord of ['Control+n','Meta+n']){await page.keyboard.press(chord);const form=page.getByRole('dialog',{name:'New sheet'});await expect(form).toBeVisible();await expect(form.getByLabel('Sheet title')).toBeFocused();await page.keyboard.press(chord);expect(await page.evaluate(()=>{const e=new KeyboardEvent('keydown',{key:'n',ctrlKey:true,repeat:true,bubbles:true,cancelable:true});document.activeElement!.dispatchEvent(e);return e.defaultPrevented;})).toBe(true);await expect(page.getByRole('dialog',{name:'New sheet'})).toHaveCount(1);expect(content(await state(page))).toBe(content(before));await activate(form.getByRole('button',{name:'Cancel'}));await expect(editor(page)).toBeFocused();}
  await page.evaluate(()=>(window as any).projectFixture.setFailSave(true));await page.keyboard.insertText('Kept — ');await page.keyboard.press('Control+n');let form=page.getByRole('dialog',{name:'New sheet'});await activate(form.getByRole('button',{name:'Create sheet'}));await expect(editor(page)).toContainText('Kept — ');expect(content(await state(page))).toBe(content(before));
  await page.evaluate(()=>(window as any).projectFixture.setFailSave(false));await editor(page).focus();await page.keyboard.press('ControlOrMeta+s');await expect.poll(async()=>(await state(page)).documents['local-a']['ms/arrival.md']).toBe('Kept — '+original);await page.keyboard.press('Meta+n');form=page.getByRole('dialog',{name:'New sheet'});await form.getByLabel('Sheet title').fill('Shortcut scene');await activate(form.getByRole('button',{name:'Create sheet'}));await expect.poll(async()=>(await state(page)).manuscripts['local-a'].scenes.length).toBe(before.manuscripts['local-a'].scenes.length+1);const after=await state(page),scene=after.manuscripts['local-a'].scenes.find((s:any)=>s.title==='Shortcut scene');expect(after.documents['local-a'][scene.path]).toBe('');expect(after.documents['local-a']['ms/arrival.md']).toBe('Kept — '+original);expect(await page.evaluate(()=>(window as any).projectFixture.externalCalls)).toEqual([]);
});
test('project without initialized manuscript reveals explicit setup without writing', async ({page}) => {
  await page.goto('/tests/browser/projects.html?library');
  await activate(page.getByRole('button', {name:'Open Novel A', exact:true}));
  const before = await state(page);
  await page.keyboard.press('Control+n');
  await expect(page.getByRole('button', {name:'Set up library', exact:true})).toBeVisible();
  await expect(page.getByText('Set up a library.', {exact:false})).toBeVisible();
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
