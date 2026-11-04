import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const shape=(page:Page)=>page.locator('.cm-content').evaluate(node=>({width:node.getBoundingClientRect().width,lines:[...node.children].map(line=>({width:line.getBoundingClientRect().width,height:line.getBoundingClientRect().height}))}));
for(const zoom of [100,200]) {
 test(`structured Ask is readable and advisory at ${zoom}%`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto('/tests/browser/questions.html');await expect(page).toHaveTitle('Passage Questions fixture');await expect(page).toHaveURL(/questions\.html$/);
  await page.evaluate(async zoom=>{await (window as any).questionsFixture.ready;document.documentElement.dataset.zoom=String(zoom);await document.fonts.ready;(window as any).questionsFixture.select();},zoom);
  const before=await shape(page);await page.keyboard.press('Control+j');const pane=page.locator('.question-panel');
  await pane.getByRole('textbox',{name:'Your drafting question'}).fill('How does the rain read?');await pane.getByRole('button',{name:'Ask',exact:true}).click();
  await page.evaluate(()=>(window as any).questionsFixture.finishStructuredAnswer());
  const answer=pane.getByRole('region',{name:'Answer 1',exact:true});await expect(answer).toContainText('Evidence: Rain tapped the glass roof.');await expect(answer.getByRole('heading',{name:'Suggested edits · advice only'})).toBeVisible();
  await expect(answer.locator('.question-diff-chip')).toHaveCount(1);await expect(answer.locator('button')).toHaveCount(0);await answer.focus();await expect(answer).toBeFocused();
  expect(await shape(page)).toEqual(before);expect((await new AxeBuilder({page}).include('.question-panel').analyze()).violations).toEqual([]);
  expect(await pane.evaluate(n=>n.scrollWidth<=n.clientWidth)).toBe(true);await expect(page.locator('vite-error-overlay')).toHaveCount(0);expect(errors).toEqual([]);
  await page.screenshot({path:`/tmp/heinlein-structured-ask-${info.project.name}-${zoom}.png`});
  const state=await page.evaluate(()=>(window as any).questionsFixture.state());expect(state.source).toBe(state.original);expect(state.applied).toBe(0);
 });
 for(const count of [0,1,4]) test(`Review accepts ${count} grounded improvements at ${zoom}%`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto('/tests/browser/questions.html');await expect(page).toHaveTitle('Passage Questions fixture');
  await page.evaluate(async zoom=>{await (window as any).questionsFixture.ready;document.documentElement.dataset.zoom=String(zoom);await document.fonts.ready;},zoom);
  const before=await shape(page);await page.getByRole('button',{name:'Heinlein',exact:true}).click();await page.getByRole('button',{name:'Whole scene',exact:true}).click();
  const pane=page.locator('.heinlein-review-panel');await pane.getByRole('button',{name:'Run review',exact:true}).click();await page.evaluate(count=>(window as any).questionsFixture.finishGroundedReview(count),count);
  await page.locator('.review-background').getByRole('button',{name:/Open review/}).click();
  await expect(pane.getByRole('heading',{name:'Reading overview',exact:true})).toBeVisible();await expect(pane.getByRole('heading',{name:'Points for improvement',exact:true})).toBeVisible();
  await expect(pane).toContainText(count?'Evidence: Rain tapped the glass roof.':'No improvements suggested.');await expect(pane.locator('.review-improvement-jump')).toHaveCount(0);
  expect(await shape(page)).toEqual(before);expect((await new AxeBuilder({page}).include('.heinlein-review-panel').analyze()).violations).toEqual([]);expect(await pane.evaluate(n=>n.scrollWidth<=n.clientWidth)).toBe(true);expect(errors).toEqual([]);await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.screenshot({path:`/tmp/heinlein-structured-review-${info.project.name}-${zoom}-${count}.png`});const state=await page.evaluate(()=>(window as any).questionsFixture.state());expect(state.source).toBe(state.original);expect(state.applied).toBe(0);
 });
}

for(const zoom of [100,200]) test(`consolidated review keeps individual passes accessible at ${zoom}%`,async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto('/tests/browser/questions.html');await expect(page).toHaveTitle('Passage Questions fixture');await expect(page).toHaveURL(/questions\.html$/);
 await page.evaluate(async zoom=>{await (window as any).questionsFixture.ready;document.documentElement.dataset.zoom=String(zoom);await document.fonts.ready;},zoom);
 const before=await shape(page);await page.getByRole('button',{name:'Heinlein',exact:true}).click();await page.getByRole('button',{name:'Whole scene',exact:true}).click();
 const pane=page.locator('.heinlein-review-panel');await pane.getByRole('button',{name:'Run review',exact:true}).click();await page.evaluate(()=>(window as any).questionsFixture.finishConsolidatedReview());
 await page.locator('.review-background').getByRole('button',{name:/Open review/}).click();
 await expect(pane.getByRole('heading',{name:'Consolidated review',exact:true})).toBeVisible();
 await expect(pane).toContainText('The stopped clock and rain establish an unsettled station');await expect(pane).toContainText('This is an optional story choice');
 await expect(pane.getByRole('heading',{name:'Strengths',exact:true})).toBeVisible();await expect(pane.getByRole('heading',{name:'Points for improvement',exact:true})).toBeVisible();
 const picker=pane.getByRole('combobox',{name:'Review assessment'});await expect(picker).toHaveValue('2');await picker.focus();await expect(picker).toBeFocused();
 await picker.press('Tab');await expect(picker).not.toBeFocused();await page.keyboard.press('Shift+Tab');await expect(picker).toBeFocused();await picker.selectOption('1');await expect(picker).toHaveValue('1');await expect(pane).toContainText('The station atmosphere builds tension');
 await picker.selectOption('0');await expect(pane).toContainText('No mechanical errors found.');await picker.selectOption('2');await expect(pane.getByRole('heading',{name:'Consolidated review',exact:true})).toBeVisible();
 expect(await shape(page)).toEqual(before);expect((await new AxeBuilder({page}).include('.heinlein-review-panel').analyze()).violations).toEqual([]);
 expect(await pane.evaluate(n=>n.scrollWidth<=n.clientWidth)).toBe(true);expect(errors).toEqual([]);await expect(page.locator('vite-error-overlay')).toHaveCount(0);
 await page.screenshot({path:`/tmp/heinlein-consolidated-review-${info.project.name}-${zoom}.png`});const state=await page.evaluate(()=>(window as any).questionsFixture.state());expect(state.source).toBe(state.original);expect(state.applied).toBe(0);
});
