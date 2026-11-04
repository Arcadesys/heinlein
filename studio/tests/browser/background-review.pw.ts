import {test, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
for (const zoom of [100,200]) for (const failure of [false,true]) {
 test(`${zoom}% background review ${failure?'reports failure honestly':'finishes without interrupting the next scene'}`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  if(info.project.name==='desktop'&&zoom===100&&!failure)await page.setViewportSize({width:1600,height:1000});
  await page.goto('/tests/browser/questions.html');await expect(page).toHaveTitle('Passage Questions fixture');await expect(page).toHaveURL(/questions\.html$/);
  await page.evaluate(async zoom=>{await (window as any).questionsFixture.ready;document.documentElement.dataset.zoom=String(zoom);await document.fonts.ready;},zoom);
  const shape=()=>page.locator('.cm-content').evaluate(n=>({width:n.getBoundingClientRect().width,lines:[...n.children].map(c=>({width:c.getBoundingClientRect().width,height:c.getBoundingClientRect().height}))}));
  const before=await shape();await page.emulateMedia({reducedMotion:'reduce'});
  await page.getByRole('button',{name:'Heinlein',exact:true}).click();await page.getByRole('button',{name:'Whole scene',exact:true}).click();
  const pane=page.locator('.heinlein-review-panel'), activity=page.locator('.review-background');
  await pane.getByRole('button',{name:'Run review',exact:true}).click();
  if(info.project.name==='desktop'&&zoom===100&&!failure)await page.mouse.click(30,160);
  else await pane.getByRole('button',{name:'Keep writing',exact:true}).click();
  await expect(pane).toBeHidden();await expect(activity.getByRole('button',{name:/Review in progress/})).toBeVisible();expect(await shape()).toEqual(before);
  await expect(page.locator('.workspace')).toHaveJSProperty('inert',false);
  expect(await activity.locator('svg').evaluate(n=>getComputedStyle(n).animationName)).toBe('none');
  await activity.getByRole('button',{name:/Review in progress/}).focus();await page.keyboard.press('Enter');await expect(pane).toBeVisible();await expect(activity).toBeHidden();
  await pane.getByRole('button',{name:'Keep writing',exact:true}).click();
  await page.evaluate(()=>(window as any).questionsFixture.showNextScene());await expect(page.locator('.cm-content')).toContainText('A fresh page waits for Mara.');
  await page.locator('.cm-content').focus();await page.keyboard.type('Still writing. ');
  const working=await page.locator('.cm-content').innerText();const nextShape=await shape();
  await page.evaluate(()=>(window as any).questionsFixture.reviewStep());
  await expect(activity.getByRole('progressbar')).toHaveAttribute('aria-valuenow','1');await expect(activity.getByRole('progressbar')).toHaveAttribute('aria-valuemax','2');
  expect((await new AxeBuilder({page}).include('.review-background').analyze()).violations).toEqual([]);
  await page.screenshot({path:`/tmp/heinlein-review-running-${info.project.name}-${zoom}.png`});
  await page.evaluate(failure=>(window as any).questionsFixture[failure?'finishReviewInvalid':'finishReview'](),failure);
  const toast=activity.getByRole('region',{name:'Review notification'});
  await expect(toast).toBeVisible();await expect(toast).toContainText(failure?'Review could not be completed.':'Review complete.');
  await expect(page.locator('.cm-content')).toBeFocused();expect(await page.locator('.cm-content').innerText()).toBe(working);expect(await shape()).toEqual(nextShape);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);expect((await new AxeBuilder({page}).include('.review-background').analyze()).violations).toEqual([]);
  expect(await activity.evaluate(n=>n.scrollWidth<=n.clientWidth)).toBe(true);
  if(!failure) await page.screenshot({path:`/tmp/heinlein-review-toast-${info.project.name}-${zoom}.png`});
  await toast.getByRole('button',{name:'Open review',exact:true}).focus();await page.keyboard.press('Enter');await expect(pane).toBeVisible();await expect(activity).toBeHidden();
  expect((await page.evaluate(()=>(window as any).questionsFixture.state())).canceled).toBe(0);expect(errors).toEqual([]);
 });
}
