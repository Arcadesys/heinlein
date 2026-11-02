import {test,expect, type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const runtimeErrors = new WeakMap<Page, string[]>(); const outbound = new WeakMap<Page, string[]>();
test.beforeEach(async({page})=>{
  const errors:string[]=[],remote:string[]=[];runtimeErrors.set(page,errors);outbound.set(page,remote);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{if(new URL(route.request().url()).hostname!=='127.0.0.1'){remote.push(route.request().url());return route.abort();}return route.continue();});
});
test.afterEach(async({page})=>{expect(runtimeErrors.get(page)).toEqual([]);expect(outbound.get(page)).toEqual([]);});
const fixture = (page:Page, action:'select'|'finish') => page.evaluate(action=>{const f=(window as unknown as {questionsFixture:Record<string,()=>unknown>}).questionsFixture;return f[action]();},action);
const state = (page:Page) => page.evaluate(()=>(window as unknown as {questionsFixture:{state():{source:string;original:string;applied:number;canceled:number;rejected:number;sent:number;reviewed:number}}}).questionsFixture.state());
async function openPassage(page:Page) {
  await page.goto('/tests/browser/questions.html');await expect(page).toHaveTitle('Passage Questions fixture');await expect(page).toHaveURL(/questions\.html$/);await expect(page.locator('vite-error-overlay')).toHaveCount(0);await expect(page.locator('.cm-content')).toBeVisible();
  await fixture(page,'select');
  await page.keyboard.press('Control+j');
  await expect(page.locator('.question-panel')).toBeVisible();
}
async function sendRevision(page:Page) {
  const pane=page.locator('.question-panel');await pane.getByRole('combobox',{name:'Response mode'}).selectOption('revision');
  await pane.getByRole('textbox',{name:'Your drafting question'}).fill('Can this sentence feel more immediate?');await pane.getByRole('button',{name:'Send to OpenAI',exact:true}).click();await expect.poll(async()=>(await state(page)).sent).toBe(1);
}
test('passage chip survives collapse, background completion, exact diff and guarded apply',async({page},info)=>{
  await page.setViewportSize({width:1600,height:1000});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await openPassage(page);await sendRevision(page);const pane=page.locator('.question-panel');
  await pane.getByRole('button',{name:'Collapse',exact:true}).click();await expect(page.locator('.question-passage-chip').filter({hasText:'Asking…'})).toBeVisible();
  await fixture(page,'finish');await expect(page.locator('.question-passage-chip').filter({hasText:'1 suggestion'})).toBeVisible();expect((await state(page)).canceled).toBe(0);
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.locator('.question-passage-chip').filter({hasText:'1 suggestion'}).click();
  const chipBounds=await page.locator('.question-passage-chip').filter({hasText:'1 suggestion'}).boundingBox();const paneBounds=await pane.boundingBox();expect(chipBounds!.x+chipBounds!.width).toBeLessThanOrEqual(paneBounds!.x);
  await expect(pane.getByLabel('Original passage',{exact:true})).toHaveText('Rain tapped the glass roof.');await expect(pane.getByLabel('Suggested passage',{exact:true})).toHaveText('Rain drummed against the glass roof.');
  await expect(pane.locator('.question-diff-remove')).toHaveText('tapped');await expect(pane.locator('.question-diff-add')).toHaveText('drummed against');
  expect((await state(page)).source).toBe((await state(page)).original);
  expect((await new AxeBuilder({page}).include('.question-panel').analyze()).violations).toEqual([]);
  await page.screenshot({path:`/tmp/heinlein-questions-${info.project.name}-wide.png`});
  await pane.getByRole('button',{name:'Apply…',exact:true}).click();await expect(pane.getByRole('button',{name:'Continue to native confirmation'})).toBeEnabled();
  await expect(page.locator('dialog[open]')).toHaveCount(0);await expect(pane.getByLabel('Original full scene')).toContainText('The station clock');expect((await state(page)).applied).toBe(0);
  await pane.getByRole('button',{name:'Continue to native confirmation'}).click();await expect.poll(async()=>(await state(page)).applied).toBe(1);
  expect((await state(page)).source).toContain('Rain drummed against');expect(errors).toEqual([]);
});
test('narrow and enlarged text retain keyboard access, diff labels and no overflow',async({page},info)=>{
  await openPassage(page);await sendRevision(page);await fixture(page,'finish');const pane=page.locator('.question-panel');await expect(pane.getByRole('button',{name:'Apply…',exact:true})).toBeVisible();
  await page.setViewportSize({width:1600,height:1000});await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});await expect(pane).toHaveAttribute('aria-modal','true');
  expect(await pane.evaluate(node=>node.getBoundingClientRect().left)).toBe(0);
  await page.evaluate(()=>{document.documentElement.style.fontSize='100%';});await expect(pane).toHaveAttribute('role','complementary');
  for(const width of [1200,700,320]) {
    await page.setViewportSize({width,height:900});await expect(pane).toHaveAttribute('role','dialog');
    expect(await pane.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
  }
  for (const zoom of ['200%', '400%']) {await page.evaluate(zoom=>{document.documentElement.style.fontSize=zoom;},zoom); expect(await pane.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);}
  await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});
  const collapse=pane.getByRole('button',{name:'Collapse',exact:true});await collapse.focus();await expect(collapse).toBeFocused();
  const last=pane.locator('.question-settings > summary');await last.focus();await page.keyboard.press('Tab');await expect(collapse).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(last).toBeFocused();await collapse.focus();
  const size=await collapse.boundingBox();expect(size!.height).toBeGreaterThanOrEqual(44);
  expect((await new AxeBuilder({page}).include('.question-panel').analyze()).violations).toEqual([]);
  await page.screenshot({path:`/tmp/heinlein-questions-${info.project.name}-narrow.png`});
  await page.keyboard.press('Escape');await expect(pane).toBeHidden();await expect(page.locator('.cm-content')).toBeFocused();
  await page.keyboard.press('Control+j');await expect(pane).toBeVisible();await expect(pane.getByLabel('Suggested passage',{exact:true})).toContainText('drummed');
});
test('dismiss records rejection without applying',async({page})=>{
  await openPassage(page);await sendRevision(page);await fixture(page,'finish');const pane=page.locator('.question-panel');await pane.getByRole('button',{name:'Dismiss',exact:true}).click();
  await expect.poll(async()=>(await state(page)).rejected).toBe(1);expect((await state(page)).applied).toBe(0);expect((await state(page)).source).toBe((await state(page)).original);
});

test('editing the manuscript removes stale anchors and disables applying the old suggestion',async({page})=>{
  await page.setViewportSize({width:1600,height:1000});await openPassage(page);await sendRevision(page);await fixture(page,'finish');const pane=page.locator('.question-panel');await expect(pane.getByRole('button',{name:'Apply…',exact:true})).toBeVisible();
  await pane.getByRole('button',{name:'Collapse',exact:true}).click();await page.keyboard.press('ArrowRight');await page.keyboard.type('!');
  await expect(page.locator('.question-passage-chip').filter({hasText:'1 suggestion'})).toHaveCount(0);
  await page.locator('.editor-toolbar button[aria-controls="drafting-questions"]').click();await pane.locator('.question-passage-picker > summary').click();
  await expect(pane.getByRole('button',{name:/Passage 1 · Source changed/})).toBeVisible();await expect(pane.getByRole('button',{name:'Apply…',exact:true})).toBeDisabled();expect((await state(page)).sent).toBe(1);expect((await state(page)).applied).toBe(0);
});
