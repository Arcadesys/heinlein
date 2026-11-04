import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for(const zoom of [100,150,200])test(`review rail gives feedback a continuous readable surface at ${zoom}%`,async({page},info)=>{
  if(info.project.name==='desktop')await page.setViewportSize({width:2048,height:1152});
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto('/tests/browser/threads.html?automaticReview');
  await expect(page).toHaveTitle('Section threads fixture');
  await page.evaluate(async zoom=>{await (window as any).threadsFixture.ready;document.documentElement.dataset.zoom=String(zoom);await document.fonts.ready;},zoom);
  if(await page.locator('.conversation-rail-dialog[open]').count())await page.getByRole('button',{name:'Close chats',exact:true}).click();
  const nav=page.locator('.navigation-toggle');
  if(await nav.getAttribute('aria-expanded')==='false')await nav.click();
  await page.getByRole('button',{name:'Chapter 9',exact:true}).click();
  const shape=()=>page.locator('.assembled-editor .cm-content').evaluate(node=>({width:node.getBoundingClientRect().width,lines:[...node.children].map(line=>line.getBoundingClientRect().height)}));
  const before=await shape();
  const review=page.getByRole('button',{name:'Review chapter',exact:true});
  await review.focus();await page.keyboard.press('Enter');
  const panel=page.locator('.heinlein-review-panel');
  await expect(panel).toContainText('Combined chapter feedback from all reviewer passes.');
  await expect(page.getByRole('button',{name:'Chats',exact:true})).toHaveAttribute('aria-expanded','false');
  await page.getByRole('button',{name:'Chats',exact:true}).click();
  await page.getByRole('region',{name:'Section threads'}).getByRole('button',{name:/^Chapter 9 · Review/}).click();
  await expect(panel.locator('.review-reading-feedback')).toBeVisible();
  const rail=page.locator('.conversation-rail');
  const viewport=page.viewportSize()!;
  const readableWidth=await page.evaluate(()=>36*parseFloat(getComputedStyle(document.documentElement).fontSize)-2);
  expect((await rail.boundingBox())!.width).toBeGreaterThanOrEqual(Math.min(viewport.width-2,readableWidth));
  if(info.project.name==='desktop')expect(await page.locator('.conversation-rail-body').evaluate(node=>node.clientHeight)).toBeGreaterThan(viewport.height*.7);
  expect(await panel.locator('.review-body').evaluate(node=>getComputedStyle(node).overflowY)).toBe('visible');
  expect(await rail.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  expect(await shape()).toEqual(before);
  await expect(panel.getByRole('combobox',{name:'Review assessment'})).toBeVisible();
  await panel.getByRole('combobox',{name:'Review assessment'}).selectOption('0');
  await expect(panel).toContainText('Individual mechanical pass keeps the intentional fragments.');
  // Model a long assessment, then prove the content scrolls past the controls
  // using the outer reading surface rather than a nested tiny review box.
  await panel.locator('.review-reading-feedback').evaluate(node=>{
    for(let i=0;i<12;i++){const paragraph=document.createElement('p');paragraph.textContent='Synthetic assessment paragraph: the setting and character motivation remain clear throughout this passage.';node.append(paragraph);}
    const end=document.createElement('button');end.textContent='End of synthetic assessment';node.append(end);
  });
  const end=panel.getByRole('button',{name:'End of synthetic assessment'});
  await end.focus();await expect(end).toBeInViewport();
  expect(await page.locator('.conversation-rail-body').evaluate(node=>node.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole('button',{name:'Close chats',exact:true})).toBeInViewport();
  expect((await new AxeBuilder({page}).include('.conversation-rail').analyze()).violations).toEqual([]);
  await panel.getByRole('combobox',{name:'Review assessment'}).scrollIntoViewIfNeeded();
  await page.screenshot({path:`/tmp/heinlein-readable-review-${info.project.name}-${zoom}.png`});
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  expect(await shape()).toEqual(before);
  expect((await page.evaluate(()=>(window as any).threadsFixture.source())).saves).toBe(0);
  expect(errors).toEqual([]);await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});
