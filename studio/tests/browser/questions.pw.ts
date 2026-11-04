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
const textLayout = (page:Page) => page.locator('.cm-content').evaluate(node => {
  const rect = node.getBoundingClientRect();
  return {left:rect.left,top:rect.top,width:rect.width,lines:[...node.children].map(line=>{const r=line.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};})};
});
async function openPassage(page:Page) {
  await page.goto('/tests/browser/questions.html');await expect(page).toHaveTitle('Passage Questions fixture');await expect(page).toHaveURL(/questions\.html$/);await expect(page.locator('vite-error-overlay')).toHaveCount(0);await expect(page.locator('.cm-content')).toBeVisible();
  await fixture(page,'select');
  const layout = await textLayout(page);
  await page.keyboard.press('Control+j');
  const pane = page.locator('.question-panel');
  await expect(pane).toBeVisible();
  await expect(page.locator('.conversation-rail-dialog')).toHaveJSProperty('open',true);
  await expect.poll(() => textLayout(page)).toEqual(layout);
  // The composer ends with the "What will be sent" disclosure; Copy as prompt… stays in the send row.
  await expect(pane.getByRole('button',{name:'Copy as prompt…',exact:true})).toBeVisible();
  const lastControl = pane.locator('.heinlein-send-note > details > summary');await expect(lastControl).toHaveText('What will be sent');
  await lastControl.focus();await page.keyboard.press('Tab');
  await expect(page.getByRole('button',{name:'Back to threads',exact:true})).toBeFocused();
  return layout;
}
async function sendRevision(page:Page) {
  const pane=page.locator('.question-panel');
  await pane.getByRole('textbox',{name:'Your drafting question'}).fill('Can this sentence feel more immediate?');await pane.getByRole('button',{name:'Suggest edits',exact:true}).click();await expect.poll(async()=>(await state(page)).sent).toBe(1);
}
for (const zoom of [100, 200]) {
  test(`highlighting and clearing a passage keep the manuscript anchored at ${zoom}%`, {tag: '@smoke'}, async({page}, info) => {
    await page.goto('/tests/browser/questions.html');
    await expect(page).toHaveTitle('Passage Questions fixture');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await expect(page.locator('.cm-content')).toBeVisible();
    await page.evaluate(async zoom => {
      await (window as any).questionsFixture.ready;
      document.documentElement.dataset.zoom = String(zoom);
      await document.fonts.ready;
      (window as any).questionsFixture.select('');
    }, zoom);
    const content = page.locator('.cm-content');
    await expect.poll(() => page.locator('.question-passage-chip').count()).toBe(0);
    const geometry = () => content.evaluate(node => {
      const bounds = (element: Element) => {
        const r = element.getBoundingClientRect();
        return {left: r.left, top: r.top, width: r.width, height: r.height};
      };
      return {content: bounds(node), lines: [...node.children].map(bounds)};
    });
    // Allow CodeMirror's initial font/viewport measurements to settle.
    await page.waitForTimeout(200);
    const before = await geometry();
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.keyboard.press('Shift+ArrowRight');
      if (page.viewportSize()!.width > 700) {
        // CodeMirror hides its pointer-only gutters from the accessibility tree;
        // Questions and its shortcut provide the keyboard/screen reader route.
        const chip = page.locator('.question-passage-chip[aria-label="Ask about passage at this passage"]');
        await expect(chip).toBeVisible();
        const box = await chip.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      await expect(content).toBeFocused();
      await expect.poll(geometry).toEqual(before);
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('.question-passage-chip')).toHaveCount(0);
      await expect.poll(geometry).toEqual(before);
    }
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(geometry).toEqual(before);
    expect((await state(page)).source).toBe((await state(page)).original);
    expect((await state(page)).sent).toBe(0);
    expect((await new AxeBuilder({page}).include('.cm-editor').analyze()).violations).toEqual([]);
    await page.screenshot({path: `/tmp/heinlein-highlight-${info.project.name}-${zoom}.png`});
  });
}
test('passage chip survives collapse, background completion, exact diff and guarded apply',{tag:'@smoke'},async({page},info)=>{
  await page.setViewportSize({width:1600,height:1000});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const layout = await openPassage(page);await sendRevision(page);const pane=page.locator('.question-panel');
  await pane.getByRole('button',{name:'Close Heinlein',exact:true}).click();await expect(page.locator('.question-passage-chip[aria-label="Asking… at this passage"]')).toBeVisible();
  await expect.poll(()=>textLayout(page)).toEqual(layout);
  await fixture(page,'finish');await expect(page.locator('.question-passage-chip[aria-label="1 suggestion at this passage"]')).toBeVisible();expect((await state(page)).canceled).toBe(0);
  await expect.poll(()=>textLayout(page)).toEqual(layout);
  const chip = page.locator('.question-passage-chip');
  await expect(chip).toHaveText('');await expect(chip.locator('svg')).toBeVisible();await expect(chip).toHaveAttribute('title','1 suggestion at this passage');
  const target = await chip.boundingBox();expect(target!.width).toBeGreaterThanOrEqual(44);expect(target!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({path:`/tmp/heinlein-revision-sparkle-${info.project.name}.png`});
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.locator('.question-passage-chip[aria-label="1 suggestion at this passage"]').click();
  await expect.poll(() => textLayout(page)).toEqual(layout);
  await expect(pane.locator('.question-diff-chip')).toHaveCount(1);
  await pane.locator('.question-diff-chip summary').focus(); await page.keyboard.press('Enter');
  await expect(pane.locator('.question-diff-chip')).toHaveAttribute('open', '');
  await expect.poll(() => textLayout(page)).toEqual(layout);
  await expect(pane.locator('.question-diff-chip del')).toHaveText('tapped');await expect(pane.locator('.question-diff-chip ins')).toHaveText('drummed against');
  expect((await state(page)).source).toBe((await state(page)).original);
  expect((await new AxeBuilder({page}).include('.question-panel').analyze()).violations).toEqual([]);
  await page.screenshot({path:`/tmp/heinlein-questions-${info.project.name}-wide.png`});
  await pane.getByRole('button',{name:'Review changes…',exact:true}).click();await expect(pane.getByRole('button',{name:'Continue to native confirmation'})).toBeEnabled();
  await expect(page.locator('dialog[open]:not(.conversation-rail-dialog)')).toHaveCount(0);await expect(pane.getByLabel('Original full scene')).toContainText('The station clock');expect((await state(page)).applied).toBe(0);
  await pane.getByRole('button',{name:'Continue to native confirmation'}).click();await expect.poll(async()=>(await state(page)).applied).toBe(1);
  expect((await state(page)).source).toContain('Rain drummed against');expect(errors).toEqual([]);
});
test('narrow and enlarged text retain keyboard access, diff labels and no overflow',async({page},info)=>{
  await openPassage(page);await sendRevision(page);await fixture(page,'finish');const pane=page.locator('.question-panel');await expect(pane.getByRole('button',{name:'Review changes…',exact:true})).toBeVisible();
  await page.setViewportSize({width:1600,height:1000});await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});await expect(page.locator('.conversation-rail-dialog')).toHaveJSProperty('open',true);
  expect(await pane.evaluate(node=>node.getBoundingClientRect().right)).toBeLessThanOrEqual(1600);
  await page.evaluate(()=>{document.documentElement.style.fontSize='100%';});await expect(pane).toHaveAttribute('role','region');await expect(page.locator('.conversation-rail')).toBeVisible();
  for(const width of [1200,700,320]) {
    await page.setViewportSize({width,height:900});await expect(pane).toHaveAttribute('role','region');if(width<=700)await expect(page.locator('.conversation-rail-dialog')).toHaveJSProperty('open',true);
    expect(await pane.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
  }
  for (const zoom of ['200%', '400%']) {await page.evaluate(zoom=>{document.documentElement.style.fontSize=zoom;},zoom); expect(await pane.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);}
  await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});
  const collapse=pane.getByRole('button',{name:'Close Heinlein',exact:true});await collapse.focus();await expect(collapse).toBeFocused();
  const last=pane.locator('.heinlein-send-note > details > summary');await last.focus();await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'Back to threads',exact:true})).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(last).toBeFocused();await collapse.focus();
  const size=await collapse.boundingBox();expect(size!.height).toBeGreaterThanOrEqual(44);
  expect((await new AxeBuilder({page}).include('.question-panel').analyze()).violations).toEqual([]);
  await page.screenshot({path:`/tmp/heinlein-questions-${info.project.name}-narrow.png`});
  await page.keyboard.press('Escape');await expect(pane).toBeHidden();await expect(page.locator('.cm-content')).toBeFocused();
  await page.locator('.navigation-toggle').click();await expect(page.locator('.navigation-modal')).toHaveJSProperty('open',true);await page.getByRole('button',{name:'Return to writing',exact:true}).click();
  await page.keyboard.press('Control+j');await expect(pane).toBeVisible();await expect(pane.locator('.question-diff-chip summary')).toContainText('drummed');
});
test('dismiss records rejection without applying',async({page})=>{
  await openPassage(page);await sendRevision(page);await fixture(page,'finish');const pane=page.locator('.question-panel');await pane.getByRole('button',{name:'Dismiss',exact:true}).click();
  await expect.poll(async()=>(await state(page)).rejected).toBe(1);expect((await state(page)).applied).toBe(0);expect((await state(page)).source).toBe((await state(page)).original);
});

test('editing the manuscript removes stale anchors and disables applying the old suggestion',async({page})=>{
  await page.setViewportSize({width:1600,height:1000});await openPassage(page);await sendRevision(page);await fixture(page,'finish');const pane=page.locator('.question-panel');await expect(pane.getByRole('button',{name:'Review changes…',exact:true})).toBeVisible();
  await pane.getByRole('button',{name:'Close Heinlein',exact:true}).click();await page.keyboard.press('ArrowRight');await page.keyboard.type('!');
  await expect(page.locator('.question-passage-chip[aria-label="1 suggestion at this passage"]')).toHaveCount(0);
  await page.locator('.editor-toolbar button[aria-controls="drafting-questions"]').click();await pane.locator('.question-passage-picker > summary').click();
  await expect(pane.getByRole('button',{name:/Passage 1 · Source changed/})).toBeVisible();await expect(pane.getByRole('button',{name:'Review changes…',exact:true})).toBeDisabled();expect((await state(page)).sent).toBe(1);expect((await state(page)).applied).toBe(0);
});
