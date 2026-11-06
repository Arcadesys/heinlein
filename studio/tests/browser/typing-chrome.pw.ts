import {expect, test, type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const chrome = (page:Page) => page.locator('.typing-chrome');
const writer = (page:Page) => page.locator('.active-document-pane .cm-content');
async function open(page:Page) {
  await page.goto('/tests/browser/document-tabs.html');
  await page.waitForFunction(() => document.documentElement.dataset.tabsReady === 'true');
  await page.evaluate(async () => {await document.fonts.ready;});
}
const sample = (page:Page) => page.evaluate(() => {
  const view=(window as any).documentFixture.view(),pane=document.querySelector('.active-document-pane')!,content=view.contentDOM;
  const caret=view.coordsAtPos(view.state.selection.main.head);
  return {prose:view.coordsAtPos(0)?.top,width:content.getBoundingClientRect().width,height:pane.clientHeight,top:pane.getBoundingClientRect().top,caret:caret?.top,head:view.state.selection.main.head,text:view.state.doc.toString()};
});
async function type(page:Page,text='x') {await writer(page).focus();await page.keyboard.type(text);await expect(chrome(page)).toHaveClass(/is-typing/);await page.waitForTimeout(220);}

test('@smoke typing reclaims vertical space without reflow, losing prose or stealing focus', async ({page},info) => {
  await open(page);
  const initial=await sample(page);
  await page.screenshot({path:info.outputPath('typing-chrome-expanded.png')});
  await type(page,'Written — ');
  const after=await sample(page);
  expect(after.height).toBeGreaterThan(initial.height+25);expect(after.width).toBe(initial.width);
  // The first line of prose stays where the writer last saw it, even at the top of a document.
  expect(Math.abs(after.prose!-initial.prose!)).toBeLessThanOrEqual(1);
  await expect(writer(page)).toBeFocused();await expect(page.locator('.typing-chrome-content')).toHaveAttribute('inert','');
  await expect(page.getByRole('tablist',{name:'Open documents'})).toHaveCount(0);
  await expect(page.locator('.status-pill .pill-save')).toBeVisible();await expect(page.locator('.status-pill')).toBeVisible();
  const restore=page.getByRole('button',{name:'Show tabs and tools'});await expect(restore).toBeVisible();expect((await restore.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('typing-chrome-collapsed.png')});
  for(let n=0;n<3;n++) {
    const state=await sample(page);
    await restore.click();await expect(chrome(page)).not.toHaveClass(/is-typing/);await expect(writer(page)).toBeFocused();
    expect((await sample(page)).text).toBe(state.text);expect((await sample(page)).head).toBe(state.head);
    await type(page,'x');await page.keyboard.press('Escape');await expect(chrome(page)).not.toHaveClass(/is-typing/);await expect(writer(page)).toBeFocused();
    await type(page,'y');
  }
  const axe=await new AxeBuilder({page}).include('.document-workspace').analyze();expect(axe.violations.filter(v=>['serious','critical'].includes(v.impact??''))).toEqual([]);
});

test('keyboard restores controls, Source/Reading and tab navigation never remain hidden', async ({page}) => {
  await open(page);await type(page);
  await page.keyboard.press('Shift+Tab');await expect(chrome(page)).not.toHaveClass(/is-typing/);
  expect(await page.evaluate(()=>!!document.activeElement?.closest('.typing-chrome-content'))).toBe(true);
  await page.getByRole('button',{name:'Reading',exact:true}).first().click();await expect(page.locator('.active-document-pane .markdown-reader')).toBeVisible();
  await page.keyboard.press('ArrowDown');await expect(chrome(page)).not.toHaveClass(/is-typing/);
  await page.getByRole('button',{name:'Source',exact:true}).first().click();await type(page);
  await page.keyboard.press('Escape');await page.keyboard.press('ControlOrMeta+s');await expect(page.locator('.status-pill .pill-save')).toHaveText('Saved');
  const tab=page.getByRole('tab',{name:'Meeting',exact:true});await tab.focus();await page.keyboard.press('Enter');await expect(tab).toHaveAttribute('aria-selected','true');await expect(chrome(page)).not.toHaveClass(/is-typing/);
  await type(page);await page.keyboard.press('Escape');
  await page.getByRole('button',{name:/^Editing actions$/}).click();const dialog=page.getByRole('dialog',{name:'Editor actions',exact:true});await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(chrome(page)).not.toHaveClass(/is-typing/);
  await type(page);await page.evaluate(()=>{(window as any).documentFixture.app.destroy();});expect(await page.locator('.typing-chrome [inert]').count()).toBe(0);
});

test('IME defers motion, search owns Escape, and pasted/programmatic text does not conceal tools', async ({page}) => {
  await open(page);await writer(page).focus();
  await page.evaluate(()=>{const v=(window as any).documentFixture.view();v.dispatch({changes:{from:v.state.selection.main.head,insert:'programmatic '}});});await expect(chrome(page)).not.toHaveClass(/is-typing/);
  await page.evaluate(()=>{const v=(window as any).documentFixture.view();v.dispatch({selection:{anchor:v.state.doc.line(5).from}});v.focus();});
  const ime=await page.context().newCDPSession(page);await ime.send('Input.imeSetComposition',{text:'星',selectionStart:1,selectionEnd:1});await expect(chrome(page)).not.toHaveClass(/is-typing/);
  await writer(page).dispatchEvent('keydown',{key:'Escape',isComposing:true});await expect(chrome(page)).not.toHaveClass(/is-typing/);
  await ime.send('Input.insertText',{text:'星'});await expect(chrome(page)).toHaveClass(/is-typing/);
  await page.keyboard.press('Escape');const committed=(await sample(page)).text;
  await ime.send('Input.imeSetComposition',{text:'取消',selectionStart:2,selectionEnd:2});
  await ime.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});await page.waitForTimeout(200);
  await expect(chrome(page)).not.toHaveClass(/is-typing/);expect((await sample(page)).text).toBe(committed);
  await type(page);
  await page.keyboard.press('ControlOrMeta+f');await expect(page.locator('.cm-search')).toBeVisible();
  await page.locator('.cm-search input[name="search"]').fill('Paragraph');await expect(chrome(page)).toHaveClass(/is-typing/);
  await page.keyboard.press('Escape');await expect(page.locator('.cm-search')).not.toBeVisible();await expect(chrome(page)).toHaveClass(/is-typing/);
  await page.keyboard.press('Escape');await expect(chrome(page)).not.toHaveClass(/is-typing/);
});

test('scrolled passage and reference width remain steady, including reduced motion at 200%', async ({page}) => {
  await open(page);await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(async()=>{document.documentElement.dataset.zoom='200';await document.fonts.ready;});
  await page.evaluate(()=>{const v=(window as any).documentFixture.view();v.dispatch({selection:{anchor:v.state.doc.line(24).from+5},scrollIntoView:true});v.focus();});await page.waitForTimeout(200);
  // Center the full caret, not only its top. At enlarged text sizes the latter
  // can trigger native input scrolling even when no chrome collapse happens.
  await page.evaluate(()=>{const v=(window as any).documentFixture.view(),p=document.querySelector('.active-document-pane')!,caret=v.coordsAtPos(v.state.selection.main.head);p.scrollTop+=(caret.top+caret.bottom)/2-p.getBoundingClientRect().top-p.clientHeight/2;});
  const visibleCaret=async()=>{const bounds=await page.evaluate(()=>{const v=(window as any).documentFixture.view(),pane=document.querySelector('.active-document-pane')!.getBoundingClientRect(),caret=v.coordsAtPos(v.state.selection.main.head);return{top:caret.top,bottom:caret.bottom,paneTop:pane.top,paneBottom:pane.bottom};});expect(bounds.top).toBeGreaterThanOrEqual(bounds.paneTop);expect(bounds.bottom).toBeLessThanOrEqual(bounds.paneBottom);};
  await visibleCaret();
  const before=await sample(page),reference=await page.locator('.reference-pane').boundingBox();
  let after=before;
  for(let cycle=0;cycle<4;cycle++) {
    await type(page);after=await sample(page);
    expect(after.width).toBe(before.width);expect(after.caret).toBeCloseTo(before.caret!,0);expect((await page.locator('.reference-pane').boundingBox())!.width).toBe(reference!.width);await visibleCaret();
    if(cycle<3) {
      await page.keyboard.press('Backspace');await page.keyboard.press('Escape');await expect(chrome(page)).not.toHaveClass(/is-typing/);await page.waitForTimeout(220);
      const restored=await sample(page);expect(restored.text).toBe(before.text);expect(restored.head).toBe(before.head);expect(restored.width).toBe(before.width);expect(restored.caret).toBeCloseTo(before.caret!,0);await visibleCaret();
    }
  }
  expect(await chrome(page).evaluate(el=>getComputedStyle(el).transitionDuration)).toBe('0s');
  await page.locator('.reference-source').focus();await expect(chrome(page)).not.toHaveClass(/is-typing/);
  await page.keyboard.type('no changes');await expect(chrome(page)).not.toHaveClass(/is-typing/);expect((await sample(page)).text).toBe(after.text);
});

test('wrapped tools remain reachable after restore and typing in Questions leaves them visible', async ({page},info) => {
  await open(page);await type(page);await page.keyboard.press('Escape');
  const actions=page.getByRole('button',{name:'Editing actions',exact:true});await actions.focus();
  await expect.poll(()=>actions.evaluate(el=>{const r=el.getBoundingClientRect();return r.height>=48 && el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})).toBe(true);
  await page.screenshot({path:info.outputPath('restored-editing-actions-focus.png')});
  await page.keyboard.press('Enter');const dialog=page.getByRole('dialog',{name:'Editor actions',exact:true});await expect(dialog).toBeVisible();await page.keyboard.press('Escape');await expect(actions).toBeFocused();
  const text=(await sample(page)).text;
  await page.getByRole('button',{name:/^Heinlein(?: ·.*)?$/}).click();
  const question=page.locator('.question-panel textarea').first();await expect(question).toBeVisible();await question.fill('Only a synthetic question, not sent.');
  await expect(chrome(page)).not.toHaveClass(/is-typing/);expect((await sample(page)).text).toBe(text);
  expect(await page.evaluate(()=>(window as any).documentFixture.fixture.externalCalls)).toEqual([]);
});

test('saved split actions restore intact and retain the narrow reference focus rule', async ({page}) => {
  await page.goto('/tests/browser/file-split.html');await page.waitForFunction(()=>document.documentElement.dataset.fileSplitReady==='true');
  await page.evaluate(()=>(window as any).fileSplitFixture.cursor());await page.locator('.cm-content').focus();await page.keyboard.press('Control+Shift+Enter');
  await page.getByRole('dialog',{name:'Split Markdown file at cursor',exact:true}).getByRole('button',{name:'Preview split',exact:true}).click();
  await page.getByRole('dialog',{name:'Review manuscript change',exact:true}).getByRole('button',{name:'Apply change',exact:true}).click();
  const offer=page.locator('.split-reading-offer');await expect(offer).toBeVisible();
  await type(page);await expect(offer).toBeHidden();await page.keyboard.press('Escape');await expect(offer).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');await expect(page.locator('.status-pill .pill-save')).toHaveText('Saved');
  await page.getByRole('button',{name:'Read both sections',exact:true}).click();await page.locator('.reference-source').focus();
  if(page.viewportSize()!.width<=600) await expect(offer).toBeHidden();else await expect(offer).toBeVisible();
  await page.getByRole('button',{name:'Source',exact:true}).first().focus();await expect(offer).toBeVisible();
  await offer.locator('summary').click();await expect(page.getByRole('button',{name:'Read both sections',exact:true})).toBeVisible();
});


test('switching a scrolled hidden writer does not apply its scroll compensation to the next document', async ({page}) => {
  await open(page);
  await page.evaluate(()=>{const v=(window as any).documentFixture.view();v.dispatch({selection:{anchor:v.state.doc.line(24).from+5},scrollIntoView:true});v.focus();});await page.waitForTimeout(200);
  await type(page);await page.keyboard.press('ControlOrMeta+s');await expect(page.locator('.status-pill .pill-save')).toHaveText('Saved');
  expect(await page.locator('.active-document-pane').evaluate(el=>el.scrollTop)).toBeGreaterThan(100);
  await page.evaluate(async()=>{const f=(window as any).documentFixture;await f.app.showDocument(f.paths[1]);});
  await expect(chrome(page)).not.toHaveClass(/is-typing/);await page.waitForTimeout(220);
  expect(await page.locator('.active-document-pane').evaluate(el=>el.scrollTop)).toBe(0);
  await expect(page.getByRole('tab',{name:'Meeting',exact:true})).toHaveAttribute('aria-selected','true');
});


test('the restore target stays above the prose and inside the viewport at every text zoom', async ({page}) => {
  await open(page);
  for(const zoom of [100,200,300]) {
    await page.evaluate(z=>document.documentElement.dataset.zoom=String(z),zoom);await type(page);
    const geometry=await page.evaluate(()=>{const button=document.querySelector('.typing-chrome-reveal')!.getBoundingClientRect(),pane=document.querySelector('.active-document-pane')!.getBoundingClientRect();return{height:button.height,left:button.left,right:button.right,bottom:button.bottom,proseTop:pane.top};});
    expect(geometry.height).toBeGreaterThanOrEqual(48);expect(geometry.left).toBeGreaterThanOrEqual(0);expect(geometry.right).toBeLessThanOrEqual(page.viewportSize()!.width);expect(geometry.bottom).toBeLessThanOrEqual(geometry.proseTop);
    await page.keyboard.press('Escape');await expect(chrome(page)).not.toHaveClass(/is-typing/);
  }
});


test('a caret near the bottom stays visible when a stacked reference gains room', async ({page}) => {
  await open(page);
  await page.evaluate(()=>{const v=(window as any).documentFixture.view();v.dispatch({selection:{anchor:v.state.doc.line(24).from+5},scrollIntoView:true});v.focus();});await page.waitForTimeout(200);
  await page.evaluate(()=>{const v=(window as any).documentFixture.view(),pane=document.querySelector('.active-document-pane')!;pane.scrollTop+=v.coordsAtPos(v.state.selection.main.head).bottom-pane.getBoundingClientRect().bottom+4;});
  const width=(await sample(page)).width;await type(page);
  const geometry=await page.evaluate(()=>{const v=(window as any).documentFixture.view(),pane=document.querySelector('.active-document-pane')!.getBoundingClientRect(),caret=v.coordsAtPos(v.state.selection.main.head);return{top:caret.top,bottom:caret.bottom,paneTop:pane.top,paneBottom:pane.bottom};});
  expect(geometry.top).toBeGreaterThanOrEqual(geometry.paneTop);expect(geometry.bottom).toBeLessThanOrEqual(geometry.paneBottom);expect((await sample(page)).width).toBe(width);await expect(writer(page)).toBeFocused();
});
