import {test,expect,type Locator,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function activate(page:Page,target:Locator){await expect(target).toBeVisible();for(let i=0;i<100;i++){if(await target.evaluate(el=>el===document.activeElement)){await page.keyboard.press('Enter');return;}await page.keyboard.press('Tab');}throw Error('Unreachable keyboard target');}
async function library(page:Page){await activate(page,page.locator('.project-switcher'));await expect(page.getByRole('dialog',{name:'Projects',exact:true})).toBeVisible();}
async function open(page:Page,name:string){await library(page);await activate(page,page.getByRole('button',{name:`Open ${name}`,exact:true}));await expect(page.locator('.project-library')).not.toBeVisible();}
async function scene(page:Page){const toggle=page.locator('.navigation-toggle');if(await toggle.count()&&await toggle.getAttribute('aria-expanded')!=='true')await activate(page,toggle);await activate(page,page.locator('.navigation-tabs [role="tab"][tabindex="0"]'));await page.keyboard.press('End');await expect(page.getByRole('tab',{name:'Source files',exact:true})).toHaveAttribute('aria-selected','true');await activate(page,page.getByRole('button',{name:'Open file scene.md',exact:true}));}
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
 await page.getByRole('button',{name:'Appearance',exact:false}).click();await activate(page,page.getByRole('button',{name:'High contrast',exact:true}));await page.keyboard.press('Escape');await library(page);expect((await new AxeBuilder({page}).include('.project-library').analyze()).violations).toEqual([]);
});
test('focused and idle project identity and local save state stay legible in default and high contrast',async({page})=>{
 await page.goto('/tests/browser/projects.html');
 const contrast=(a:number[],b:number[])=>{const L=(c:number[])=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);return(Math.max(L(a),L(b))+.05)/(Math.min(L(a),L(b))+.05);};
 for(const high of [false,true]){
  if(high){await page.getByRole('button',{name:'Appearance',exact:false}).click();await activate(page,page.getByRole('button',{name:'High contrast',exact:true}));await page.keyboard.press('Escape');}
  const editor=page.locator('.cm-content');await editor.focus();await page.keyboard.insertText('Visible identity — ');
  for(const target of [page.locator('.project-switcher'),page.locator('.pill-save')]){
   const values=await target.evaluate(el=>{const rgb=(s:string)=>s.match(/[\d.]+/g)!.slice(0,3).map(Number);let opacity=1;for(let p:Element|null=el;p;p=p.parentElement)opacity*=Number(getComputedStyle(p).opacity);return{opacity,fg:rgb(getComputedStyle(el).color),bg:rgb(getComputedStyle(document.querySelector('.status-pill')!).backgroundColor)};});expect(values.opacity).toBe(1);expect(contrast(values.fg,values.bg)).toBeGreaterThanOrEqual(4.5);
  }
  await activate(page,page.getByRole('button',{name:'Keep on this Mac',exact:true}));await editor.focus();await expect(page.locator('.pill-save')).toContainText('Kept on this Mac');expect(await page.locator('.status-pill').evaluate(el=>Number(getComputedStyle(el).opacity))).toBe(1);
  const header=await page.locator('.project-switcher').boundingBox(),writing=await editor.boundingBox();expect(header!.y).toBeLessThan(writing!.y);expect(header!.height).toBeGreaterThanOrEqual(44);
 }
});
for(const removed of [false,true])test(`clean external source ${removed?'deletion':'change'} does not trap keyboard project switching`,async({page})=>{
 await page.goto('/tests/browser/projects.html');await open(page,'Novel A');await scene(page);await expect(page.locator('.pill-save')).toContainText('Saved on this Mac');
 await page.evaluate(removed=>{const f=(window as any).projectFixture;if(removed)delete f.documents['local-a']['scene.md'];else f.documents['local-a']['scene.md']='External — 🦊\r\nExact replacement.';},removed);
 await open(page,'Novel B');await expect(page.locator('.pill-project')).toHaveText('Novel B');expect(await page.evaluate(()=>(window as any).projectFixture.documents['local-a']['scene.md'])).toBe(removed?undefined:'External — 🦊\r\nExact replacement.');expect(await page.evaluate(()=>(window as any).projectFixture.externalCalls)).toEqual([]);
});
