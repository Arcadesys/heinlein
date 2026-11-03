import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for(const reading of [false,true])test(`relaunch restores ${reading?'Reading':'Source'} location with keyboard access`,async({page},info)=>{
  const errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto('/tests/browser/projects.html');
  await expect(page.locator('.standalone-editor')).toBeVisible();
  const bytes=await page.evaluate(()=>{
    const f=(window as any).projectFixture;
    f.documents['local-a']['scene.md']=Array.from({length:160},(_,i)=>`Paragraph ${i+1}. Exact writing — é 🦊, with enough words to wrap naturally.\n\n`).join('');
    return f.documents['local-a']['scene.md'];
  });
  await page.locator('.project-switcher').focus();await page.keyboard.press('Enter');
  await page.getByRole('button',{name:'Open Novel A',exact:true}).focus();await page.keyboard.press('Enter');
  const toggle=page.locator('.navigation-toggle');
  if(await toggle.getAttribute('aria-expanded')!=='true'){await toggle.focus();await page.keyboard.press('Enter');}
  await page.getByRole('button',{name:'Open file scene.md',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(page.locator('.markdown-editor .cm-content')).toContainText('Paragraph 1.');
  await page.locator('.markdown-editor .cm-content').focus();
  await page.keyboard.press('ControlOrMeta+Home');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));});
  const pane=page.locator('.active-document-pane');
  await pane.evaluate(el=>{el.scrollTop=900;});
  if(reading){
    await page.getByRole('button',{name:'Reading',exact:true}).focus();await page.keyboard.press('Enter');
    await pane.evaluate(el=>{el.scrollTop=1700;});
  }
  await expect.poll(()=>page.evaluate(()=>{
    const h=(window as any).projectFixture.projects[0].resume;
    return h?{anchor:h.anchor,scroll:Math.round(h.readingScrollTop??h.scrollTop)}:null;
  })).toEqual({anchor:2,scroll:reading?1700:900});
  await page.reload();
  await expect(page).toHaveTitle('Heinlein project-first — synthetic local preview');
  await expect(page.locator('.pill-project')).toHaveText('Novel A');
  await expect(page.getByRole('button',{name:reading?'Reading':'Source',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect.poll(()=>pane.evaluate(el=>Math.round(el.scrollTop))).toBe(reading?1700:900);
  await expect(page.locator(reading?'.active-document-pane .markdown-reader':'.markdown-editor .cm-content')).toBeFocused();
  expect(await page.evaluate(()=>(window as any).projectFixture.documents['local-a']['scene.md'])).toBe(bytes);
  expect(await page.evaluate(()=>(window as any).projectFixture.externalCalls)).toEqual([]);
  expect(await page.locator('vite-error-overlay').count()).toBe(0);
  expect((await new AxeBuilder({page}).include('.document-workspace').analyze()).violations).toEqual([]);
  expect(await page.locator('.studio').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath(`restored-${reading?'reading':'source'}.png`),fullPage:true});
  if(reading){
    await page.getByRole('button',{name:'Source',exact:true}).focus();await page.keyboard.press('Enter');
    await expect(page.locator('.markdown-editor .cm-content')).toBeFocused();
    await expect.poll(()=>page.evaluate(()=>(window as any).projectFixture.projects[0].resume?.anchor)).toBe(2);
  }
  expect(errors).toEqual([]);
});
