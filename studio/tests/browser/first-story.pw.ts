import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function stage(page: import('@playwright/test').Page, n: number) {const chooser=page.locator('.guide-stage-list');if(!await chooser.evaluate(el=>(el as HTMLDetailsElement).open))await chooser.locator('summary').click();await page.getByRole('navigation',{name:'Story guide stages'}).getByRole('button').nth(n-1).click();await expect(page.locator('.guide-current-step')).toBeFocused();}
test('first-story beginner entry, persistence, keyboard, coaching and accessible 200% reflow',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const remote:string[]=[];await page.route('**/*',route=>{if(new URL(route.request().url()).hostname!=='127.0.0.1'){remote.push(route.request().url());return route.abort();}return route.continue();});
  await page.goto('/tests/browser/first-story.html');
  await page.getByRole('button',{name:'First story',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Start with a place for your story'})).toBeVisible();
  await page.getByRole('button',{name:'Open a story folder…'}).click();
  await page.getByRole('button',{name:'Start my story guide'}).click();
  await page.getByLabel('Who is this story about?',{exact:true}).fill('A courier');
  await page.getByRole('button',{name:'Save guide progress',exact:true}).click();
  await page.getByLabel('Who is this story about?',{exact:true}).fill('A courier with a letter');
  await page.getByRole('button',{name:'Save guide progress',exact:true}).click();
  await page.getByLabel('Who is this story about?',{exact:true}).fill('A courier before dawn');
  await page.getByRole('button',{name:'Close guide',exact:true}).click();
  await page.getByRole('button',{name:'First story',exact:true}).click();
  await expect(page.getByLabel('Who is this story about?',{exact:true})).toHaveValue('A courier before dawn');
  await page.getByRole('button',{name:'Save idea and continue'}).click();
  await expect(page.getByText('Discovery writing means',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Skip this stage…'}).click();
  await page.getByRole('button',{name:'Keep this stage',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'Skip this stage?'})).toHaveCount(0);
  await page.getByRole('button',{name:'Close guide',exact:true}).click();
  await expect(page.getByRole('button',{name:'First story',exact:true})).toBeFocused();
  await page.reload();await page.getByRole('button',{name:'First story',exact:true}).click();await page.getByRole('button',{name:'Open a story folder…'}).click();
  await stage(page,1);await expect(page.getByLabel('Who is this story about?',{exact:true})).toHaveValue('A courier before dawn');
  await stage(page,4);await page.getByText('Two different revision passes',{exact:true}).click();await expect(page.getByText('There is no style score to pass.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Close guide',exact:true}).click();
  for(let i=0;i<8 && await page.locator('.zoom-level').textContent()!=='200%';i++)await page.keyboard.press('Control+=');
  await expect(page.locator('.zoom-level')).toHaveText('200%');
  await page.getByRole('button',{name:'First story',exact:true}).click();
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
  const entry=page.getByRole('button',{name:'First story',exact:true});
  const overlap=await entry.evaluate(el=>{const b=el.getBoundingClientRect();const nav=document.querySelector('#navigation-panel-files')!.getBoundingClientRect();return b.left<nav.right&&b.right>nav.left&&b.top<nav.bottom&&b.bottom>nav.top;});
  expect(overlap).toBe(true);
  await entry.click();await expect(page.getByRole('dialog',{name:'Your first story'})).toBeVisible();
  await page.getByRole('button',{name:'Close guide',exact:true}).click();await expect(entry).toBeFocused();
});
test('proof goes stale after saved edits; preview cancel and synthetic native confirmation stay explicit',async({page})=>{
  await page.goto('/tests/browser/first-story.html?draft=1');await expect(page.locator('.cm-content')).toContainText('Synthetic scene');
  await page.getByRole('button',{name:'First story',exact:true}).click();await page.getByRole('button',{name:'Start my story guide'}).click();await stage(page,5);
  await page.getByRole('button',{name:'Mark this saved revision proofread'}).click();await stage(page,5);await expect(page.getByText('Proof applies to the saved revision.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Close guide',exact:true}).click();
  await page.locator('.cm-content').fill('Changed synthetic story.\n\nTHE END.');await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByRole('region',{name:'Document preview'}).getByText('Saved on this Mac',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'First story',exact:true}).click();await stage(page,5);await expect(page.getByText('No current proof recorded.',{exact:false})).toBeVisible();
  await stage(page,6);
  await page.getByLabel('Story title',{exact:true}).fill('Synthetic story');await page.getByLabel('Author name to print',{exact:true}).fill('Example Author');await page.getByLabel('Rights statement (your choice)',{exact:true}).fill('Example Author retains rights.');
  await page.getByLabel('I choose no cover for this text-only copy',{exact:true}).check();await page.getByLabel('I approve the existing FREE PLAY Publishing branding for this copy',{exact:true}).check();
  await page.getByRole('button',{name:'Preview publishing copy…'}).click();await expect(page.getByRole('heading',{name:'Publishing copy preview'})).toBeVisible();
  await page.getByRole('button',{name:'Cancel copy preview'}).click();await expect(page.getByRole('heading',{name:'Publishing copy preview'})).toHaveCount(0);
  await page.getByRole('button',{name:'Preview publishing copy…'}).click();page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'Create this new copy…'}).click();await expect(page.getByText('Creation canceled. No publishing files written.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Preview publishing copy…'}).click();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Create this new copy…'}).click();await expect(page.getByRole('heading',{name:'Build and inspect outside Studio'})).toBeVisible();
});
