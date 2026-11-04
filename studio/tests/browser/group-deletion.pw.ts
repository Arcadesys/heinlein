import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function navigation(page:Page){const toggle=page.getByRole('button',{name:'Navigation',exact:true});if(await toggle.isVisible())await toggle.click();}
async function remove(page:Page,title='Draft group'){
 await navigation(page);await page.locator(`summary[aria-label="Actions for ${title}"]`).click();
 await page.locator(`.row-menu-items[aria-label="Actions for ${title}"]`).getByRole('button',{name:'Delete group…',exact:true}).click();
}
test('delete group preserves its contents, editor geometry and Undo with accessible large-text confirmation',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await page.goto('/tests/browser/group-deletion.html');await expect(page).toHaveTitle('Group deletion — synthetic fixture');await expect(page).toHaveURL(/group-deletion\.html$/);
 await page.waitForFunction(()=>document.documentElement.dataset.groupDeletionReady==='true');
 await remove(page);const dialog=page.getByRole('dialog',{name:'Delete group?',exact:true});
 await expect(dialog).toBeVisible();await expect(dialog).toContainText('Draft group');await expect(dialog).toContainText('No sheet files are deleted or moved');await expect(dialog.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'Draft group',exact:true})).toBeFocused();
 expect(await page.evaluate(()=>(window as any).groupDeletionFixture.groupCalls.apply)).toBe(0);
 await remove(page);await page.evaluate(()=>{(window as any).groupDeletionFixture.theme();if(innerWidth===320)document.documentElement.style.fontSize='200%';});
 for(const label of ['Cancel','Delete group']){
  const target=dialog.getByRole('button',{name:label,exact:true});await target.focus();await target.scrollIntoViewIfNeeded();
  const proof=await target.evaluate(node=>{
   const rect=node.getBoundingClientRect(),text=node.firstChild!;
   const words=[...(node.textContent??'').matchAll(/\S+/g)].map(word=>{const range=document.createRange();range.setStart(text,word.index!);range.setEnd(text,word.index!+word[0].length);return range.getClientRects().length;});
   return {height:rect.height,left:rect.left,right:rect.right,viewport:innerWidth,words,outline:getComputedStyle(node).outlineStyle,hit:node.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))};
  });
  expect(proof.height).toBeGreaterThanOrEqual(48);expect(proof.left).toBeGreaterThanOrEqual(0);expect(proof.right).toBeLessThanOrEqual(proof.viewport);expect(proof.words.every(count=>count===1)).toBe(true);expect(proof.hit).toBe(true);expect(proof.outline).not.toBe('none');
 }
 const axe=await new AxeBuilder({page}).include('dialog').analyze();expect(axe.violations.filter(v=>['serious','critical'].includes(v.impact??''))).toEqual([]);
 await page.screenshot({path:info.outputPath('delete-group-confirmation.png'),fullPage:true});
 const content=page.locator('.cm-content');const before=await content.evaluate(node=>({text:node.textContent,width:node.getBoundingClientRect().width,font:getComputedStyle(node).fontSize}));
 const files=await page.evaluate(()=>[...(window as any).groupDeletionFixture.files]);
 await dialog.getByRole('button',{name:'Delete group',exact:true}).click();await expect(page.getByRole('button',{name:'Draft group',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'First sheet',exact:true})).toBeFocused();await expect(page.getByRole('button',{name:'Nested group',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Second sheet',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Outline Reference',exact:true})).toBeVisible();
 expect(await content.evaluate(node=>({text:node.textContent,width:node.getBoundingClientRect().width,font:getComputedStyle(node).fontSize}))).toEqual(before);
 expect(await page.evaluate(()=>[...(window as any).groupDeletionFixture.files])).toEqual(files);
 const parent=await page.getByRole('button',{name:'Nested group',exact:true}).evaluate(node=>node.closest('li.tree-group')?.parentElement?.closest('li.tree-group')?.querySelector(':scope > .tree-row [data-group-id]')?.textContent);
 expect(parent).toBe('Parent group');
 await page.locator('details.project-menu summary').click();await page.locator('.row-menu-items[aria-label="Project actions"]').getByRole('button',{name:'Undo last change',exact:true}).click();
 const undo=page.getByRole('dialog',{name:'Review manuscript change',exact:true});await expect(undo).toBeVisible();await undo.getByRole('button',{name:'Apply change',exact:true}).click();
 await expect(page.getByRole('button',{name:'Draft group',exact:true})).toBeVisible();expect(await content.evaluate(node=>({text:node.textContent,width:node.getBoundingClientRect().width,font:getComputedStyle(node).fontSize}))).toEqual(before);expect(errors).toEqual([]);
});
