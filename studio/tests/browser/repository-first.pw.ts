import {test,expect,type Locator} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('repository-first open and offline reopen keep local saves separate from sending, keyboard and 200% reflow',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 async function activate(target:Locator){await expect(target).toBeVisible();for(let i=0;i<100;i++){if(await target.evaluate(el=>el===document.activeElement)){await page.keyboard.press('Enter');return;}await page.keyboard.press('Tab');}throw Error('Unreachable keyboard target');}
 await page.goto('/tests/browser/github.html?repo-first');
 if(await page.getByRole('button',{name:'Navigation',exact:true}).count())await activate(page.getByRole('button',{name:'Navigation',exact:true}));
 await activate(page.getByRole('tab',{name:'Source files',exact:true}));
 await expect(page.getByRole('button',{name:'Open from GitHub…',exact:true})).toBeVisible();
 await expect(page.getByRole('region',{name:'Recent GitHub repositories'})).toContainText('example/synthetic-story');
 await activate(page.getByRole('button',{name:'Open example/synthetic-story',exact:true}));
 await activate(page.getByRole('button',{name:'Read file story.md',exact:true}));
 if(await page.getByRole('button',{name:'Navigation',exact:true}).count())await activate(page.getByRole('button',{name:'Navigation',exact:true}));
 await activate(page.getByRole('tab',{name:'Source files',exact:true}));
 await expect(page.locator('.pill-project')).toHaveText('example/synthetic-story');
 await expect(page.locator('.repository-origin-status')).toContainText(/not yet sent|No Send is recorded|successful Send/);
 const editor=page.locator('.cm-content');await editor.focus();await page.keyboard.press('End');await page.keyboard.insertText(' Unsaved exact words.');
 await expect(page.locator('.repository-origin-status')).toContainText('not yet sent');
 await expect(page.locator('.pill-save')).toContainText('Saved on this Mac');
 await expect(page.locator('.repository-origin-status')).toContainText('Saved changes not yet sent');
 const calls=await page.evaluate(()=> (window as any).githubFixture.calls as {action:string}[]);
 expect(calls.some(c=>['connect','poll','confirmAccount','confirm','previewShare','previewVersion','previewPullAction','freshBranch'].includes(c.action))).toBe(false);
 await activate(page.getByRole('button',{name:'Open from GitHub…',exact:true}));
 const dialog=page.getByRole('dialog',{name:'GitHub projects',exact:true});await expect(dialog.getByRole('button',{name:'Preview example/synthetic-story…'})).toBeVisible();
 await activate(dialog.getByRole('button',{name:'Preview example/synthetic-story…'}));await activate(dialog.getByRole('button',{name:'Open repository…'}));
 await expect(dialog).not.toBeVisible();
 for(let i=0;i<8&&await page.locator('html').getAttribute('data-zoom')!=='200';i++)await page.keyboard.press('Control+=');
 await expect(page.locator('html')).toHaveAttribute('data-zoom','200');
 await expect(page.locator('.repository-home').getByRole('button',{name:'Open from GitHub…'})).toBeVisible();
 const b=page.getByRole('button',{name:'Open from GitHub…',exact:true});expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 expect((await new AxeBuilder({page}).include('.files').analyze()).violations).toEqual([]);expect(errors).toEqual([]);
});

test('long opening notices never cover the keyboard navigation hit target at 200%',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('heinlein-studio-navigation-v1',JSON.stringify({open:false,active:'files'})));
 await page.goto('/tests/browser/github.html?repo-first');
 for(let i=0;i<8&&await page.locator('html').getAttribute('data-zoom')!=='200';i++)await page.keyboard.press('Control+=');
 await expect(page.locator('html')).toHaveAttribute('data-zoom','200');
 const toggle=page.locator('.navigation-toggle');
 await expect.poll(()=>toggle.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);
 // Keyboard opening is authoritative; no forced pointer click through overlays.
 await toggle.focus();await page.keyboard.press('Enter');await expect(toggle).toHaveAttribute('aria-expanded','true');
 const open=page.getByRole('button',{name:'Open from GitHub…',exact:true});await open.focus();await expect(open).toBeFocused();
 const drawer=page.locator('.navigation-drawer');expect(await drawer.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 await expect(page.locator('.files')).toContainText('Recent GitHub repositories');
});

test('GitHub entry CTA has measured solid text contrast in default and high-contrast themes',async({page})=>{
 await page.goto('/tests/browser/github.html?repo-first');
 const ratio=(a:number[],b:number[])=>{const L=(c:number[])=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);return(Math.max(L(a),L(b))+.05)/(Math.min(L(a),L(b))+.05);};
 for(const high of [false,true]){
   if(high){await page.getByRole('button',{name:'Appearance',exact:false}).click();await page.getByRole('button',{name:'High contrast',exact:true}).click();await page.keyboard.press('Escape');}
   const cta=page.getByRole('button',{name:'Choose a GitHub repository…',exact:true});
   const colors=await cta.evaluate(el=>{const s=getComputedStyle(el);return{fg:s.color.match(/[\d.]+/g)!.slice(0,3).map(Number),bg:s.backgroundColor.match(/[\d.]+/g)!.slice(0,3).map(Number),image:s.backgroundImage};});
   expect(colors.image).toBe('none');expect(ratio(colors.fg,colors.bg)).toBeGreaterThanOrEqual(4.5);
 }
});
