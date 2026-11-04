import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const shape=(page:Page)=>page.locator('.cm-content').evaluate(node=>({width:node.getBoundingClientRect().width,lines:[...node.children].map(line=>({width:line.getBoundingClientRect().width,height:line.getBoundingClientRect().height}))}));
const showNav=async(page:Page)=>{const toggle=page.locator('.navigation-toggle');if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();};
const showChats=async(page:Page)=>{const nav=page.locator('.navigation-modal[open]');if(await nav.count())await nav.getByRole('button',{name:'Return to writing'}).click();await page.getByRole('button',{name:'Chats',exact:true}).click();};
for(const zoom of [100,200])test(`right rail aggregates chapter threads and keeps scene navigation separate at ${zoom}%`,async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto('/tests/browser/threads.html');await expect(page).toHaveTitle('Section threads fixture');await expect(page).toHaveURL(/threads\.html$/);
 await page.evaluate(async zoom=>{await (window as any).threadsFixture.ready;document.documentElement.dataset.zoom=String(zoom);await document.fonts.ready;},zoom);
 await showNav(page);expect(await page.locator('.nav-panel .thread-sidebar').count()).toBe(0);await showChats(page);const sidebar=page.getByRole('region',{name:'Section threads'});
 await expect(sidebar.getByRole('button',{name:/^Rain motivation/})).toBeVisible();await expect(sidebar.getByRole('button',{name:/^Harbor pacing/})).toHaveCount(0);
 await page.getByRole('button',{name:'Close chats',exact:true}).click();await showNav(page);await page.getByRole('button',{name:'Chapter 9',exact:true}).click();await expect(page.locator('.assembled-editor .cm-content')).toBeVisible();const before=await shape(page);
 await showChats(page);await expect(sidebar).toContainText('Chapter 9');await expect(sidebar.getByRole('button',{name:/^Rain motivation/})).toBeVisible();await expect(sidebar.getByRole('button',{name:/^Harbor pacing/})).toBeVisible();await expect(sidebar.getByRole('button',{name:/^Chapter transition review/})).toBeVisible();await expect(sidebar).not.toContainText('Other chapter topic');
 const resolve=sidebar.getByRole('button',{name:'Resolve thread: Rain motivation',exact:true});await resolve.focus();await page.keyboard.press('Enter');await expect(sidebar.getByRole('button',{name:/^Rain motivation/})).toHaveCount(0);
 await sidebar.getByRole('checkbox',{name:'Show resolved threads'}).check();await expect(sidebar.getByRole('button',{name:'Reopen thread: Rain motivation'})).toBeVisible();await sidebar.getByRole('button',{name:'Reopen thread: Rain motivation'}).click();await sidebar.getByRole('checkbox',{name:'Show resolved threads'}).uncheck();
 expect(await shape(page)).toEqual(before);expect((await new AxeBuilder({page}).include('.conversation-rail').analyze()).violations).toEqual([]);expect(await sidebar.evaluate(n=>n.scrollWidth<=n.clientWidth)).toBe(true);
 await page.screenshot({path:`/tmp/heinlein-right-rail-${info.project.name}-${zoom}.png`});
 await sidebar.getByRole('button',{name:/^Harbor pacing/}).click();const pane=page.locator('.question-panel');await expect(pane).toContainText('Saved answer about Harbor pacing.');await expect(pane).not.toContainText('Saved answer about Rain motivation.');expect(await shape(page)).toEqual(before);
 await page.getByRole('button',{name:'Back to threads',exact:true}).click();await expect(sidebar).toContainText('Chapter 9');await page.reload();await page.evaluate(()=>(window as any).threadsFixture.ready);await showNav(page);await page.getByRole('button',{name:'Chapter 9',exact:true}).click();await expect(page.locator('.assembled-editor .cm-content')).toBeVisible();await showChats(page);await expect(sidebar.getByRole('button',{name:/^Harbor pacing/})).toBeVisible();await sidebar.getByRole('button',{name:/^Chapter transition review/}).click();await expect(page.locator('.heinlein-review-panel')).toContainText('The chapter balances rain and harbor imagery.');
 const state=await page.evaluate(()=>(window as any).threadsFixture.source());expect(state.saves).toBe(0);expect(state.requests).toEqual([]);expect(errors).toEqual([]);await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});
test('chapter selection joins source sheets for conversation context',async({page})=>{
 await page.goto('/tests/browser/threads.html?empty=1');await page.evaluate(()=>(window as any).threadsFixture.ready);await showNav(page);await page.getByRole('button',{name:'Chapter 9',exact:true}).click();await expect(page.locator('.assembled-editor .cm-content')).toBeVisible();const manuscript=await page.locator('.cm-content').innerText();await showChats(page);
 const sidebar=page.getByRole('region',{name:'Section threads'});await sidebar.getByRole('button',{name:'New conversation',exact:true}).click();const pane=page.locator('.question-panel');await expect(pane.locator('.question-thread-scope')).toContainText('Chapter 9');await expect(pane).toContainText('whole chapter');
 await pane.getByRole('textbox',{name:'Your drafting question'}).fill('How does this chapter read?');await pane.getByRole('button',{name:'Ask',exact:true}).click();await expect(pane).toContainText('Synthetic new answer.');
 const state=await page.evaluate(()=>(window as any).threadsFixture.source());expect(state.requests).toHaveLength(1);expect(state.requests[0].history).toEqual([]);expect(state.requests[0].context).toContain('\n\n---\n\n');expect(state.requests[0].context).not.toContain('title: Harbor');expect(state.requests[0].context).toContain('Harbor 🦊—view.');expect(manuscript).toContain('Harbor');expect(state.saves).toBe(0);
 expect((await new AxeBuilder({page}).include('.conversation-rail').analyze()).violations).toEqual([]);
});
test('chapter edits save back to their sheets and reopen with exact frontmatter and line endings',async({page},info)=>{
 await page.goto('/tests/browser/threads.html');await page.evaluate(()=>(window as any).threadsFixture.ready);await showNav(page);await page.getByRole('button',{name:'Chapter 9',exact:true}).click();const content=page.locator('.assembled-editor .cm-content');await expect(content).toBeVisible();await expect(content).toContainText('---');await expect(content).not.toContainText('title: Harbor');
 await page.evaluate(()=>(window as any).threadsFixture.selectText('Harbor'));await page.keyboard.type('Port');await page.evaluate(()=>(window as any).threadsFixture.selectText('Mara'));await page.keyboard.type('Marlo');await page.keyboard.press(await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform)?'Meta+s':'Control+s'));await expect(page.locator('.status')).toContainText('Chapter saved to its source sheets');
 const state=await page.evaluate(()=>(window as any).threadsFixture.source());expect(state.disk['ms/b.md']).toBe('---\r\ntitle: Harbor\r\n---\r\nPort 🦊—view.\r\nMixed newline.\n');expect(state.disk['ms/a.md']).toBe(state.original.replace('Mara','Marlo'));expect(Object.keys(state.disk)).not.toContain('__chapter__/nine.md');expect(Object.keys(state.drafts)).toHaveLength(0);
 const before=await content.innerText();await page.evaluate(()=>(window as any).threadsFixture.tryBoundary());expect(await content.innerText()).toBe(before);await expect(page.locator('.status')).toContainText('breaks separate source sheets');
 expect((await new AxeBuilder({page}).include('.assembled-toolbar').include('.assembled-editor').analyze()).violations).toEqual([]);await page.screenshot({path:`/tmp/heinlein-editable-chapter-${info.project.name}.png`});
 await page.reload();await page.evaluate(()=>(window as any).threadsFixture.ready);await showNav(page);await page.getByRole('button',{name:'Chapter 9',exact:true}).click();await expect(content).toContainText('Port');await expect(content).toContainText('Marlo');
});
test('a sheet recovery draft prevents chapter editing until the writer resolves it',async({page})=>{
 await page.goto('/tests/browser/threads.html?recovery=1');await page.evaluate(()=>(window as any).threadsFixture.ready);await showNav(page);await page.getByRole('button',{name:'Chapter 9',exact:true}).click();await expect(page.locator('.assembled-editor .cm-content')).toHaveAttribute('contenteditable','false');await expect(page.getByRole('button',{name:/A saved recovery draft needs your decision/})).toBeVisible();expect((await page.evaluate(()=>(window as any).threadsFixture.source())).saves).toBe(0);
});

test('wide screens dock chats on the right without moving or rewrapping the manuscript',async({page},info)=>{
 test.skip(info.project.name!=='desktop');await page.setViewportSize({width:1024,height:1000});await page.goto('/tests/browser/threads.html');await page.evaluate(async()=>{await (window as any).threadsFixture.ready;await document.fonts.ready;});
 const dock=page.locator('.conversation-rail-dock');await expect(dock).toBeHidden();
 // Reproduce a first measurement without room, then the final wide layout.
 // No explicit user choice was made, so initial automatic placement must adapt.
 await page.setViewportSize({width:2048,height:1000});await expect(dock).toBeVisible();await expect(page.locator('.navigation-drawer')).toBeVisible();await page.getByRole('button',{name:'Chapter 9',exact:true}).click();await expect(page.locator('.assembled-editor .cm-content')).toBeVisible();await expect(page.getByRole('region',{name:'Section threads'})).toContainText('Chapter 9');
 const before=await shape(page);const rectangle=await page.locator('.cm-content').boundingBox();const rail=await dock.boundingBox();expect(rectangle!.x+rectangle!.width).toBeLessThanOrEqual(rail!.x);
 await page.getByRole('button',{name:'Close chats',exact:true}).click();expect(await shape(page)).toEqual(before);await page.getByRole('button',{name:'Chats',exact:true}).click();expect(await shape(page)).toEqual(before);
 expect((await new AxeBuilder({page}).include('.conversation-rail').analyze()).violations).toEqual([]);await page.screenshot({path:'/tmp/heinlein-separated-rails-wide.png'});
});

for(const zoom of [100,200])for(const custom of [false,true])test(`one Review chapter action opens consolidated feedback and retains individual passes at ${zoom}%${custom?" with custom agents":""}`,async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto(`/tests/browser/threads.html?automaticReview${custom?'&customAgents':''}`);await expect(page).toHaveTitle('Section threads fixture');await expect(page).toHaveURL(/automaticReview/);
 await page.evaluate(async zoom=>{await (window as any).threadsFixture.ready;document.documentElement.dataset.zoom=String(zoom);await document.fonts.ready;},zoom);
 await showNav(page);await page.getByRole('button',{name:'Chapter 9',exact:true}).click();
 const before=await shape(page);const disk=await page.evaluate(()=>JSON.stringify((window as any).threadsFixture.source().disk));
 const action=page.locator('.assembled-toolbar').getByRole('button',{name:'Review chapter',exact:true});await expect(action).toBeVisible();
 await action.focus();await action.scrollIntoViewIfNeeded();expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
 await page.screenshot({path:`/tmp/heinlein-one-click-entry-${info.project.name}-${zoom}${custom?"-custom":""}.png`});
 await page.keyboard.press('Enter');
 await expect.poll(()=>page.evaluate(()=>(window as any).automaticChapterFixture.continuations.length)).toBe(1);
 await expect(page.locator('.heinlein-review-panel')).toBeHidden();
 await expect(page.getByRole('button',{name:'Chats',exact:true})).toHaveAttribute('aria-expanded','false');
 await expect(page.locator('.assembled-editor .cm-content')).toBeFocused();
 expect(await shape(page)).toEqual(before);
 await showChats(page);
 await page.getByRole('region',{name:'Section threads'}).getByRole('button',{name:/^Chapter 9 · Review/}).click();
 const panel=page.getByRole('region',{name:'Heinlein Review',exact:true});await expect(panel).toContainText('Combined chapter feedback from all reviewer passes.');
 await expect(panel.getByRole('heading',{name:'Consolidated review',exact:true})).toBeVisible();
 const assessment=panel.getByRole('combobox',{name:'Review assessment',exact:true});await expect(assessment.locator('option:checked')).toHaveText('Consolidated review · all reviewers');

 expect(await page.evaluate(()=>(window as any).automaticChapterFixture.requests.length)).toBe(1);expect(await page.evaluate(()=>(window as any).automaticChapterFixture.continuations.length)).toBe(1);
 expect(await page.evaluate(()=>(window as any).automaticChapterFixture.requests[0].workflow.reviewers)).toEqual(['mechanical','contextual',...(custom?Array.from({length:4},(_,i)=>`custom-${i}`):[])]);
 expect(await shape(page)).toEqual(before);expect(await page.evaluate(()=>JSON.stringify((window as any).threadsFixture.source().disk))).toBe(disk);
 expect((await new AxeBuilder({page}).include('.conversation-rail').analyze()).violations).toEqual([]);
 expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);await page.screenshot({path:`/tmp/heinlein-one-click-result-${info.project.name}-${zoom}${custom?"-custom":""}.png`});
 await assessment.selectOption('0');await expect(panel).toContainText('Individual mechanical pass keeps the intentional fragments.');
 if(custom){await assessment.selectOption('4');await expect(panel).toContainText('Custom agent 3 individual feedback.');}
 await assessment.selectOption({label:'Consolidated review · all reviewers'});await expect(panel).toContainText('Combined chapter feedback from all reviewer passes.');
 await page.reload();await page.evaluate(()=>(window as any).threadsFixture.ready);await showNav(page);await page.getByRole('button',{name:'Chapter 9',exact:true}).click();await showChats(page);
 await page.getByRole('region',{name:'Section threads'}).getByRole('button',{name:/^Chapter 9 · Review/}).click();
 await expect(panel).toContainText('Combined chapter feedback from all reviewer passes.');await expect(assessment.locator('option:checked')).toHaveText('Consolidated review · all reviewers');
 expect(await page.evaluate(()=>(window as any).automaticChapterFixture.requests.length)).toBe(0);expect(errors).toEqual([]);await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});
