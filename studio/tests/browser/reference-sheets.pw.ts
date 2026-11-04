import {test, expect, type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function navigation(page: Page) {
  const toggle=page.getByRole('button',{name:'Navigation',exact:true});
  if(await toggle.isVisible()) await toggle.click();
  await expect(page.locator('#navigation-drawer')).toHaveAttribute('aria-hidden','false');
}
async function action(page: Page, title: string, label: string) {
  const summary=page.locator(`summary[aria-label="Actions for ${title}"]`);
  await summary.click();
  await page.locator(`.row-menu-items[aria-label="Actions for ${title}"]`).getByRole('button',{name:label,exact:true}).click();
}
test('reference classification keeps unsaved source and text geometry, with accessible labels',async({page},info)=>{
  const errors:string[]=[]; page.on('pageerror', error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto('/tests/browser/library-app.html?references');
  await expect(page).toHaveTitle('Library application fixture');
  await expect(page).toHaveURL(/library-app\.html\?references$/);
  await navigation(page);
  await expect(page.getByRole('button',{name:'Outstanding outline Reference',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'First sheet',exact:true}).click();
  const content=page.locator('.cm-content'); await content.click(); await page.keyboard.press('End');
  await page.keyboard.insertText(' Unsaved author text — exact.');
  await navigation(page);
  const before=await content.evaluate(node=>({text:node.textContent,width:node.getBoundingClientRect().width,font:getComputedStyle(node).fontSize}));
  await action(page,'First sheet','Make reference sheet');
  await expect(page.getByRole('button',{name:'First sheet Reference',exact:true})).toBeFocused();
  expect(await content.evaluate(node=>({text:node.textContent,width:node.getBoundingClientRect().width,font:getComputedStyle(node).fontSize}))).toEqual(before);
  await action(page,'First sheet','Make regular sheet');
  await expect(page.getByRole('button',{name:'First sheet',exact:true})).toBeFocused();
  expect(await content.textContent()).toBe(before.text);
  await page.evaluate(()=>{document.documentElement.style.fontSize='200%';document.documentElement.dataset.theme='contrast';});
  const outline=page.getByRole('button',{name:'Outstanding outline Reference',exact:true});
  await outline.focus(); await expect(outline).toBeFocused();
  expect(await outline.evaluate(node=>getComputedStyle(node).outlineStyle)).not.toBe('none');
  const badge=outline.locator('.reference-sheet-badge');
  const readability=await badge.evaluate(node=>{
    const range=document.createRange();range.selectNodeContents(node);
    const text=range.getBoundingClientRect(),button=node.closest('button')!.getBoundingClientRect();
    return {lines:range.getClientRects().length,left:text.left>=button.left,right:text.right<=button.right};
  });
  expect(readability).toEqual({lines:1,left:true,right:true});
  expect((await new AxeBuilder({page}).include('.drafting-panel').analyze()).violations).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.screenshot({path:info.outputPath('reference-sheets-200.png')});
  expect(errors).toEqual([]);
});
test('discovered reference can become a regular sheet and then a reference again',async({page})=>{
  await page.goto('/tests/browser/library-app.html?references'); await navigation(page);
  await action(page,'Outstanding outline','Make regular sheet');
  await expect(page.getByRole('button',{name:'Outstanding outline',exact:true})).toBeFocused();
  await action(page,'Outstanding outline','Make reference sheet');
  await expect(page.getByRole('button',{name:'Outstanding outline Reference',exact:true})).toBeFocused();
});
