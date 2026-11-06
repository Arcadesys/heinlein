import {test,expect,type Locator,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
/** Source files open from the project ⋯ menu (keyboard: Enter, arrows, Enter) unless the drawer already shows them. */
async function showSourceFiles(page:Page){await expect(page.locator('#navigation-drawer')).toHaveAttribute('aria-hidden','false');await expect(page.locator('.nav-view:not([hidden])').first()).toBeVisible();if(await page.locator('.files.nav-view').isVisible())return;const more=page.locator('summary[aria-label="Project actions"]');await expect(more).toBeVisible();await more.focus();await page.keyboard.press('Enter');const item=page.getByRole('group',{name:'Project actions'}).getByRole('button',{name:'Source files',exact:true});await expect(item).toBeVisible();for(let i=0;i<12&&!await item.evaluate(el=>el===document.activeElement);i++)await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await expect(page.locator('.files.nav-view')).toBeVisible();}
async function activate(page:Page,target:Locator){await expect(target).toBeVisible();for(let i=0;i<100;i++){if(await target.evaluate(el=>el===document.activeElement)){await page.keyboard.press('Enter');return;}await page.keyboard.press('Tab');}throw Error('Unreachable keyboard target');}
async function appearance(page:Page){const nav=page.getByRole('dialog',{name:'Navigation'});if(await nav.isVisible())await page.keyboard.press('Escape');await activate(page,page.getByRole('button',{name:'More actions'}));await activate(page,page.getByRole('button',{name:'Appearance',exact:false}));}
async function library(page:Page){if(await page.getByRole('dialog',{name:'Navigation'}).isVisible())await page.keyboard.press('Escape');await activate(page,page.locator('.project-switcher'));await expect(page.getByRole('dialog',{name:'Projects',exact:true})).toBeVisible();}
async function open(page:Page,name:string){await library(page);await activate(page,page.getByRole('button',{name:`Open ${name}`,exact:true}));await expect(page.locator('.project-library')).not.toBeVisible();}
async function scene(page:Page){const toggle=page.locator('.navigation-toggle');if(await toggle.count()&&await toggle.getAttribute('aria-expanded')!=='true')await activate(page,toggle);await showSourceFiles(page);await activate(page,page.getByRole('button',{name:'Open file scene.md',exact:true}));}
test('keyboard project journey preserves local and managed writing, resumes position and existing standalone identity',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/tests/browser/projects.html');
 const editor=page.locator('.cm-content');await expect(editor).toBeVisible();await editor.focus();await page.keyboard.insertText('Standalone original — é 🦊\n');await activate(page,page.getByRole('button',{name:'Keep on this Mac',exact:true}));
 await library(page);await expect(page.getByRole('dialog',{name:'Projects',exact:true})).toContainText('Novel C');await page.screenshot({path:info.outputPath('project-library.png'),fullPage:true});await activate(page,page.getByRole('button',{name:'Open Novel A',exact:true}));await scene(page);
 await editor.focus();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText('Local new writing — 🦊');await page.keyboard.press('ControlOrMeta+Home');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');
 await open(page,'Novel B');await scene(page);await expect(editor).toContainText('Novel B');await editor.focus();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText('Managed different writing — 🐺');await page.screenshot({path:info.outputPath('project-github.png'),fullPage:true});
 await open(page,'Novel A');await expect(editor).toContainText('Local new writing — 🦊');expect(await page.evaluate(()=>(window as any).projectFixture.projects.find((p:any)=>p.id==='local-a').resume.anchor)).toBe(2);await page.screenshot({path:info.outputPath('project-resumed-local.png'),fullPage:true});
 await library(page);await activate(page,page.getByRole('button',{name:'Find standalone drafts',exact:true}));await activate(page,page.locator('.draft-list-item button').filter({hasText:'Standalone original'}));await expect(editor).toHaveText('Standalone original — é 🦊');await expect(page.locator('.project-switcher')).toContainText('Standalone draft');await expect(page.locator('.repository-send')).toBeHidden();await page.screenshot({path:info.outputPath('project-returned-draft.png'),fullPage:true});
 expect(await page.evaluate(()=>(window as any).projectFixture.externalCalls)).toEqual([]);expect(await page.evaluate(()=>(window as any).projectFixture.documents['github-a']['scene.md'])).toContain('Managed different writing — 🐺');expect(errors).toEqual([]);
});
test('project library/settings have keyboard focus, large targets, contrast and 200 percent narrow reflow',async({page})=>{
 await page.goto('/tests/browser/projects.html?library');const dialog=page.locator('.project-library');await expect(dialog).toBeVisible();
 for(let i=0;i<8&&await page.locator('html').getAttribute('data-zoom')!=='200';i++)await page.keyboard.press('Control+=');
 await expect(page.locator('html')).toHaveAttribute('data-zoom','200');expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 for(const target of await dialog.locator('button').all()){const box=await target.boundingBox();expect(box?.height).toBeGreaterThanOrEqual(44);}
 await activate(page,page.getByRole('button',{name:'Manage Novel B',exact:true}));await expect(dialog).toContainText('example/novel-b');await expect(dialog).toContainText('Working branch: story/novel-b');await expect(page.getByRole('heading',{name:'Manage — Novel B'})).toBeFocused();
 expect((await new AxeBuilder({page}).include('.project-library').analyze()).violations).toEqual([]);await activate(page,page.getByRole('button',{name:'Back to writing',exact:true}));
 await appearance(page);await activate(page,page.getByRole('button',{name:'High contrast',exact:true}));await page.keyboard.press('Escape');await library(page);expect((await new AxeBuilder({page}).include('.project-library').analyze()).violations).toEqual([]);
});
test('focused and idle project identity and local save state stay legible in default and high contrast',async({page})=>{
 await page.goto('/tests/browser/projects.html');
 const contrast=(a:number[],b:number[])=>{const L=(c:number[])=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);return(Math.max(L(a),L(b))+.05)/(Math.min(L(a),L(b))+.05);};
 for(const high of [false,true]){
  if(high){await appearance(page);await activate(page,page.getByRole('button',{name:'High contrast',exact:true}));await page.keyboard.press('Escape');}
  const editor=page.locator('.cm-content');await editor.focus();await page.keyboard.insertText('Visible identity — ');
  for(const target of [page.locator('.project-switcher'),page.locator('.pill-save')]){
   const values=await target.evaluate(el=>{const rgb=(s:string)=>s.match(/[\d.]+/g)!.slice(0,3).map(Number);let opacity=1;for(let p:Element|null=el;p;p=p.parentElement)opacity*=Number(getComputedStyle(p).opacity);return{opacity,fg:rgb(getComputedStyle(el).color),bg:rgb(getComputedStyle(document.querySelector('.status-pill')!).backgroundColor)};});expect(values.opacity).toBe(1);expect(contrast(values.fg,values.bg)).toBeGreaterThanOrEqual(4.5);
  }
  await activate(page,page.getByRole('button',{name:'Keep on this Mac',exact:true}));await editor.focus();await expect(page.locator('.pill-save')).toHaveAttribute('aria-label','Kept on this Mac');expect(await page.locator('.status-pill').evaluate(el=>Number(getComputedStyle(el).opacity))).toBe(1);
  const header=await page.locator('.project-switcher').boundingBox(),writing=await editor.boundingBox();expect(header!.y).toBeLessThan(writing!.y);expect(header!.height).toBeGreaterThanOrEqual(44);
 }
});
for(const removed of [false,true])test(`clean external source ${removed?'deletion':'change'} does not trap keyboard project switching`,async({page})=>{
 await page.goto('/tests/browser/projects.html');await open(page,'Novel A');await scene(page);await expect(page.locator('.pill-save')).toHaveAttribute('aria-label','Saved on this Mac');
 await page.evaluate(removed=>{const f=(window as any).projectFixture;if(removed)delete f.documents['local-a']['scene.md'];else f.documents['local-a']['scene.md']='External — 🦊\r\nExact replacement.';},removed);
 await open(page,'Novel B');await expect(page.locator('.pill-project')).toHaveText('Novel B');expect(await page.evaluate(()=>(window as any).projectFixture.documents['local-a']['scene.md'])).toBe(removed?undefined:'External — 🦊\r\nExact replacement.');expect(await page.evaluate(()=>(window as any).projectFixture.externalCalls)).toEqual([]);
});

for(const high of [false,true])test(`recent project history stays explicit and readable (${high?'high contrast':'default'})`,async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('/tests/browser/projects.html?library');
 if(high){await activate(page,page.getByRole('button',{name:'Back to writing',exact:true}));await appearance(page);await activate(page,page.getByRole('button',{name:'High contrast',exact:true}));await page.keyboard.press('Escape');await library(page);}
 const zoom=page.viewportSize()!.width===320?'200':'100';
 for(let n=0;n<8&&await page.locator('html').getAttribute('data-zoom')!==zoom;n++)await page.keyboard.press(zoom==='200'?'Control+=':'Control+-');
 await expect(page.locator('html')).toHaveAttribute('data-zoom',zoom);await page.evaluate(()=>document.fonts.ready);
 const dialog=page.getByRole('dialog',{name:'Projects',exact:true}),heading=dialog.getByRole('heading',{name:'Recently opened',exact:true});
 await expect(heading).toBeVisible();await expect(dialog).toContainText('Projects opened here, newest first.');
 const native=await page.evaluate(()=>(window as any).projectFixture.projects.map((p:any)=>({id:p.id,name:p.name})));
 await expect(dialog.locator('.project-name')).toHaveText(native.map((p:any)=>p.name));
 expect(new Set(native.map((p:any)=>p.id)).size).toBe(native.length);
 await expect(dialog).toContainText('Local folder');await expect(dialog).toContainText('Heinlein-managed GitHub copy');
 const target=dialog.getByRole('button',{name:'Open Novel B',exact:true});
 for(let n=0;n<100&&!await target.evaluate(el=>el===document.activeElement);n++)await page.keyboard.press('Tab');
 await expect(target).toBeFocused();expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(48);
 expect(await target.evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),s=getComputedStyle(el);return(hit===el||el.contains(hit))&&s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>=2;})).toBe(true);
 expect(await heading.evaluate(el=>[...el.textContent!.matchAll(/\S+/g)].every(word=>{const r=document.createRange();r.setStart(el.firstChild!,word.index!);r.setEnd(el.firstChild!,word.index!+word[0].length);return r.getClientRects().length===1;}))).toBe(true);
 expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 expect((await new AxeBuilder({page}).include('.project-library').withTags(['wcag2a','wcag2aa']).analyze()).violations.filter(v=>v.impact==='serious'||v.impact==='critical')).toEqual([]);
 await heading.evaluate(el=>el.scrollIntoView({block:'start'}));await page.screenshot({path:info.outputPath(`recent-projects-${high?'high-contrast':'default'}-${zoom}.png`),fullPage:true});
 // The static host deliberately supplies native order; the renderer does not
 // fabricate a last-open time or reorder it when a project button is pressed.
 await target.focus();await page.keyboard.press('Enter');await expect(dialog).not.toBeVisible();await expect(page.locator('.pill-project')).toHaveText('Novel B');
 await library(page);await expect(dialog.locator('.project-name')).toHaveText(native.map((p:any)=>p.name));
 expect(await page.evaluate(()=>(window as any).projectFixture.requests.filter((r:any)=>r.action==='activate').length)).toBe(1);
 expect(await page.evaluate(()=>(window as any).projectFixture.externalCalls)).toEqual([]);expect(errors).toEqual([]);
});

test('new project is distinct from open-existing, cancel and errors retain writing, and successful create initializes one scene',async({page})=>{
 await page.goto('/tests/browser/projects.html');await open(page,'Novel A');await scene(page);
 const before=await page.evaluate(()=>(window as any).projectFixture.documents['local-a']['scene.md']);
 await library(page);await activate(page,page.getByRole('button',{name:'New project…',exact:true}));
 const dialog=page.getByRole('dialog',{name:'New project',exact:true});const name=dialog.getByRole('textbox',{name:'Project name',exact:true});
 await expect(name).toBeFocused();await name.fill('Novel A');await name.press('Enter');await expect(dialog).toContainText('already exists');await expect(page.locator('.pill-project')).toHaveText('Novel A');
 await name.fill('New story');await page.evaluate(()=>(window as any).projectFixture.setCancelCreate(true));await name.press('Enter');await expect(dialog).toContainText('creation canceled');await expect(name).toHaveValue('New story');await expect(name).toBeFocused();await expect(page.locator('.pill-project')).toHaveText('Novel A');
 expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);expect((await new AxeBuilder({page}).include('.project-library').analyze()).violations).toEqual([]);
 await page.evaluate(()=>(window as any).projectFixture.setCancelCreate(false));await name.press('Enter');await expect(dialog).not.toBeVisible();await expect(page.locator('.pill-project')).toHaveText('New story');
 expect(await page.evaluate(()=>(window as any).projectFixture.documents['local-a']['scene.md'])).toBe(before);
 const result=await page.evaluate(()=>{const f=(window as any).projectFixture,p=f.projects.find((p:any)=>p.name==='New story');return{documents:f.documents[p.id],scenes:f.manuscripts[p.id].scenes,external:f.externalCalls,created:f.projects.filter((p:any)=>p.name==='New story').length};});
 expect(result.documents).toEqual({'ms/first-scene.md':''});expect(result.scenes).toHaveLength(1);expect(result.created).toBe(1);expect(result.external).toEqual([]);
});
