import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function openGuide(page: import('@playwright/test').Page) { if(await page.getByRole('dialog',{name:'Navigation',exact:true}).isVisible()) await page.keyboard.press('Escape'); const button=page.getByRole('button',{name:'First story',exact:true}); if(!await button.isVisible()) await page.getByRole('button',{name:'More actions'}).click(); await button.click(); }
async function stage(page: import('@playwright/test').Page, n: number) {const chooser=page.locator('.guide-stage-list');if(!await chooser.evaluate(el=>(el as HTMLDetailsElement).open))await chooser.locator('summary').click();await page.getByRole('navigation',{name:'Story guide stages'}).getByRole('button').nth(n-1).click();await expect(page.locator('.guide-current-step')).toBeFocused();}
test('first-story beginner entry, persistence, keyboard, coaching and accessible 200% reflow',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const remote:string[]=[];await page.route('**/*',route=>{if(new URL(route.request().url()).hostname!=='127.0.0.1'){remote.push(route.request().url());return route.abort();}return route.continue();});
  await page.goto('/tests/browser/first-story.html');
  await openGuide(page);
  await expect(page.getByRole('heading',{name:'Start with a place for your story'})).toBeVisible();
  await page.getByRole('button',{name:'Open a story folder…'}).click();
  await page.getByRole('button',{name:'Start my story guide'}).click();
  await page.getByLabel('Who is this story about?',{exact:true}).fill('A courier');
  await page.getByRole('button',{name:'Save guide progress',exact:true}).click();
  await page.getByLabel('Who is this story about?',{exact:true}).fill('A courier with a letter');
  await page.getByRole('button',{name:'Save guide progress',exact:true}).click();
  await page.getByLabel('Who is this story about?',{exact:true}).fill('A courier before dawn');
  await page.getByRole('button',{name:'Close guide',exact:true}).click();
  await openGuide(page);
  await expect(page.getByLabel('Who is this story about?',{exact:true})).toHaveValue('A courier before dawn');
  await page.getByRole('button',{name:'Save idea and continue'}).click();
  await expect(page.getByText('Discovery writing means',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Skip this stage…'}).click();
  await page.getByRole('button',{name:'Keep this stage',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'Skip this stage?'})).toHaveCount(0);
  await page.getByRole('button',{name:'Close guide',exact:true}).click();
  await expect(page.getByRole('button',{name:'More actions'})).toBeFocused();
  await page.reload();await openGuide(page);await page.getByRole('button',{name:'Open a story folder…'}).click();
  await stage(page,1);await expect(page.getByLabel('Who is this story about?',{exact:true})).toHaveValue('A courier before dawn');
  await stage(page,4);await page.getByText('Two different revision passes',{exact:true}).click();await expect(page.getByText('There is no style score to pass.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Close guide',exact:true}).click();
  for(let i=0;i<8 && await page.locator('.zoom-level').textContent()!=='200%';i++)await page.keyboard.press('Control+=');
  await expect(page.locator('.zoom-level')).toHaveText('200%');
  await openGuide(page);
  const dialog=page.getByRole('dialog',{name:'Your first story'});
  await expect(dialog).toBeVisible();
  // Regression: large text must lead to the chosen step, not six screens of nav.
  expect(await page.locator('.guide-stage-list').evaluate(el=>(el as HTMLDetailsElement).open)).toBe(false);
  await expect(page.locator('.guide-current-step')).toBeFocused();
  const reach=await dialog.evaluate(el=>{const bounds=el.getBoundingClientRect();const heading=el.querySelector('.guide-current-step')!.getBoundingClientRect();const prompt=el.querySelector('.guide-current-stage > p')!.getBoundingClientRect();return {headingTop:heading.top-bounds.top,promptTop:prompt.top-bounds.top,height:bounds.height};});
  expect(reach.headingTop).toBeGreaterThanOrEqual(0);expect(reach.headingTop).toBeLessThan(150);expect(reach.promptTop).toBeLessThan(reach.height/2);
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  expect(await dialog.evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(32);
  await page.getByLabel('I made a story/structure pass',{exact:true}).focus();await page.keyboard.press('Space');await expect(page.getByLabel('I made a story/structure pass',{exact:true})).toBeChecked();
  expect(await page.locator(':focus').evaluate(el=>getComputedStyle(el).outlineStyle)).not.toBe('none');
  const axe=await new AxeBuilder({page}).include('.first-story').analyze();expect(axe.violations).toEqual([]);
  expect(remote).toEqual([]);expect(errors).toEqual([]);
});
test('global guide action remains clickable over navigation with enlarged platform fonts',async({page})=>{
  await page.goto('/tests/browser/first-story.html?draft=1');
  // A 960px desktop window at 200% reliably overlaps the expanded drawer and
  // global action bar, including on hosts whose default monospace font is narrower.
  await page.setViewportSize({width:960,height:740});
  if(await page.locator('.navigation-toggle').getAttribute('aria-expanded')==='false')await page.getByRole('button',{name:'Navigation',exact:true}).click();
  for(let i=0;i<8 && await page.locator('.zoom-level').textContent()!=='200%';i++)await page.keyboard.press('Control+=');
  await expect(page.locator('.zoom-level')).toHaveText('200%');
  await expect(page.locator('.workspace')).toHaveClass(/navigation-open/);
  const entry=page.getByRole('button',{name:'More actions'});
  expect(await entry.evaluate(el=>{const b=el.getBoundingClientRect();return el.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2));})).toBe(true);
  await entry.click();await page.getByRole('button',{name:'First story',exact:true}).click();await expect(page.getByRole('dialog',{name:'Your first story'})).toBeVisible();
  await page.getByRole('button',{name:'Close guide',exact:true}).click();await expect(entry).toBeFocused();
});
test('navigation remains a left overlay drawer in standalone writing and stays keyboard accessible',async({page})=>{
  await page.goto('/tests/browser/first-story.html?draft=1');
  await expect(page.locator('.cm-content')).toContainText('Synthetic scene');
  // Recreate the standalone-writing layout used by local drafts without touching any persisted data.
  await page.locator('.studio').evaluate(el=>el.classList.add('standalone-writing'));
  if(await page.locator('.navigation-toggle').getAttribute('aria-expanded')==='false') await page.keyboard.press('ControlOrMeta+\\');
  const nav=page.locator('.navigator');const drawer=page.locator('#navigation-drawer');
  const navBox=await nav.boundingBox();expect(navBox).not.toBeNull();expect(navBox!.x).toBeLessThan(32);
  expect(navBox!.width).toBeLessThan(400);
  const editor=await page.locator('.preview').boundingBox();expect(editor).not.toBeNull();expect(editor!.x).toBeLessThan(navBox!.x+navBox!.width);
  await expect(drawer).toHaveAttribute('aria-hidden','false');expect(await drawer.evaluate(el=>(el as HTMLElement).inert)).toBe(false);
  expect(await new AxeBuilder({page}).include('.navigator').analyze()).toMatchObject({violations:[]});
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveAttribute('aria-hidden','true');expect(await drawer.evaluate(el=>(el as HTMLElement).inert)).toBe(true);
  await page.keyboard.press('ControlOrMeta+\\');
  await expect(drawer).toHaveAttribute('aria-hidden','false');expect(await drawer.evaluate(el=>(el as HTMLElement).inert)).toBe(false);
  expect(await page.locator('.studio').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
});
test('proof goes stale after saved edits; preview cancel and synthetic native confirmation stay explicit',async({page})=>{
  await page.goto('/tests/browser/first-story.html?draft=1');await expect(page.locator('.cm-content')).toContainText('Synthetic scene');
  await openGuide(page);await page.getByRole('button',{name:'Start my story guide'}).click();await stage(page,5);
  await page.getByRole('button',{name:'Mark this saved revision proofread'}).click();await stage(page,5);await expect(page.getByText('Proof applies to the saved revision.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Close guide',exact:true}).click();
  await page.locator('.cm-content').fill('Changed synthetic story.\n\nTHE END.');if(!await page.getByRole('button',{name:'Editing actions'}).isVisible())await page.getByRole('button',{name:'Document actions',exact:true}).click();await page.getByRole('button',{name:'Editing actions'}).click();await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByRole('status',{name:'Saved on this Mac'})).toBeVisible();
  await openGuide(page);await stage(page,5);await expect(page.getByText('No current proof recorded.',{exact:false})).toBeVisible();
  await stage(page,6);
  await page.getByLabel('Story title',{exact:true}).fill('Synthetic story');await page.getByLabel('Author name to print',{exact:true}).fill('Example Author');await page.getByLabel('Rights statement (your choice)',{exact:true}).fill('Example Author retains rights.');
  await page.getByLabel('I choose no cover for this text-only copy',{exact:true}).check();await page.getByLabel('I approve the existing FREE PLAY Publishing branding for this copy',{exact:true}).check();
  await page.getByRole('button',{name:'Preview publishing copy…'}).click();await expect(page.getByRole('heading',{name:'Publishing copy preview'})).toBeVisible();
  await page.getByRole('button',{name:'Cancel copy preview'}).click();await expect(page.getByRole('heading',{name:'Publishing copy preview'})).toHaveCount(0);
  await page.getByRole('button',{name:'Preview publishing copy…'}).click();page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'Create this new copy…'}).click();await expect(page.getByText('Creation canceled. No publishing files written.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Preview publishing copy…'}).click();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Create this new copy…'}).click();await expect(page.getByRole('heading',{name:'Build and inspect outside Studio'})).toBeVisible();
});
