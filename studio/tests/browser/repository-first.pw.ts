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
 await activate(page.getByRole('button',{name:'Open file story.md',exact:true}));
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

for(const saved of [null,{open:true,active:'manuscript'},{open:false,active:'manuscript'}]){
 test(`manifest-free managed project lands on files with keyboard access and no setup (${JSON.stringify(saved)})`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.addInitScript(value=>{localStorage.removeItem('heinlein-studio-navigation-v1');if(value)localStorage.setItem('heinlein-studio-navigation-v1',JSON.stringify(value));},saved);
  const reach=async(target:Locator)=>{await expect(target).toBeVisible();for(let i=0;i<110;i++){if(await target.evaluate(el=>el===document.activeElement))return;await page.keyboard.press('Tab');}throw Error('Unreachable keyboard target');};
  const activate=async(target:Locator)=>{await reach(target);await page.keyboard.press('Enter');};
  await page.goto('/tests/browser/projects.html');
  await expect(page).toHaveTitle('Heinlein project-first — synthetic local preview');
  await activate(page.locator('.project-switcher'));await activate(page.getByRole('button',{name:'Open Novel B',exact:true}));
  const original=await page.evaluate(()=>structuredClone((window as any).projectFixture.documents));
  await expect(page.getByRole('tab',{name:'Source files',exact:true})).toHaveAttribute('aria-selected','true');
  const guide=page.locator('.source-file-guide');await expect(guide).toBeHidden();
  await activate(page.locator('.source-project-info > summary'));await expect(guide).toBeVisible();
  await activate(page.locator('.source-project-info > summary'));await expect(guide).toBeHidden();
  await expect(guide).toHaveText('Browse writing files to edit or review. No manuscript setup is required.');
  for(const high of [false,true]){
   if(high){await activate(page.getByRole('button',{name:'Appearance',exact:false}));await activate(page.getByRole('button',{name:'High contrast',exact:true}));await page.keyboard.press('Escape');}
   for(const zoom of ['100','200']){
    for(let n=0;n<8&&await page.locator('html').getAttribute('data-zoom')!==zoom;n++)await page.keyboard.press(zoom==='200'?'Control+=':'Control+-');
    await expect(page.locator('html')).toHaveAttribute('data-zoom',zoom);
    await page.evaluate(()=>document.fonts.ready);
    const labels=await page.locator('.navigation-tabs [role="tab"]').evaluateAll(tabs=>tabs.map(tab=>{
      const rect=tab.getBoundingClientRect(),text=tab.firstChild!;
      const words=[...tab.textContent!.matchAll(/\S+/g)].map(word=>{
        const range=document.createRange();range.setStart(text,word.index!);range.setEnd(text,word.index!+word[0].length);
        return range.getClientRects().length;
      });
      return {label:tab.textContent,x:rect.x,width:rect.width,top:rect.top,bottom:rect.bottom,words};
    }));
    expect(labels.map(tab=>tab.label)).toEqual(['Binder','In this scene','Source files']);
    expect(labels.flatMap(tab=>tab.words).every(lines=>lines===1)).toBe(true);
    const stacked=(page.viewportSize()!.width<=560);
    expect(await page.locator('.navigation-tabs').evaluate(el=>getComputedStyle(el).flexDirection)).toBe(stacked?'column':'row');
    if(stacked)for(let n=1;n<labels.length;n++){
      expect(Math.abs(labels[n].x-labels[0].x)).toBeLessThanOrEqual(1);
      expect(Math.abs(labels[n].width-labels[0].width)).toBeLessThanOrEqual(1);
      expect(labels[n].top).toBeGreaterThanOrEqual(labels[n-1].bottom);
    }
    const file=page.getByRole('button',{name:'Open file scene.md',exact:true});
    // Re-enter after zoom changes so this proves ordinary keyboard scrolling,
    // rather than relying on a browser to re-scroll an already focused control.
    if(await file.evaluate(el=>el===document.activeElement))await page.keyboard.press('Shift+Tab');
    await reach(file);
    expect((await file.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    expect(await file.evaluate(el=>{const s=getComputedStyle(el);return s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>=2;})).toBe(true);
    await expect.poll(()=>file.evaluate(el=>{
      const rect=el.getBoundingClientRect(),pane=el.closest('.files')!.getBoundingClientRect();
      const footer=document.querySelector('.corner-actions')!.getBoundingClientRect();
      const top=Math.max(0,pane.top),bottom=Math.min(innerHeight,pane.bottom,footer.top);
      const range=document.createRange();range.selectNodeContents(el);const text=range.getBoundingClientRect();
      const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
      return {wholeTargetVisible:rect.top>=top-1&&rect.bottom<=bottom+1,
        filenameVisible:text.width>0&&text.top>=top-1&&text.bottom<=bottom+1&&text.left>=0&&text.right<=innerWidth,
        targetReceivesHit:hit===el||el.contains(hit)};
    })).toEqual({wholeTargetVisible:true,filenameVisible:true,targetReceivesHit:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    expect(await page.locator('.navigation-drawer').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze();
    expect(axe.violations.filter(v=>v.impact==='serious'||v.impact==='critical')).toEqual([]);
    if(zoom==='200')await file.scrollIntoViewIfNeeded();
    if(zoom==='200')await page.screenshot({path:info.outputPath(`generic-${high?'high-contrast':'default'}-200.png`),fullPage:true});
   }
  }
  await activate(page.getByRole('button',{name:'Open file scene.md',exact:true}));
  await expect(page.locator('.page-meta > .badge')).toHaveText('Source file · Editable Markdown');
  await expect(page.locator('.pill-scene')).toHaveAttribute('aria-label','Source file: scene.md');
  await expect(page.locator('.page .eyebrow')).toHaveText('Source file');
  expect(await page.evaluate(()=>(window as any).projectFixture.documents)).toEqual(original);
  expect(await page.evaluate(()=>(window as any).projectFixture.externalCalls)).toEqual([]);
  expect(await page.evaluate(()=>(window as any).projectFixture.draftingCalls)).toEqual([]);
  expect(errors).toEqual([]);
 });
}
