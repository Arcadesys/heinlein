import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const panel=(page:Page)=>page.getByRole('dialog',{name:'Word counts',exact:true});
const entry=(page:Page)=>page.locator('.status-pill > .word-count-entry');
const writer=(page:Page)=>page.locator('.active-document-pane .cm-content');
async function start(page:Page){await page.goto('/tests/browser/word-counts.html');await page.waitForFunction(()=>document.documentElement.dataset.wordCountsReady==='true');await page.evaluate(async()=>{await document.fonts.ready;});}
const sample=(page:Page)=>page.evaluate(()=>{const f=(window as any).wordCountFixture,v=f.view();return{text:v.state.doc.toString(),selection:v.state.selection.toJSON(),width:v.contentDOM.getBoundingClientRect().width,save:f.calls.save};});

test('@smoke scene, nested group and manuscript counts are readable without saving or changing the editor',async({page},info)=>{
 await start(page);await writer(page).focus();const before=await sample(page);await entry(page).click();
 await expect(panel(page)).toBeVisible();await expect(panel(page).locator('dd').nth(1)).toHaveText('9 words');await expect(panel(page).getByRole('combobox')).toHaveValue('target');await expect(panel(page).locator('li:not([hidden])')).toHaveCount(2);await expect(panel(page).locator('[aria-current=true]')).toContainText('Current scene');
 await panel(page).getByRole('combobox').selectOption('nested');await expect(panel(page).locator('.word-count-group-total')).toHaveText('Group: Parent group / Draft group / Nested group · 4 words');await expect(panel(page).locator('li:not([hidden])')).toHaveCount(1);
 await panel(page).getByRole('combobox').selectOption('empty');await expect(panel(page).locator('.word-count-group-total')).toContainText('0 words');await expect(panel(page)).toContainText('No manuscript scenes in this group.');
 await panel(page).getByRole('combobox').selectOption('');await expect(panel(page).locator('.word-count-group-total')).toHaveText('All manuscript scenes · 9 words');await panel(page).getByRole('button',{name:'Recount saved scenes'}).click();await expect(panel(page).locator('dd').nth(1)).toHaveText('9 words');
 const axe=await new AxeBuilder({page}).include('.word-count-dialog').analyze();expect(axe.violations).toEqual([]);await page.screenshot({path:info.outputPath('word-counts.png')});
 await panel(page).getByRole('button',{name:'Close word counts'}).click();await expect(writer(page)).toBeFocused();expect(await sample(page)).toEqual(before);
 await entry(page).focus();await page.keyboard.press('Enter');await expect(panel(page)).toBeVisible();await page.keyboard.press('Escape');await expect(entry(page)).toBeFocused();expect(await sample(page)).toEqual(before);
});

test('the word-count entry stays available while typing tools collapse and returns to the same caret',async({page})=>{
 await start(page);await writer(page).focus();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.type(' more words');await expect(page.locator('.typing-chrome')).toHaveClass(/is-typing/);await page.waitForTimeout(220);
 await expect(entry(page)).toBeVisible();const entryGeometry=await entry(page).evaluate(node=>{const r=node.getBoundingClientRect();return {height:r.height,left:r.left,right:r.right,width:innerWidth,opacity:getComputedStyle(node).opacity,hit:node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};});expect(entryGeometry).toMatchObject({opacity:'1',hit:true});expect(entryGeometry.height).toBeGreaterThanOrEqual(48);expect(entryGeometry.left).toBeGreaterThanOrEqual(0);expect(entryGeometry.right).toBeLessThanOrEqual(entryGeometry.width);
 const before=await sample(page);const expected=await page.evaluate(()=>{const f=(window as any).wordCountFixture;return f.wordCount(f.view().state.doc.toString())+f.wordCount(f.files.get('ms/second.md'));});await entry(page).click();await expect(panel(page).locator('dd').nth(1)).toHaveText(`${expected} words`);await expect(panel(page)).toContainText('unsaved text');await page.keyboard.press('Escape');await expect(writer(page)).toBeFocused();const after=await sample(page);expect(after.text).toBe(before.text);expect(after.selection).toEqual(before.selection);expect(after.width).toBe(before.width);
 await page.keyboard.type(' another');await expect(page.locator('.typing-chrome')).toHaveClass(/is-typing/);
});

for(const zoom of [100,200,300])test(`high contrast word counts work at ${zoom}% without horizontal overflow`,async({page},info)=>{
 await page.addInitScript(zoom=>localStorage.setItem('heinlein-studio-zoom-v1',String(zoom)),zoom);await start(page);await page.evaluate(()=>(window as any).wordCountFixture.theme());await entry(page).click();
 await expect(panel(page)).toBeVisible();await expect(panel(page).locator('dd').nth(1)).toHaveText('9 words');
 for(const control of [panel(page).getByRole('button',{name:'Close word counts'}),panel(page).getByRole('combobox'),panel(page).getByRole('button',{name:'Recount saved scenes'})]){await control.focus();await control.scrollIntoViewIfNeeded();const geometry=await control.evaluate(node=>{const r=node.getBoundingClientRect();return {label:node.textContent,height:r.height,left:r.left,right:r.right,width:innerWidth,outline:getComputedStyle(node).outlineStyle,hit:node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};});expect(geometry,JSON.stringify(geometry)).toMatchObject({hit:true});expect(geometry.left,JSON.stringify(geometry)).toBeGreaterThanOrEqual(0);expect(geometry.right,JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.width+1);expect(geometry.height).toBeGreaterThanOrEqual(48);expect(geometry.outline).not.toBe('none');}
 expect(await panel(page).evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath(`word-counts-contrast-${zoom}.png`)});await page.keyboard.press('Escape');await expect(panel(page)).not.toBeVisible();
});


test('a delayed recount survives repeated close/reopen without losing scrolled editor or select focus',async({page},info)=>{
 await start(page);await page.evaluate(async()=>{const f=(window as any).wordCountFixture;f.files.set('ms/first.md',Array.from({length:240},(_,i)=>`Synthetic paragraph ${i}: foxes carry notebooks along the river. This is only a test.\n`).join('\n'));await f.app.showDocument('ms/first.md');const v=f.view();(window as any).countOriginalView=v;v.dispatch({selection:{anchor:v.state.doc.line(241).from+8},scrollIntoView:true});v.focus();});await page.waitForTimeout(200);
 const geometry=()=>page.evaluate(()=>{const f=(window as any).wordCountFixture,v=f.view(),pane=document.querySelector('.active-document-pane')!;return{text:v.state.doc.toString(),selection:v.state.selection.toJSON(),width:v.contentDOM.getBoundingClientRect().width,scroll:pane.scrollTop,same:v===(window as any).countOriginalView};});const before=await geometry();expect(before.scroll).toBeGreaterThan(500);
 await page.evaluate(()=>{const f=(window as any).wordCountFixture,read=f.core.readDocument;let held=false;f.core.readDocument=async(...args:any[])=>{if(!held&&args[1]==='ms/second.md'){held=true;return new Promise(resolve=>{f.releaseCount=async()=>resolve(await read(...args));});}return read(...args);};});
 await entry(page).click();await panel(page).getByRole('button',{name:'Recount saved scenes'}).click();await page.waitForFunction(()=>!!(window as any).wordCountFixture.releaseCount);
 for(let i=0;i<4;i++){await panel(page).getByRole('button',{name:'Close word counts'}).click();await expect(writer(page)).toBeFocused();await entry(page).click();await expect(panel(page)).toHaveCount(1);}
 const select=panel(page).getByRole('combobox');await select.selectOption('nested');await select.focus();await page.evaluate(()=>(window as any).wordCountFixture.releaseCount());await expect(panel(page).locator('.word-count-group-total')).toContainText('4 words');await expect(select).toBeFocused();await expect(select).toHaveValue('nested');await page.screenshot({path:info.outputPath('delayed-recount-focus.png')});
 await page.keyboard.press('Escape');await expect(writer(page)).toBeFocused();expect(await geometry()).toEqual(before);expect(await page.evaluate(()=>(window as any).wordCountFixture.calls.save)).toBe(0);
});

test('a source file without an initialized manuscript has no misleading group selector',async({page})=>{
 await page.goto('/tests/browser/word-counts.html?no-manuscript');await page.waitForFunction(()=>document.documentElement.dataset.wordCountsReady==='true');await entry(page).click();await expect(panel(page)).toContainText('No manuscript selected');await expect(panel(page).getByRole('combobox')).toHaveCount(0);await expect(panel(page).getByRole('button',{name:'Recount saved scenes'})).toHaveCount(0);await expect(panel(page).locator('dd').first()).toHaveText('5 words');
});
